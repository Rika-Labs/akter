import {
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
} from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import { Actor, Intent, User } from "../../index.ts"
import type { Request } from "../../handles/actors.ts"
import type { EffectPolicy } from "../../members/effect.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { layer as runtimeLayer } from "../../runtime/layer.ts"
import { TurnHooks } from "../../runtime/turn/hooks.ts"
import { claimIntents } from "../../runtime/turn/relay.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster, type RunnerServices } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"
import { CLAIM_LEASE, ExplainOutput, planNodes } from "./outbox.ts"

/** One executor attempt as the fake provider saw it; times are this process's clock. */
interface Attempt {
  readonly key: string
  readonly effectId: string
  readonly attempt: number
  readonly runner: number
  readonly startedAt: number
  endedAt: number | undefined
  interrupted: boolean
}

/** Shared by the relay actors and every relay case; each case resets it first. */
export interface RelayFixture {
  /** Receiver handler runs by intent payload; a rolled-back run counts too. */
  readonly taken: Map<string, number>
  /** Claims seen at the `afterClaim` fault point, by command id, on any cluster runner. */
  readonly claims: Map<string, number>
  readonly attempts: Array<Attempt>
  /** What the receiver does after counting a run. */
  onTake: (id: string) => Effect.Effect<void>
  /** What the provider does on one attempt; the default succeeds with the key. */
  provider: (attempt: Attempt) => Effect.Effect<string, ProviderDown>
  /** Behaviour at a fault point on every cluster runner, after its `ActorTest` faults. */
  hook: (point: string, request: Request) => Effect.Effect<void>
}

export const relayFixture = (): RelayFixture => ({
  taken: new Map(),
  claims: new Map(),
  attempts: [],
  onTake: () => Effect.void,
  provider: (attempt) => Effect.succeed(attempt.key),
  hook: () => Effect.void,
})

const reset = (fixture: RelayFixture) =>
  Effect.sync(() => {
    fixture.taken.clear()
    fixture.claims.clear()
    fixture.attempts.length = 0
    fixture.onTake = () => Effect.void
    fixture.provider = (attempt) => Effect.succeed(attempt.key)
    fixture.hook = () => Effect.void
  })

class ProviderDown extends Schema.TaggedError<ProviderDown>()("ProviderDown", {}) {}

const Take = Actor.command("Take", { input: Schema.String })

const RelayMailbox = Actor.make("RelayMailbox", {
  key: Schema.String,
  api: {},
  internal: { Take },
})

const Stage = Actor.command("Stage", {
  input: Schema.Struct({
    ids: Schema.Array(Schema.String),
    afterMs: Schema.optional(Schema.Int),
    atMs: Schema.optional(Schema.Int),
  }),
})

const Relayer = Actor.make("Relayer", { key: Schema.String, api: { Stage } })

class RelayCall extends Actor.effect<RelayCall>()("RelayCall", {
  input: { key: Schema.String },
  success: Schema.String,
}) {}

class RelayCallOnce extends Actor.effect<RelayCallOnce>()("RelayCallOnce", {
  input: { key: Schema.String },
  success: Schema.String,
}) {}

class RelayTimed extends Actor.effect<RelayTimed>()("RelayTimed", {
  input: { key: Schema.String },
  success: Schema.String,
}) {}

type EffectName = "RelayCall" | "RelayCallOnce" | "RelayTimed"

const Perform = Actor.command("Perform", {
  input: Schema.Struct({
    key: Schema.String,
    effect: Schema.Literals(["RelayCall", "RelayCallOnce", "RelayTimed"]),
  }),
})

const Called = Actor.command("Called", { input: Schema.String })

const CallFailed = Actor.command("CallFailed", { input: Actor.DeadLetter(RelayCall) })

const OnceFailed = Actor.command("OnceFailed", { input: Actor.DeadLetter(RelayCallOnce) })

const Letter = Schema.Struct({
  effectId: Schema.String,
  attempts: Schema.Int,
  ambiguous: Schema.Boolean,
})

const RelayCaller = Actor.make("RelayCaller", {
  key: Schema.String,
  state: Actor.state({
    called: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    letters: Schema.Array(Letter).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  effects: [RelayCall, RelayCallOnce, RelayTimed],
  api: { Perform },
  internal: { Called, CallFailed, OnceFailed },
  policy: {
    effects: {
      RelayCall: { retry: { times: 1 }, onSuccess: Called, onDeadLetter: CallFailed },
      RelayCallOnce: { retry: { times: 0 }, onSuccess: Called, onDeadLetter: OnceFailed },
      RelayTimed: {
        timeout: "100 millis",
        retry: { times: 3, backoff: { base: "10 millis", max: "40 millis" } },
      },
    },
  },
})

const MAILBOXES = 32

const mailboxOf = (id: string) => {
  let hash = 0

  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % MAILBOXES

  return `mailbox-${hash}`
}

const recordLetter = (letter: typeof Letter.Type) =>
  Effect.gen(function* () {
    const turn = yield* RelayCaller.Turn
    const { effectId, attempts, ambiguous } = letter
    yield* turn.state.set({ letters: [...turn.state.letters, { effectId, attempts, ambiguous }] })
  })

/** The relay actors' command layers, which every runner builds. */
export const relayLayer = (fixture: RelayFixture) =>
  Layer.mergeAll(
    RelayMailbox.toLayer(
      Effect.succeed({
        Take: (id: string) =>
          Effect.suspend(() => {
            fixture.taken.set(id, (fixture.taken.get(id) ?? 0) + 1)

            return fixture.onTake(id)
          }),
      }),
    ),
    Relayer.toLayer(
      Effect.succeed({
        Stage: Effect.fnUntraced(function* ({ ids, afterMs, atMs }) {
          for (const id of ids) {
            let intent = (yield* RelayMailbox.intents(mailboxOf(id))).Take(id)

            if (afterMs !== undefined) intent = intent.pipe(Intent.after(Duration.millis(afterMs)))

            if (atMs !== undefined) intent = intent.pipe(Intent.at(DateTime.makeUnsafe(atMs)))
            yield* intent
          }
        }),
      }),
    ),
    RelayCaller.toLayer(
      Effect.succeed({
        Perform: Effect.fnUntraced(function* ({ key, effect }) {
          const turn = yield* RelayCaller.Turn

          const performed = {
            RelayCall: () => RelayCall.make({ key }),
            RelayCallOnce: () => RelayCallOnce.make({ key }),
            RelayTimed: () => RelayTimed.make({ key }),
          }

          yield* turn.perform(performed[effect]())
        }),
        Called: Effect.fnUntraced(function* (value: string) {
          const turn = yield* RelayCaller.Turn
          yield* turn.state.set({ called: [...turn.state.called, value] })
        }),
        CallFailed: recordLetter,
        OnceFailed: recordLetter,
      }),
    ),
  )

/** The executors of `runner`; a case can leave a runner without them. */
const runnerEffects = (fixture: RelayFixture, runner: number) => {
  const execute = (key: string) =>
    Effect.gen(function* () {
      const exec = yield* RelayCaller.Executor

      const attempt: Attempt = {
        key,
        effectId: exec.effectId,
        attempt: exec.attempt,
        runner,
        startedAt: yield* Clock.currentTimeMillis,
        endedAt: undefined,
        interrupted: false,
      }

      fixture.attempts.push(attempt)

      return yield* Effect.suspend(() => fixture.provider(attempt)).pipe(
        Effect.onExit((exit) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            attempt.endedAt = now
            attempt.interrupted = Exit.hasInterrupts(exit)
          }),
        ),
      )
    })

  return RelayCaller.toEffectLayer(
    Effect.succeed({
      RelayCall: ({ key }) => execute(key),
      RelayCallOnce: ({ key }) => execute(key),
      RelayTimed: ({ key }) => execute(key),
    }),
  )
}

/** The executors of the conformance environment's single runtime. */
export const relayEffects = (fixture: RelayFixture) => runnerEffects(fixture, 0)

const EXPIRATION_SECONDS = 3

/** A poll far longer than any case, so only wakes after commit and `advance` claim rows. */
const NO_POLL = { poll: "1 hour" } as const

const SHORT_LEASE = { lease: "3 seconds" } as const

type RuntimeOptions = Parameters<typeof runtimeLayer>[0]

interface ClusterSettings {
  readonly relay?: RuntimeOptions["relay"]
  readonly executors?: RuntimeOptions["executors"]
  /** Runners built without the relay executors. */
  readonly withoutExecutors?: ReadonlyArray<number>
}

/** Builds a fresh database and `runners` runners on it for one case. */
const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: RelayFixture,
  runners: number,
  settings: ClusterSettings,
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: relayLayer(fixture),
          runnerActors: (runner) =>
            (settings.withoutExecutors ?? []).includes(runner)
              ? Layer.empty
              : (runnerEffects(fixture, runner) as Layer.Layer<never, never, RunnerServices>),
          as: User.make({ subject: "alice" }),
          relay: settings.relay,
          executors: settings.executors,
        }),
      ).pipe(
        Effect.provideService(TurnHooks, {
          at: (point, request) =>
            Effect.suspend(() => {
              if (point === "afterClaim")
                fixture.claims.set(
                  request.commandId,
                  (fixture.claims.get(request.commandId) ?? 0) + 1,
                )

              return fixture.hook(point, request)
            }),
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

const stage = (
  runner: number,
  ids: ReadonlyArray<string>,
  options: { readonly afterMs?: number } = {},
) =>
  on(
    runner,
    Effect.forEach(
      Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
        ids.slice(index * 50, (index + 1) * 50),
      ),
      (chunk) =>
        Relayer.get(`relayer-${runner}`).pipe(
          Effect.flatMap((relayer) => relayer.Stage({ ids: chunk, ...options })),
        ),
      { discard: true },
    ),
  ).pipe(Effect.orDie)

const perform = (runner: number, id: string, effect: EffectName = "RelayCall") =>
  on(
    runner,
    RelayCaller.get(id).pipe(Effect.flatMap((caller) => caller.Perform({ key: id, effect }))),
  ).pipe(Effect.orDie)

const refOf = (id: string) => on(0, RelayCaller.get(id).pipe(Effect.map((caller) => caller.ref)))

/** Runs a query on `runner`'s database pool. */
const query = <A>(
  runner: number,
  statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>,
) =>
  on(
    runner,
    Effect.gen(function* () {
      return yield* statement(yield* SqlClient.SqlClient)
    }),
  ).pipe(Effect.orDie)

const receipts = (runner: number, command: string) =>
  query(runner, (sql) =>
    sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_receipts
      WHERE command = ${command}`.pipe(Effect.map((rows) => rows[0]!.count)),
  )

interface OutboxRow {
  readonly kind: string
  readonly attempts: number
  readonly ambiguous: boolean
  readonly last_error: string | null
  readonly payload: string
  readonly due: string
  /** Database time, which is the outbox clock of a runner that never advanced. */
  readonly now: string
}

const outboxRows = (runner: number) =>
  query(
    runner,
    (sql) =>
      sql<OutboxRow>`SELECT kind, attempts, ambiguous, last_error, payload, due_at_ms::text AS due,
        floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now
      FROM actor_outbox ORDER BY intent_id`,
  )

const deadLetters = (runner: number) =>
  query(
    runner,
    (sql) =>
      sql<{ attempts: number; ambiguous: boolean }>`SELECT attempts, ambiguous
        FROM actor_dead_letters`,
  )

const callerState = (runner: number, id: string) =>
  on(
    runner,
    Effect.gen(function* () {
      const caller = yield* RelayCaller.get(id)
      const { state } = yield* (yield* ActorTest).inspect(caller.ref)

      return state as {
        readonly called?: ReadonlyArray<string>
        readonly letters?: ReadonlyArray<typeof Letter.Type>
      }
    }),
  )

/** Polls `check` until it holds, dying after `timeout`. */
const eventually = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = "20 seconds",
  what = "a condition",
) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

const advance = (runner: number, duration: Duration.Input) =>
  on(
    runner,
    ActorTest.use((test) => test.advance(duration)),
  )

const faults = <A>(runner: number, use: (test: ActorTest["Service"]) => Effect.Effect<A>) =>
  on(runner, ActorTest.use(use))

const takenOnce = (fixture: RelayFixture, ids: ReadonlyArray<string>) =>
  ids.every((id) => fixture.taken.get(id) === 1)

const percentile = (samples: ReadonlyArray<number>, p: number) => {
  const sorted = [...samples].sort((a, b) => a - b)

  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

/** The runner that owns `ref`'s shard, and another one. */
const ownerAndOther = (ref: ActorRef) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const owner = (yield* cluster.owner(ref))!

    return { owner, other: (owner + 1) % cluster.runners }
  })

/** Kills `runner` and waits until the survivors hold its shards. */
const kill = (runner: number) =>
  ActorCluster.use((cluster) => cluster.kill(runner).pipe(Effect.andThen(cluster.ready)))

/** Multi-runner cases: real Postgres only, each on a fresh database and cluster. */
export const relayClusterConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "claims each due row on exactly one runner",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        3,
        {},
        Effect.gen(function* () {
          const ids = Array.from({ length: 300 }, (_, index) => `claimed-${index}`)
          yield* stage(0, ids)
          yield* eventually(
            Effect.sync(() => takenOnce(fixture, ids)),
            "60 seconds",
            "every intent's delivery",
          )
          yield* eventually(
            outboxRows(1).pipe(Effect.map((rows) => rows.length === 0)),
            "10 seconds",
            "the outbox to empty",
          )

          // Every row was claimed once: no other runner took it within its lease.
          expect(fixture.claims.size).toBe(300)
          expect([...fixture.claims.values()].every((count) => count === 1)).toBe(true)
          expect(yield* receipts(2, "Take")).toBe(300)
        }),
      ),
  },
  {
    name: "redelivers a row after its claim lease when the claiming runner is killed",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        3,
        { relay: NO_POLL },
        Effect.gen(function* () {
          yield* stage(1, ["killed-before-delivery"], { afterMs: 60_000 })
          const pause = yield* faults(0, (test) => test.pauseNext("beforeDelivery"))
          yield* advance(0, "1 minute").pipe(Effect.forkChild)
          yield* pause.reached
          yield* kill(0)

          // The survivors reach the due time, but the dead runner's claim still holds the row.
          yield* advance(1, "1 minute")
          yield* advance(2, "1 minute")
          expect(fixture.taken.get("killed-before-delivery")).toBe(undefined)
          expect(yield* outboxRows(1)).toMatchObject([{ kind: "intent", attempts: 1 }])

          yield* advance(1, CLAIM_LEASE)
          expect(fixture.taken.get("killed-before-delivery")).toBe(1)
          expect(yield* receipts(1, "Take")).toBe(1)
          expect(yield* outboxRows(1)).toEqual([])
          // One intent id, claimed once per lease.
          expect([...fixture.claims.values()]).toEqual([2])
        }),
      ),
  },
  {
    name: "redelivers after a runner kill between receiver commit and row deletion with one receiver transition",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        3,
        { relay: NO_POLL },
        Effect.gen(function* () {
          yield* stage(1, ["killed-before-delete"], { afterMs: 60_000 })
          const pause = yield* faults(0, (test) => test.pauseNext("beforeOutboxDelete"))
          yield* advance(0, "1 minute").pipe(Effect.forkChild)
          yield* pause.reached
          expect(yield* receipts(1, "Take")).toBe(1)
          yield* kill(0)

          yield* advance(2, "1 minute")
          expect(yield* outboxRows(2)).toMatchObject([{ kind: "intent", attempts: 1 }])
          yield* advance(2, CLAIM_LEASE)

          // The redelivery replayed the receipt: one handler run, one receipt, and the row is gone.
          expect(fixture.taken.get("killed-before-delete")).toBe(1)
          expect(yield* receipts(2, "Take")).toBe(1)
          expect(yield* outboxRows(2)).toEqual([])
        }),
      ),
  },
  {
    name: "does not let rows that die unsettled delay newer due rows",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        {},
        Effect.gen(function* () {
          const dead = Array.from({ length: 300 }, (_, index) => `dead-${index}`)
          fixture.hook = (point, request) =>
            point === "beforeOutboxDelete" && request.payload.includes("dead-")
              ? Effect.die(new Error("Injected settle crash"))
              : Effect.void
          yield* stage(0, dead)
          yield* eventually(
            Effect.sync(() => takenOnce(fixture, dead)),
            "60 seconds",
            "every dead row's first delivery",
          )

          // Each dead row waits out its claim instead of sorting ahead of newer work.
          const rows = yield* outboxRows(1)
          expect(rows.length).toBe(300)
          expect(rows.every((row) => row.attempts === 1)).toBe(true)
          expect(rows.every((row) => Number(row.due) - Number(row.now) > 30_000)).toBe(true)

          const sent = yield* Clock.currentTimeMillis
          yield* stage(1, ["fresh"])
          yield* eventually(
            Effect.sync(() => fixture.taken.get("fresh") === 1),
            "5 seconds",
            "the fresh intent",
          )
          // Within one poll, jitter included.
          expect((yield* Clock.currentTimeMillis) - sent <= 1100).toBe(true)

          // A row that keeps dying backs off past the lease, capped at maxBackoff.
          yield* query(
            1,
            (sql) =>
              sql`UPDATE actor_outbox SET attempts = 9,
                due_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              WHERE payload LIKE '%"dead-0"%'`,
          )

          const deadZero = outboxRows(1).pipe(
            Effect.map((rows) => rows.find((row) => row.payload.includes('"dead-0"'))!),
          )

          // The redelivery replays the receipt and its settle dies again.
          yield* eventually(
            deadZero.pipe(Effect.map((row) => row.attempts === 10)),
            "5 seconds",
            "the backed-off row's next claim",
          )
          const capped = yield* deadZero
          const wait = Number(capped.due) - Number(capped.now)
          expect(capped.attempts).toBe(10)
          expect(wait > 250_000 && wait <= 256_000).toBe(true)
        }),
      ),
  },
  {
    name: "keeps a stale runner's settle from changing a row another runner claimed",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL },
        Effect.gen(function* () {
          yield* stage(1, ["stale"], { afterMs: 60_000 })
          const pause = yield* faults(0, (test) => test.pauseNext("afterClaim"))
          const stale = yield* advance(0, "1 minute").pipe(Effect.forkChild)
          yield* pause.reached

          // Runner 1 claims after the lease; its delivery defects, so it reschedules the row.
          let defects = 1
          fixture.onTake = () =>
            defects-- > 0 ? Effect.die(new Error("Receiver defect")) : Effect.void
          yield* advance(1, "1 minute")
          yield* advance(1, CLAIM_LEASE)
          const [rescheduled] = yield* outboxRows(1)
          expect(rescheduled).toMatchObject({ kind: "intent", attempts: 2 })

          // Runner 0 wakes, delivers, and settles a claim it no longer holds.
          yield* pause.release
          yield* Fiber.join(stale)
          expect(yield* receipts(1, "Take")).toBe(1)
          const [after] = yield* outboxRows(1)
          expect({ attempts: after!.attempts, due: after!.due }).toEqual({
            attempts: rescheduled!.attempts,
            due: rescheduled!.due,
          })

          // Runner 1's next claim replays the receipt and deletes the row.
          yield* advance(1, "2 seconds")
          expect(yield* outboxRows(1)).toEqual([])
          expect(yield* receipts(1, "Take")).toBe(1)
        }),
      ),
  },
  {
    name: "delivers intents while every executor slot runs a slow effect",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { executors: { concurrency: 4 } },
        Effect.gen(function* () {
          let next = 0

          const deliver = Effect.gen(function* () {
            const id = `timed-${next++}`
            const started = yield* Clock.currentTimeMillis
            yield* stage(0, [id])
            yield* eventually(
              Effect.sync(() => fixture.taken.get(id) === 1),
              "10 seconds",
              `delivery of ${id}`,
            )

            return (yield* Clock.currentTimeMillis) - started
          })

          const baseline = yield* Effect.replicateEffect(deliver, 30)
          const running = () => fixture.attempts.filter((a) => a.endedAt === undefined).length

          // Each blocks for 10 s unless released; twice the slots keeps every executor busy.
          const gate = yield* Deferred.make<void>()
          fixture.provider = (attempt) =>
            Deferred.await(gate).pipe(
              Effect.timeout("10 seconds"),
              Effect.ignore,
              Effect.as(attempt.key),
            )
          yield* Effect.forEach(
            Array.from({ length: 16 }, (_, index) => index),
            (index) => perform(index % 2, `slow-${index}`),
            { concurrency: 4, discard: true },
          )
          yield* eventually(
            Effect.sync(() => running() === 8),
            "10 seconds",
            "every slot to be busy",
          )

          const blocked = yield* Effect.replicateEffect(deliver, 30)
          expect(running()).toBe(8)
          yield* Deferred.succeed(gate, undefined)

          expect(percentile(blocked, 0.99) <= percentile(baseline, 0.99) + 1000).toBe(true)
        }),
      ),
  },
  {
    name: "renews an executor lease so a long attempt is not taken over",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { executors: SHORT_LEASE },
        Effect.gen(function* () {
          // Three leases long, with both runners polling for due effects the whole time.
          fixture.provider = (attempt) => Effect.sleep("9 seconds").pipe(Effect.as(attempt.key))
          yield* perform(0, "long")
          yield* eventually(
            callerState(1, "long").pipe(Effect.map((state) => (state.called ?? []).length === 1)),
            "30 seconds",
            "the long attempt's route",
          )

          expect(
            fixture.attempts.map(({ attempt, interrupted }) => [attempt, interrupted]),
          ).toEqual([[1, false]])
          expect(yield* receipts(1, "Called")).toBe(1)
        }),
      ),
  },
  {
    name: "interrupts an attempt that loses its lease and routes at most one result",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const { owner, other } = yield* ownerAndOther(yield* refOf("lost"))
          fixture.provider = (attempt) =>
            attempt.attempt === 1 ? Effect.never : Effect.succeed(attempt.key)

          // The owner's commit wakes its own relay, which claims attempt 1; its renewal blocks.
          const renewal = yield* faults(owner, (test) => test.pauseNext("beforeRenew"))
          yield* perform(owner, "lost")
          yield* renewal.reached

          const takeover = yield* faults(other, (test) => test.pauseNext("beforeExecute"))
          const draining = yield* advance(other, "4 seconds").pipe(Effect.forkChild)
          yield* takeover.reached
          expect(yield* outboxRows(other)).toMatchObject([
            { kind: "effect", attempts: 2, ambiguous: true },
          ])
          yield* takeover.release
          yield* Fiber.join(draining)
          yield* renewal.release

          yield* eventually(
            Effect.sync(() => fixture.attempts[0]?.interrupted === true),
            "10 seconds",
            "attempt 1's interruption",
          )

          // Interrupted by the lost renewal, well before its own one-lease deadline.
          const [lost] = fixture.attempts
          expect(lost!.endedAt! - lost!.startedAt < 2900).toBe(true)
          expect(fixture.attempts.map(({ attempt, runner }) => [attempt, runner])).toEqual([
            [1, owner],
            [2, other],
          ])
          expect(yield* receipts(other, "Called")).toBe(1)
          expect((yield* callerState(other, "lost")).called).toEqual(["lost"])
        }),
      ),
  },
  {
    name: "dead-letters as ambiguous when the last attempt's lease expires",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const { owner, other } = yield* ownerAndOther(yield* refOf("mid-call"))
          fixture.provider = () => Effect.never
          yield* perform(owner, "mid-call", "RelayCallOnce")
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          yield* kill(owner)

          yield* advance(other, "4 seconds")
          expect((yield* callerState(other, "mid-call")).letters).toMatchObject([
            { attempts: 1, ambiguous: true },
          ])
          expect(yield* deadLetters(other)).toEqual([{ attempts: 1, ambiguous: true }])
          expect(yield* receipts(other, "OnceFailed")).toBe(1)
          expect(fixture.attempts.length).toBe(1)
        }),
      ),
  },
  {
    name: "claims effects only on runners that have their executor",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { withoutExecutors: [0] },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          let index = 0

          // An actor runner 0 owns, so its commit wakes the runner without the executor.
          let effectClaims = 0
          fixture.hook = (point, request) =>
            Effect.sync(() => {
              if (point === "afterClaim" && request.command === "RelayCall") effectClaims++
            })

          while ((yield* cluster.owner(yield* refOf(`elsewhere-${index}`))) !== 0) index++
          const id = `elsewhere-${index}`
          yield* perform(0, id)
          yield* eventually(
            callerState(1, id).pipe(Effect.map((state) => (state.called ?? []).length === 1)),
            "20 seconds",
            "the route",
          )

          expect(fixture.attempts.map(({ attempt, runner }) => [attempt, runner])).toEqual([[1, 1]])
          // One claim of the effect in all: runner 0 never claimed and released it.
          expect(effectClaims).toBe(1)
          expect(yield* receipts(0, "Called")).toBe(1)
        }),
      ),
  },
  {
    name: "uses per-effect timeout and backoff from policy.effects",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        1,
        { relay: NO_POLL },
        Effect.gen(function* () {
          fixture.provider = (attempt) => Effect.sleep("1 second").pipe(Effect.as(attempt.key))

          // Records each failure's wait at the moment its write lands; claims are skipped.
          yield* query(0, (sql) =>
            Effect.gen(function* () {
              yield* sql`CREATE TABLE relay_waits (attempts int, wait bigint)`
              yield* sql`CREATE FUNCTION relay_record_wait() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                  INSERT INTO relay_waits VALUES (NEW.attempts,
                    NEW.due_at_ms - floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint);
                  RETURN NEW;
                END $$`
              yield* sql`CREATE TRIGGER relay_record_wait AFTER UPDATE ON actor_outbox FOR EACH ROW
                WHEN (NEW.kind = 'effect' AND NEW.last_error NOT LIKE 'Attempt % ended without%')
                EXECUTE FUNCTION relay_record_wait()`
            }),
          )

          yield* perform(0, "timed", "RelayTimed")
          yield* eventually(
            advance(0, 0).pipe(
              Effect.andThen(deadLetters(0)),
              Effect.map((letters) => letters.length === 1),
            ),
            "20 seconds",
            "the dead letter",
          )

          // After failed attempt n the row waited min(10 ms × 2^(n − 1), 40 ms).
          const waits = yield* query(
            0,
            (sql) =>
              sql<{ attempts: number; wait: string }>`SELECT attempts, wait::text AS wait
                FROM relay_waits ORDER BY attempts`,
          )

          expect(waits.map(({ attempts }) => attempts)).toEqual([1, 2, 3, 4])

          for (const [index, backoff] of [10, 20, 40].entries()) {
            const wait = Number(waits[index]!.wait)
            expect(wait <= backoff && wait > backoff - 50).toBe(true)
          }

          // Every attempt was interrupted at the 100 ms timeout.
          expect(fixture.attempts.length).toBe(4)

          for (const attempt of fixture.attempts) {
            const ran = attempt.endedAt! - attempt.startedAt
            expect(attempt.interrupted && ran >= 95 && ran < 900).toBe(true)
          }

          expect(yield* outboxRows(0)).toEqual([])
          expect(yield* deadLetters(0)).toEqual([{ attempts: 4, ambiguous: true }])
        }),
      ),
  },
  {
    name: "claims no more intents than free delivery slots",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        1,
        // A lease shorter than the backlog's delivery time: an over-claimed row's lease
        // would end before its delivery started, and a second claim would count it twice.
        { relay: { deliveryConcurrency: 8, claimLease: "3 seconds" } },
        Effect.gen(function* () {
          const ids = Array.from({ length: 64 }, (_, index) => `slow-${index}`)
          const claimedAt = new Map<string, number>()
          const startedAt = new Map<string, number>()
          fixture.hook = (point, request) =>
            Effect.map(Clock.currentTimeMillis, (now) => {
              if (point === "afterClaim") claimedAt.set(request.payload, now)

              if (point === "beforeDelivery") startedAt.set(request.payload, now)
            })
          fixture.onTake = () => Effect.sleep("1 second")

          const samples: Array<number> = []

          const sampler = yield* query(
            0,
            (sql) =>
              sql<{ claimed: number }>`SELECT count(*)::int AS claimed FROM actor_outbox
                WHERE attempts > 0`,
          ).pipe(
            Effect.tap((rows) => Effect.sync(() => samples.push(rows[0]!.claimed))),
            Effect.repeat(Schedule.spaced("50 millis")),
            Effect.forkChild,
          )

          yield* stage(0, ids)
          yield* eventually(
            Effect.sync(() => takenOnce(fixture, ids)),
            "60 seconds",
            "every slow delivery",
          )
          yield* Fiber.interrupt(sampler)

          // Claimed rows never outnumber the slots, and each starts its delivery at once.
          expect(samples.length > 20).toBe(true)
          expect(Math.max(...samples) <= 8).toBe(true)
          expect([...fixture.claims.values()].every((count) => count === 1)).toBe(true)
          expect(claimedAt.size).toBe(64)

          for (const [payload, claimed] of claimedAt)
            expect(startedAt.get(payload)! - claimed < 1000).toBe(true)
        }),
      ),
  },
  {
    name: "routes a lease-expired attempt's success when it beats the takeover",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const { owner, other } = yield* ownerAndOther(yield* refOf("beats"))
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          fixture.provider = (attempt) =>
            attempt.attempt === 1
              ? Deferred.await(first).pipe(Effect.as(attempt.key))
              : Deferred.await(second).pipe(Effect.andThen(Effect.fail(ProviderDown.make({}))))

          const renewal = yield* faults(owner, (test) => test.pauseNext("beforeRenew"))
          yield* perform(owner, "beats")
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))
          const takeover = yield* advance(other, "4 seconds").pipe(Effect.forkChild)
          yield* eventually(Effect.sync(() => fixture.attempts.length === 2))

          // Attempt 1 succeeds after losing its lease, before attempt 2 reports.
          yield* Deferred.succeed(first, undefined)
          yield* eventually(
            receipts(other, "Called").pipe(Effect.map((count) => count === 1)),
            "10 seconds",
            "attempt 1's route",
          )
          yield* Deferred.succeed(second, undefined)
          yield* Fiber.join(takeover)
          yield* renewal.release
          yield* eventually(Effect.sync(() => fixture.attempts[1]?.endedAt !== undefined))

          expect((yield* callerState(other, "beats")).called).toEqual(["beats"])
          expect(yield* deadLetters(other)).toEqual([])
          expect(yield* receipts(other, "CallFailed")).toBe(0)
        }),
      ),
  },
  {
    name: "marks the dead letter ambiguous when a stale success arrives after it",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const { owner, other } = yield* ownerAndOther(yield* refOf("late"))
          const first = yield* Deferred.make<void>()
          fixture.provider = (attempt) =>
            attempt.attempt === 1
              ? Deferred.await(first).pipe(Effect.as(attempt.key))
              : Effect.fail(ProviderDown.make({}))

          const renewal = yield* faults(owner, (test) => test.pauseNext("beforeRenew"))
          yield* perform(owner, "late")
          yield* eventually(Effect.sync(() => fixture.attempts.length === 1))

          // Attempt 2 is the last; its typed failure dead-letters the effect.
          yield* advance(other, "4 seconds")
          expect(yield* deadLetters(other)).toEqual([{ attempts: 2, ambiguous: false }])
          expect((yield* callerState(other, "late")).letters).toMatchObject([
            { attempts: 2, ambiguous: false },
          ])

          yield* Deferred.succeed(first, undefined)
          yield* eventually(
            deadLetters(other).pipe(Effect.map((letters) => letters[0]?.ambiguous === true)),
            "10 seconds",
            "the late success",
          )
          yield* renewal.release

          // The routed dead letter stands, and nothing reached onSuccess.
          expect(yield* receipts(other, "Called")).toBe(0)
          expect(yield* receipts(other, "CallFailed")).toBe(1)
          expect((yield* callerState(other, "late")).letters).toMatchObject([
            { attempts: 2, ambiguous: false },
          ])
        }),
      ),
  },
  {
    name: "interrupts an attempt at its local deadline when renewals cannot reach the database",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const { owner, other } = yield* ownerAndOther(yield* refOf("partitioned"))
          fixture.provider = (attempt) =>
            attempt.attempt === 1 ? Effect.never : Effect.succeed(attempt.key)
          fixture.hook = (point) =>
            point === "beforeRenew" ? Effect.die(new Error("Database unreachable")) : Effect.void

          yield* perform(owner, "partitioned")
          yield* eventually(
            Effect.sync(() => fixture.attempts[0]?.interrupted === true),
            "10 seconds",
            "the local deadline",
          )
          const [first] = fixture.attempts
          const ran = first!.endedAt! - first!.startedAt

          // Interrupted at one lease, while the database lease still held the row.
          const [held] = yield* outboxRows(other)
          expect(ran >= 2900 && ran < 4000).toBe(true)
          expect(fixture.attempts.length).toBe(1)
          expect(held).toMatchObject({ kind: "effect", attempts: 1, ambiguous: true })
          // The runner and the database share this host's clock; 100 ms covers the reads.
          expect(first!.endedAt! <= Number(held!.due) + 100).toBe(true)

          fixture.hook = () => Effect.void
          yield* advance(other, "4 seconds")
          expect(fixture.attempts.map(({ attempt }) => attempt)).toEqual([1, 2])
          expect(yield* receipts(other, "Called")).toBe(1)
        }),
      ),
  },
  {
    name: "does not start an attempt whose claim outlived its lease before execution",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const { owner, other } = yield* ownerAndOther(yield* refOf("stalled"))
          fixture.provider = (attempt) => Effect.succeed(attempt.key)

          // The owner's commit wakes its own relay, which claims attempt 1 and stalls before calling.
          const stalled = yield* faults(owner, (test) => test.pauseNext("beforeExecute"))
          yield* perform(owner, "stalled")
          yield* stalled.reached
          yield* Effect.sleep("3100 millis")

          yield* advance(other, "4 seconds")
          expect(fixture.attempts.map(({ attempt, runner }) => [attempt, runner])).toEqual([
            [2, other],
          ])
          yield* stalled.release

          yield* advance(owner, "0 seconds")
          expect(fixture.attempts.map(({ attempt, runner }) => [attempt, runner])).toEqual([
            [2, other],
          ])
          expect(yield* receipts(other, "Called")).toBe(1)
          expect((yield* callerState(other, "stalled")).called).toEqual(["stalled"])
        }),
      ),
  },
  {
    name: "keeps a failure's backoff when a renewal races the settle",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        1,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const failing = yield* Deferred.make<void>()
          fixture.provider = () =>
            Deferred.await(failing).pipe(Effect.andThen(Effect.fail(ProviderDown.make({}))))

          const renewal = yield* faults(0, (test) => test.pauseNext("beforeRenew"))
          yield* perform(0, "raced")
          yield* renewal.reached
          yield* Deferred.succeed(failing, undefined)
          yield* eventually(
            outboxRows(0).pipe(
              Effect.map((rows) => rows[0]?.last_error?.includes("ProviderDown") === true),
            ),
          )
          yield* renewal.release
          yield* Effect.sleep("200 millis")

          // The paused renewal was stopped before the failure's write, so the 1 s backoff stands.
          const [row] = yield* outboxRows(0)
          expect(row).toMatchObject({ kind: "effect", attempts: 1, ambiguous: false })
          expect(Number(row!.due) - Number(row!.now) <= 1000).toBe(true)
        }),
      ),
  },
  {
    name: "routes one result when the runner is killed after the provider succeeded",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        { relay: NO_POLL, executors: SHORT_LEASE },
        Effect.gen(function* () {
          const { owner, other } = yield* ownerAndOther(yield* refOf("acked"))
          const pause = yield* faults(owner, (test) => test.pauseNext("afterExecute"))
          yield* perform(owner, "acked")
          yield* pause.reached
          yield* kill(owner)

          yield* advance(other, "4 seconds")

          // The provider ran twice under one effect id; one result was routed.
          expect(fixture.attempts.map(({ attempt, runner }) => [attempt, runner])).toEqual([
            [1, owner],
            [2, other],
          ])
          expect(yield* receipts(other, "Called")).toBe(1)
          expect((yield* callerState(other, "acked")).called).toEqual(["acked"])
        }),
      ),
  },
]

const releasesOnShutdown = (
  point: "afterClaim" | "beforeDelivery",
  name: string,
): ConformanceCase => ({
  name,
  run: ({ expect, environment, fixture: { relay: fixture } }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const claimedAt = yield* Effect.promise(() =>
          environment.run(
            Effect.gen(function* () {
              yield* reset(fixture)
              const test = yield* ActorTest
              const sender = yield* Relayer.get("shutdown")
              yield* sender.Stage({ ids: ["shutdown"], afterMs: 60_000 })
              const pause = yield* test.pauseNext(point)
              yield* test.advance("1 minute").pipe(Effect.forkDetach)
              yield* pause.reached

              return DateTime.toEpochMillis(yield* test.now)
            }),
          ),
        )

        // A graceful stop interrupts the paused delivery before any receiver committed it.
        yield* environment.restart

        yield* Effect.promise(() =>
          environment.run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const test = yield* ActorTest

              const row = sql<{ attempts: number; due: string }>`
          SELECT attempts, due_at_ms::text AS due FROM actor_outbox
          WHERE payload LIKE '%"shutdown"%'`

              // Released at shutdown, with its claim counted, instead of held for the lease.
              const [released] = yield* row
              expect(released!.attempts).toBe(1)
              expect(Number(released!.due) - claimedAt < 5000).toBe(true)

              // The restarted runtime's outbox clock starts at database time again.
              const wait = Number(released!.due) - DateTime.toEpochMillis(yield* test.now)
              yield* test.advance(Math.max(0, wait))
              expect(fixture.taken.get("shutdown")).toBe(1)
              expect(yield* row).toEqual([])
            }),
          ),
        )
      }),
    ),
})

/** Single-runner cases on the conformance environment, shared by PGlite and Postgres. */
export const relayConformance: ReadonlyArray<ConformanceCase> = [
  releasesOnShutdown("afterClaim", "releases claimed but unstarted rows on graceful shutdown"),
  releasesOnShutdown(
    "beforeDelivery",
    "releases a claimed row whose delivery had not reached a receiver on graceful shutdown",
  ),
  {
    name: "keeps scheduled_at_ms across claims while due_at_ms moves",
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const sender = yield* Relayer.get("scheduled")
          const at = DateTime.toEpochMillis(yield* test.now) + 60_000
          yield* sender.Stage({ ids: ["scheduled"], atMs: at })

          let defects = 1
          fixture.onTake = () =>
            defects-- > 0 ? Effect.die(new Error("Receiver defect")) : Effect.void
          yield* test.advance("1 minute")

          const rows = sql<{ attempts: number; due: string; scheduled: string }>`
            SELECT attempts, due_at_ms::text AS due, scheduled_at_ms::text AS scheduled
            FROM actor_outbox WHERE payload LIKE '%"scheduled"%'`

          const [claimed] = yield* rows
          expect(claimed).toMatchObject({ attempts: 1, scheduled: String(at) })
          expect(Number(claimed!.due) > at).toBe(true)
          yield* test.advance("1 second")
          expect(fixture.taken.get("scheduled")).toBe(2)
          expect(yield* rows).toEqual([])
        }),
      ),
  },
  {
    name: "backs off a row whose settle dies by max(claim lease, backoff(attempts)) up to maxBackoff",
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const sender = yield* Relayer.get("backoff")
          yield* sender.Stage({ ids: ["backoff"], afterMs: 60_000 })

          const rows = Effect.gen(function* () {
            const now = DateTime.toEpochMillis(yield* test.now)

            return yield* sql<{ attempts: number; wait: string }>`
              SELECT attempts, (due_at_ms - ${now})::text AS wait
              FROM actor_outbox WHERE payload LIKE '%"backoff"%'`
          })

          yield* test.crashNext("beforeOutboxDelete")
          yield* test.advance("1 minute")
          const [first] = yield* rows
          expect(first!.attempts).toBe(1)
          expect(Number(first!.wait) > 35_000 && Number(first!.wait) <= 37_000).toBe(true)

          yield* sql`UPDATE actor_outbox SET attempts = 12, due_at_ms = 0
            WHERE payload LIKE '%"backoff"%'`
          yield* test.crashNext("beforeOutboxDelete")
          yield* test.advance(0)
          const [capped] = yield* rows
          expect(capped!.attempts).toBe(13)
          expect(Number(capped!.wait) > 254_000 && Number(capped!.wait) <= 256_000).toBe(true)

          yield* test.advance("256 seconds")
          expect(fixture.taken.get("backoff")).toBe(1)
          expect(yield* rows).toEqual([])
        }),
      ),
  },
  {
    name: "saturates intent backoff at the largest accepted maxBackoff",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const maxBackoffMs = 2_147_483_647

          yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            VALUES (1, 'saturate', 'Ghost', 'saturate')`
          yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms,
              scheduled_at_ms, tenant_id, actor_type, actor_id, target_type, target_id, command,
              payload, caller, kind, attempts)
            VALUES (1, 'saturate', 0, 0, 0, 'saturate', 'Ghost', 'saturate', 'Ghost', 'saturate',
              'Haunt', '{}', '{}', 'intent', 30)`

          const claimed = yield* claimIntents({
            sql,
            now: 1,
            limit: 1,
            leaseMs: 37_000,
            maxBackoffMs,
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* sql`DELETE FROM actor_outbox WHERE tenant_id = 'saturate'`
                yield* sql`DELETE FROM actor_generations WHERE tenant_id = 'saturate'`
              }).pipe(Effect.orDie),
            ),
          )

          expect(claimed.map((row) => [row.attempts, Number(row.claimed_until)])).toEqual([
            [31, 1 + maxBackoffMs],
          ])
        }),
      ),
  },
  {
    name: "claims later due intents while other transactions hold the earliest rows locked",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      withCluster(
        environment,
        fixture,
        1,
        { relay: { deliveryConcurrency: 1, poll: "100 millis" } },
        Effect.gen(function* () {
          const ids = ["locked-1", "locked-2", "locked-3", "unlocked-4"]

          for (const [index, id] of ids.entries())
            yield* stage(0, [id], { afterMs: 60_000 + index * 1000 })

          const locked = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          // Three rows locked where one free slot probes two candidates.
          const holder = yield* query(0, (sql) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT intent_id FROM actor_outbox WHERE kind = 'intent'
                  ORDER BY due_at_ms LIMIT 3 FOR UPDATE`
                yield* Deferred.succeed(locked, undefined)
                yield* Deferred.await(release)
              }),
            ),
          ).pipe(Effect.forkChild)

          yield* Deferred.await(locked)

          yield* advance(0, "2 minutes")
          yield* eventually(
            Effect.sync(() => fixture.taken.get("unlocked-4") === 1),
            "20 seconds",
            "the unlocked intent",
          )
          expect(ids.slice(0, 3).map((id) => fixture.taken.get(id))).toEqual([
            undefined,
            undefined,
            undefined,
          ])

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holder)
          yield* eventually(
            Effect.sync(() => takenOnce(fixture, ids)),
            "20 seconds",
            "every intent",
          )
        }),
      ),
  },
  {
    name: "dead-letters an already exhausted row with its recorded outcome",
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          fixture.provider = () => Effect.fail(ProviderDown.make({}))
          const caller = yield* RelayCaller.get("exhausted")

          // The dead-letter transaction fails once, after the typed failure is recorded.
          yield* sql`CREATE OR REPLACE FUNCTION relay_refuse_dead_letter() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dead letter refused'; END $$`
          yield* sql`CREATE TRIGGER relay_refuse_dead_letter BEFORE INSERT ON actor_dead_letters
            FOR EACH ROW EXECUTE FUNCTION relay_refuse_dead_letter()`

          yield* caller
            .Perform({ key: "exhausted", effect: "RelayCallOnce" })
            .pipe(
              Effect.andThen(test.advance(0)),
              Effect.ensuring(
                sql`DROP TRIGGER relay_refuse_dead_letter ON actor_dead_letters`.pipe(Effect.orDie),
              ),
            )

          const pending = sql`SELECT attempts, ambiguous FROM actor_outbox
            WHERE actor_type = 'RelayCaller' AND actor_id = 'exhausted'`

          expect(yield* pending).toEqual([{ attempts: 1, ambiguous: false }])

          // The next claim fences without counting and dead-letters the recorded failure.
          yield* test.advance("1 second")
          expect(fixture.attempts.length).toBe(1)
          expect(yield* pending).toEqual([])
          expect(
            yield* sql`SELECT attempts, ambiguous FROM actor_dead_letters
              WHERE tenant_id = ${test.tenant} AND actor_id = 'exhausted'`,
          ).toEqual([{ attempts: 1, ambiguous: false }])
          expect(yield* test.receiptsFor(caller.ref, "OnceFailed")).toBe(1)
        }),
      ),
  },
  {
    name: "claims intents without reading due effect rows that no runner can execute",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          yield* test.advance(0)
          const now = DateTime.toEpochMillis(yield* test.now)

          yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            SELECT ((i % 256) - 128)::bigint << 56 | i, 'ghost', 'Ghost', i::text
            FROM generate_series(1, 10000) AS i`
          yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms,
              scheduled_at_ms, tenant_id, actor_type, actor_id, target_type, target_id, command,
              payload, caller, kind)
            SELECT ((i % 256) - 128)::bigint << 56 | i, 'ghost-' || i, (i % 256) - 128, 0, 0,
              'ghost', 'Ghost', i::text, 'Ghost', i::text, 'Haunt', '{}', '{}', 'effect'
            FROM generate_series(1, 10000) AS i`
          yield* sql`ANALYZE actor_outbox`

          const [text, parameters] = claimIntents({
            sql,
            now,
            limit: 16,
            leaseMs: 37_000,
            maxBackoffMs: 256_000,
          }).compile()

          class Explained extends Schema.TaggedError<Explained>()("Explained", {
            plan: Schema.Unknown,
          }) {}

          // Rolled back, so the analyzed claim takes nothing for real.
          const explained = yield* sql
            .withTransaction(
              sql
                .unsafe<{ readonly "QUERY PLAN": unknown }>(
                  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
                  parameters,
                )
                .pipe(
                  Effect.flatMap((rows) =>
                    Effect.fail(Explained.make({ plan: rows[0]!["QUERY PLAN"] })),
                  ),
                ),
            )
            .pipe(
              Effect.flip,
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* sql`DELETE FROM actor_outbox WHERE tenant_id = 'ghost'`
                  yield* sql`DELETE FROM actor_generations WHERE tenant_id = 'ghost'`
                }).pipe(Effect.orDie),
              ),
            )

          expect(explained).toBeInstanceOf(Explained)

          const [output] = yield* Schema.decodeUnknownEffect(ExplainOutput)(
            Schema.is(Explained)(explained) ? explained.plan : undefined,
          ).pipe(Effect.orDie)

          const nodes = planNodes(output.Plan)
          const due = nodes.filter((node) => node["Index Name"] === "actor_outbox_due_kind")

          expect(nodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(false)
          expect(due.length > 0).toBe(true)
          // The kind-leading range never reaches the 10,000 due effect rows.
          expect(due.every((node) => node["Actual Rows"] === 0)).toBe(true)
          expect(due.every((node) => (node["Rows Removed by Filter"] ?? 0) === 0)).toBe(true)
        }),
      ),
  },
  {
    name: "claims a runner's own effects past due effect rows it cannot execute in the same bucket",
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const caller = yield* RelayCaller.get("starved")
          yield* caller.Perform({ key: "starved-1", effect: "RelayCall" })
          yield* test.advance(0)

          const [placed] = yield* sql<{ bucket: number }>`
            SELECT (routing_key >> 56)::int AS bucket FROM actor_generations
            WHERE tenant_id = ${test.tenant} AND actor_type = 'RelayCaller' AND actor_id = 'starved'`

          // More orphaned rows in the caller's bucket than any claim's per-bucket probe takes.
          yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            SELECT (${placed!.bucket}::bigint << 56) | i, 'orphan', 'Orphan', i::text
            FROM generate_series(1, 200) AS i`
          yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms,
              scheduled_at_ms, tenant_id, actor_type, actor_id, target_type, target_id, command,
              payload, caller, kind)
            SELECT (${placed!.bucket}::bigint << 56) | i, 'orphan-' || i, ${placed!.bucket}, 0, 0,
              'orphan', 'Orphan', i::text, 'Orphan', i::text, 'Haunt', '{}', '{}', 'effect'
            FROM generate_series(1, 200) AS i`

          yield* Effect.gen(function* () {
            yield* caller.Perform({ key: "starved-2", effect: "RelayCall" })
            yield* test.advance(0)
            expect(fixture.attempts.map(({ key }) => key)).toEqual(["starved-1", "starved-2"])
            expect(yield* test.receiptsFor(caller.ref, "Called")).toBe(2)
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* sql`DELETE FROM actor_outbox WHERE tenant_id = 'orphan'`
                yield* sql`DELETE FROM actor_generations WHERE tenant_id = 'orphan'`
              }).pipe(Effect.orDie),
            ),
          )
        }),
      ),
  },
  {
    name: "drains a due backlog far larger than the delivery slots in one advance",
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { relay: fixture } }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const test = yield* ActorTest
          const ids = Array.from({ length: 2000 }, (_, index) => `backlog-${index}`)

          yield* Effect.forEach(
            Array.from({ length: 40 }, (_, index) => ids.slice(index * 50, (index + 1) * 50)),
            (chunk) =>
              Relayer.get("backlog").pipe(
                Effect.flatMap((relayer) => relayer.Stage({ ids: chunk, afterMs: 60_000 })),
              ),
            { discard: true },
          )

          yield* test.advance("1 minute")
          expect(takenOnce(fixture, ids)).toBe(true)
        }),
      ),
  },
  {
    name: "rejects relay, executor, and per-effect timings out of range",
    run: ({ expect }) =>
      Effect.runPromise(
        Effect.sync(() => {
          const rejects = (build: () => void) => {
            try {
              build()

              return undefined
            } catch (error) {
              return String(error)
            }
          }

          const authorize = () => Effect.succeed(true)

          expect(
            rejects(() => {
              runtimeLayer({ authorize, executors: { lease: "2 seconds" } })
            }),
          ).toContain("executors.lease must be at least 3 seconds")
          expect(
            rejects(() => {
              runtimeLayer({ authorize, relay: { deliveryConcurrency: 0 } })
            }),
          ).not.toBe(undefined)
          expect(
            rejects(() => {
              runtimeLayer({ authorize, executors: { lease: "3 seconds", concurrency: 1 } })
            }),
          ).toBe(undefined)

          class Probe extends Actor.effect<Probe>()("Probe", {}) {}

          const make = (policy: EffectPolicy<typeof Probe, never>) =>
            rejects(() => {
              Actor.make("TimingProbe", {
                key: Schema.String,
                effects: [Probe],
                api: {},
                policy: { effects: { Probe: policy } },
              })
            })

          expect(make({ timeout: "0 millis" })).toContain("policy.effects.Probe.timeout")
          expect(make({ timeout: Duration.millis(2 ** 31) })).toContain(
            "policy.effects.Probe.timeout",
          )
          expect(
            make({ retry: { times: 1, backoff: { base: "2 seconds", max: "1 second" } } }),
          ).toContain("must be at least its base")
          expect(
            make({ retry: { times: 1, backoff: { base: "0 millis", max: "1 second" } } }),
          ).toContain("policy.effects.Probe.retry.backoff.base")
          expect(
            make({
              timeout: "5 seconds",
              retry: { times: 2, backoff: { base: "10 millis", max: "1 minute" } },
            }),
          ).toBe(undefined)
        }),
      ),
  },
]
