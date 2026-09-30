import { Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors } from "../../index.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { RuntimeControl } from "../../runtime/drain.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster, type RunnerServices } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment, ConformanceExpect } from "../conformance.ts"
import { type ConnectionsFixture, connectionsLayer, Live, Room } from "./connections/actors.ts"
import { next } from "./connections/harness.ts"

/** One executor attempt as the fake provider saw it. */
interface Attempt {
  readonly runner: number
  readonly attempt: number
  interrupted: boolean
}

/** Shared by the drain actors and every drain case; each case resets it first. */
export interface DrainFixture {
  /** Deposit handler runs by command id, rolled-back runs included. */
  readonly runs: Map<string, number>
  readonly attempts: Array<Attempt>
  /** What the provider does on one attempt; the default succeeds with the key. */
  provider: (key: string) => Effect.Effect<string>
  /** What a deposit does after counting its run, before it commits. */
  onDeposit: Effect.Effect<void>
}

export const drainFixture = (): DrainFixture => ({
  runs: new Map(),
  attempts: [],
  provider: (key) => Effect.succeed(key),
  onDeposit: Effect.void,
})

const reset = (fixture: DrainFixture) =>
  Effect.sync(() => {
    fixture.runs.clear()
    fixture.attempts.length = 0
    fixture.provider = (key) => Effect.succeed(key)
    fixture.onDeposit = Effect.void
  })

class Charge extends Actor.effect<Charge>()("Charge", {
  input: { key: Schema.String },
  success: Schema.String,
}) {}

const Deposit = Actor.command("Deposit", { input: Schema.Finite, output: Schema.Finite })

const Bill = Actor.command("Bill", { input: Schema.String })

const Transfer = Actor.command("Transfer", {
  input: Schema.Struct({ to: Schema.String, amount: Schema.Finite }),
})

const Charged = Actor.command("Charged", { input: Schema.String })

const ChargeFailed = Actor.command("ChargeFailed", { input: Actor.DeadLetter(Charge) })

const Letter = Schema.Struct({ attempts: Schema.Int, ambiguous: Schema.Boolean })

const Account = Actor.make("Account", {
  key: Schema.String,
  state: Actor.state({
    balance: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    charged: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    letters: Schema.Array(Letter).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  effects: [Charge],
  api: { Deposit, Bill },
  internal: { Charged, ChargeFailed },
  policy: {
    effects: { Charge: { retry: { times: 0 }, onSuccess: Charged, onDeadLetter: ChargeFailed } },
  },
})

/** Sends deposits to accounts as intents. */
const Sender = Actor.make("Sender", { key: Schema.String, api: { Transfer } })

/** The account and sender commands, which every runner builds. */
export const drainLayer = (fixture: DrainFixture) =>
  Layer.merge(
    Sender.toLayer(
      Effect.succeed({
        Transfer: Effect.fnUntraced(function* ({ to, amount }) {
          yield* (yield* Account.intents(to)).Deposit(amount)
        }),
      }),
    ),
    drainAccounts(fixture),
  )

const drainAccounts = (fixture: DrainFixture) =>
  Account.toLayer(
    Effect.succeed({
      Deposit: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Account.Turn
        fixture.runs.set(turn.commandId, (fixture.runs.get(turn.commandId) ?? 0) + 1)
        yield* fixture.onDeposit
        yield* turn.state.set({ balance: turn.state.balance + amount })

        return turn.state.balance
      }),
      Bill: Effect.fnUntraced(function* (key: string) {
        yield* (yield* Account.Turn).perform(Charge.make({ key }))
      }),
      Charged: Effect.fnUntraced(function* (key: string) {
        const turn = yield* Account.Turn
        yield* turn.state.set({ charged: [...turn.state.charged, key] })
      }),
      ChargeFailed: Effect.fnUntraced(function* ({ attempts, ambiguous }) {
        const turn = yield* Account.Turn
        yield* turn.state.set({ letters: [...turn.state.letters, { attempts, ambiguous }] })
      }),
    }),
  )

/** The `Charge` executor of `runner`; a case builds it on the runners it chooses. */
const chargeExecutor = (fixture: DrainFixture, runner: number) =>
  Account.toEffectLayer(
    Effect.succeed({
      Charge: ({ key }) =>
        Effect.gen(function* () {
          const attempt: Attempt = {
            runner,
            attempt: (yield* Account.Executor).attempt,
            interrupted: false,
          }

          fixture.attempts.push(attempt)

          return yield* Effect.suspend(() => fixture.provider(key)).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                attempt.interrupted = Exit.hasInterrupts(exit)
              }),
            ),
          )
        }),
    }),
  ) as Layer.Layer<never, never, RunnerServices>

const EXPIRATION_SECONDS = 3

/** Builds a fresh database and three runners on it, with executors on `executors`. */
const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: DrainFixture,
  settings: {
    readonly executors?: ReadonlyArray<number>
    readonly poll?: Duration.Input
    /** Also registers the connection cases' room, for a case that holds a connection. */
    readonly connections?: ConnectionsFixture
  },
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners: 3,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors:
            settings.connections === undefined
              ? drainLayer(fixture)
              : Layer.merge(drainLayer(fixture), connectionsLayer(settings.connections)),
          runnerActors: (runner) =>
            (settings.executors ?? []).includes(runner)
              ? chargeExecutor(fixture, runner)
              : Layer.empty,
          relay: { poll: settings.poll ?? "200 millis" },
          executors: { lease: "3 seconds" },
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

const account = (id: string) => Account.get(id)

const deposit = (runner: number, id: string, amount: number, commandId?: string) =>
  on(
    runner,
    account(id).pipe(
      Effect.flatMap((handle) =>
        commandId === undefined
          ? handle.Deposit(amount)
          : handle.Deposit(amount).pipe(Actor.commandId(commandId)),
      ),
    ),
  )

const mint = (runner: number) =>
  on(
    runner,
    Actors.use((actors) => actors.mintCommandId),
  )

/** Finds an actor's handle by id. */
type Lookup = (id: string) => Effect.Effect<{ readonly ref: ActorRef }, never, Actors>

const refOf = (id: string, of: Lookup = account, runner = 0) =>
  on(
    runner,
    Effect.map(of(id), (handle) => handle.ref),
  )

const inspect = (runner: number, ref: ActorRef) =>
  on(
    runner,
    ActorTest.use((test) => test.inspect(ref)),
  )

const stateOf = (runner: number, id: string) =>
  Effect.flatMap(refOf(id, account, runner), (ref) => inspect(runner, ref))

const readiness = (runner: number) =>
  on(
    runner,
    RuntimeControl.use((control) => control.readiness),
  )

const drain = (runner: number, deadline: Duration.Input) =>
  on(
    runner,
    RuntimeControl.use((control) => control.drain({ deadline })),
  )

/** An actor id, an account's by default, placed on a runner that `accept`s its owner. */
const placed = (prefix: string, accept: (owner: number) => boolean, of: Lookup = account) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    for (let index = 0; ; index++) {
      const id = `${prefix}-${index}`
      const owner = yield* cluster.owner(yield* refOf(id, of))

      if (owner !== undefined && accept(owner)) return { id, owner }
    }
  })

const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

/** Database time in epoch milliseconds, the clock outbox due times use. */
const NOW_MS = "floor(extract(epoch FROM clock_timestamp()) * 1000)"

/** The one `Charge` row of the case, as the relay left it. */
const chargeRow = (runner: number) =>
  on(
    runner,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return yield* sql<{ attempts: number; ambiguous: boolean; leased: boolean }>`
        SELECT attempts, ambiguous, due_at_ms > ${sql.literal(NOW_MS)} AS leased
        FROM actor_outbox WHERE kind = 'job' AND command = 'Charge'`
    }).pipe(Effect.orDie),
  )

/**
 * Pauses the next deposit on the owner of `id` at `point`, calls it from
 * another runner under a fixed command id, and drains the owner with
 * `deadline` while it is paused.
 */
const drainDuringTurn = (
  expect: ConformanceExpect,
  fixture: DrainFixture,
  point: "beforeCommit" | "afterCommit",
) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const id = `paused-${point}`
    const ref = yield* refOf(id)
    const owner = (yield* cluster.owner(ref))!
    const caller = (owner + 1) % cluster.runners
    expect(yield* deposit(caller, id, 1)).toBe(1)

    const commandId = yield* mint(caller)

    const pause = yield* on(
      owner,
      ActorTest.use((test) => test.pauseNext(point)),
    )

    const call = yield* deposit(caller, id, 2, commandId).pipe(Effect.forkChild)
    yield* pause.reached

    expect(yield* drain(owner, "200 millis")).toEqual({
      outcome: "deadline-expired",
      interruptedTurns: 1,
      interruptedEffects: 0,
    })

    expect(yield* inspect(caller, ref)).toMatchObject(
      point === "beforeCommit"
        ? { state: { balance: 1 }, receipts: 1 }
        : { state: { balance: 3 }, receipts: 2 },
    )

    yield* cluster.shutdown(owner)
    expect(yield* Fiber.join(call)).toBe(3)
    expect(yield* inspect(caller, ref)).toMatchObject({ state: { balance: 3 }, receipts: 2 })

    return { commandId, caller }
  })

/** Drain cases: readiness, clean drain, deadline rollback with a same-id retry, and survivor takeover. */
export const drainConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "drain: reports ready, then drains cleanly, turns unready, and refuses new commands",
    run: ({ expect, environment, fixture }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* reset(fixture.drain)

          yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                const control = yield* RuntimeControl
                expect(yield* control.readiness).toEqual({ ready: true })
                const single = yield* account("single")
                expect(yield* single.Deposit(1)).toBe(1)

                const clean = { outcome: "clean", interruptedTurns: 0, interruptedEffects: 0 }
                expect(yield* control.drain({ deadline: "5 seconds" })).toEqual(clean)
                expect(yield* control.readiness).toEqual({ ready: false, reason: "drained" })
                expect(yield* control.drain({ deadline: "1 millis" })).toEqual(clean)

                const refused = yield* single.Deposit(1).pipe(Effect.flip)
                expect(refused.reason._tag).toBe("ActorUnavailable")
              }),
            ),
          )
        }).pipe(Effect.ensuring(environment.restart)),
      ),
  },
  {
    name: "drain: rolls back a turn the deadline interrupts, and its retry under the same id commits once",
    run: ({ expect, environment, fixture }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* reset(fixture.drain)
          const hold = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()

          const { commandId, tenant } = yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                const control = yield* RuntimeControl
                const held = yield* account("held")
                expect(yield* held.Deposit(1)).toBe(1)
                const commandId = yield* (yield* Actors).mintCommandId

                fixture.drain.onDeposit = Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(hold)),
                )

                const call = yield* held
                  .Deposit(2)
                  .pipe(Actor.commandId(commandId), Effect.ignore, Effect.forkChild)

                yield* Deferred.await(started)

                expect(yield* control.drain({ deadline: "100 millis" })).toEqual({
                  outcome: "deadline-expired",
                  interruptedTurns: 1,
                  interruptedEffects: 0,
                })
                yield* Fiber.interrupt(call)
                expect(yield* (yield* ActorTest).inspect(held.ref)).toMatchObject({
                  state: { balance: 1 },
                  receipts: 1,
                })

                return { commandId, tenant: (yield* ActorTest).tenant }
              }),
            ),
          )

          fixture.drain.onDeposit = Effect.void
          yield* environment.restart

          yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                const held = yield* account("held").pipe(Actor.tenant(tenant))
                expect(yield* held.Deposit(2).pipe(Actor.commandId(commandId))).toBe(3)
                expect(yield* held.Deposit(2).pipe(Actor.commandId(commandId))).toBe(3)
                expect(yield* (yield* ActorTest).inspect(held.ref)).toMatchObject({
                  state: { balance: 3 },
                  receipts: 2,
                })
                expect(fixture.drain.runs.get(commandId)).toBe(2)
              }),
            ),
          )
        }),
      ),
  },
  {
    name: "drain: finishes an in-flight turn, refuses new commands, and a survivor takes the actors at once",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        {},
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const { id, owner } = yield* placed("clean", () => true)
          const caller = (owner + 1) % cluster.runners
          expect(yield* deposit(caller, id, 1)).toBe(1)
          expect(yield* readiness(owner)).toEqual({ ready: true })

          const pause = yield* on(
            owner,
            ActorTest.use((test) => test.pauseNext("beforeCommit")),
          )

          const call = yield* deposit(caller, id, 2).pipe(Effect.forkChild)
          yield* pause.reached

          const draining = yield* drain(owner, "30 seconds").pipe(Effect.forkChild)

          yield* eventually(
            Effect.map(readiness(owner), (ready) => !ready.ready && ready.reason === "draining"),
            "the runner to turn unready",
          )

          const elsewhere = yield* placed("elsewhere", (placedOn) => placedOn !== owner)
          const refused = yield* deposit(owner, elsewhere.id, 1).pipe(Effect.flip)
          expect(refused.reason._tag).toBe("ActorUnavailable")

          yield* pause.release
          expect(yield* Fiber.join(draining)).toEqual({
            outcome: "clean",
            interruptedTurns: 0,
            interruptedEffects: 0,
          })
          expect(yield* Fiber.join(call)).toBe(3)
          expect(yield* readiness(owner)).toEqual({ ready: false, reason: "drained" })

          yield* cluster.shutdown(owner)
          const released = yield* Clock.currentTimeMillis
          expect(yield* deposit(caller, id, 4)).toBe(7)
          const served = yield* Clock.currentTimeMillis
          expect(served - released < EXPIRATION_SECONDS * 1000).toBe(true)

          const next = yield* cluster.owner(yield* refOf(id, account, caller))
          expect(next !== undefined && next !== owner).toBe(true)
          expect(yield* stateOf(caller, id)).toMatchObject({ state: { balance: 7 }, receipts: 3 })
          expect(yield* readiness(caller)).toEqual({ ready: true })
        }),
      ),
  },
  {
    name: "drain: starts no following batch behind the turn it finishes, and the waiting command commits once on a survivor",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        {},
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const { id, owner } = yield* placed("following", () => true)
          const caller = (owner + 1) % cluster.runners
          const ref = yield* refOf(id)
          expect(yield* deposit(caller, id, 1)).toBe(1)

          const commandId = yield* mint(caller)

          const held = yield* on(
            owner,
            ActorTest.use((test) => test.pauseNext("beforeCommit")),
          )

          const first = yield* deposit(caller, id, 2).pipe(Effect.forkChild)
          yield* held.reached

          const queued = yield* on(
            owner,
            ActorTest.use((test) => test.pauseNext("queued")),
          )

          const second = yield* deposit(caller, id, 3, commandId).pipe(Effect.forkChild)
          yield* queued.reached
          yield* queued.release

          const draining = yield* drain(owner, "30 seconds").pipe(Effect.forkChild)

          yield* eventually(
            Effect.map(readiness(owner), (ready) => !ready.ready && ready.reason === "draining"),
            "the runner to turn unready",
          )

          yield* held.release

          expect(yield* Fiber.join(draining)).toEqual({
            outcome: "clean",
            interruptedTurns: 0,
            interruptedEffects: 0,
          })
          expect(yield* Fiber.join(first)).toBe(3)

          expect(fixture.drain.runs.get(commandId) ?? 0).toBe(0)
          expect(yield* inspect(caller, ref)).toMatchObject({ state: { balance: 3 }, receipts: 2 })

          yield* cluster.shutdown(owner)
          expect(yield* Fiber.join(second)).toBe(6)
          expect(fixture.drain.runs.get(commandId)).toBe(1)
          expect(yield* inspect(caller, ref)).toMatchObject({ state: { balance: 6 }, receipts: 3 })
        }),
      ),
  },
  {
    name: "drain: rolls back a turn the deadline interrupts before its commit, reports it, and the caller's retry commits once on the next owner",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        {},
        Effect.gen(function* () {
          const { commandId } = yield* drainDuringTurn(expect, fixture.drain, "beforeCommit")
          expect(fixture.drain.runs.get(commandId)).toBe(2)
        }),
      ),
  },
  {
    name: "drain: a turn the deadline interrupts while its sent COMMIT is still running commits once, and the caller's retry returns its output",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        {},
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const id = "commit-sent"
          const ref = yield* refOf(id)
          const owner = (yield* cluster.owner(ref))!
          const caller = (owner + 1) % cluster.runners
          expect(yield* deposit(caller, id, 1)).toBe(1)

          const commandId = yield* mint(caller)
          const held = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          yield* on(
            caller,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql.unsafe(`CREATE FUNCTION hold_commit() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN PERFORM pg_advisory_xact_lock(4242); RETURN NULL; END $$`)
              yield* sql.unsafe(`CREATE CONSTRAINT TRIGGER hold_commit AFTER INSERT ON actor_receipts
                DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
                WHEN (NEW.command_id = '${commandId}') EXECUTE FUNCTION hold_commit()`)
              yield* sql`SELECT pg_advisory_xact_lock(4242)`.pipe(
                Effect.andThen(Deferred.succeed(held, undefined)),
                Effect.andThen(Deferred.await(release)),
                sql.withTransaction,
                Effect.forkDetach,
              )
            }).pipe(Effect.orDie),
          )
          yield* Deferred.await(held)

          const call = yield* deposit(caller, id, 2, commandId).pipe(Effect.forkChild)

          yield* eventually(
            on(
              caller,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient

                const waiting = yield* sql`SELECT 1 FROM pg_stat_activity
                  WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
                    AND upper(query) LIKE 'COMMIT%'`

                return waiting.length > 0
              }).pipe(Effect.orDie),
            ),
            "the turn's COMMIT to wait on the advisory lock",
          )

          expect(yield* drain(owner, "200 millis")).toEqual({
            outcome: "deadline-expired",
            interruptedTurns: 1,
            interruptedEffects: 0,
          })
          yield* Deferred.succeed(release, undefined)

          yield* cluster.shutdown(owner)
          expect(yield* Fiber.join(call)).toBe(3)
          expect(yield* inspect(caller, ref)).toMatchObject({ state: { balance: 3 }, receipts: 2 })
          expect(fixture.drain.runs.get(commandId)).toBe(2)
        }),
      ),
  },
  {
    name: "drain: replays the receipt of a turn the deadline interrupted after its commit, without running it again",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        {},
        Effect.gen(function* () {
          const { commandId } = yield* drainDuringTurn(expect, fixture.drain, "afterCommit")
          expect(fixture.drain.runs.get(commandId)).toBe(1)
        }),
      ),
  },
  {
    name: "drain: claims no effect while draining, and the pending effect runs once on a runner that starts later",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        { executors: [0] },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const { id, owner } = yield* placed("unclaimed", (placedOn) => placedOn !== 0)

          expect(yield* drain(0, "5 seconds")).toEqual({
            outcome: "clean",
            interruptedTurns: 0,
            interruptedEffects: 0,
          })

          yield* on(owner, account(id).pipe(Effect.flatMap((handle) => handle.Bill("late"))))
          yield* Effect.sleep("1500 millis")
          expect(fixture.drain.attempts.length).toBe(0)
          expect(yield* chargeRow(owner)).toMatchObject([{ attempts: 0, ambiguous: false }])

          yield* cluster.shutdown(0)
          yield* cluster.restart(0)
          yield* eventually(
            Effect.map(
              stateOf(owner, id),
              (inspection) => inspection.effects + inspection.outbox === 0,
            ),
            "the pending effect to run",
          )
          expect(yield* stateOf(owner, id)).toMatchObject({ state: { charged: ["late"] } })
          expect(fixture.drain.attempts).toEqual([{ runner: 0, attempt: 1, interrupted: false }])
        }),
      ),
  },
  {
    name: "drain: interrupts an effect attempt at the deadline, keeps it ambiguous, and it dead-letters as ambiguous without running again",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        { executors: [0] },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const { id, owner } = yield* placed("ambiguous", (placedOn) => placedOn !== 0)
          fixture.drain.provider = () => Effect.never

          yield* on(owner, account(id).pipe(Effect.flatMap((handle) => handle.Bill("stuck"))))
          yield* eventually(
            Effect.sync(() => fixture.drain.attempts.length === 1),
            "the attempt to start",
          )

          expect(yield* drain(0, "200 millis")).toEqual({
            outcome: "deadline-expired",
            interruptedTurns: 0,
            interruptedEffects: 1,
          })
          expect(fixture.drain.attempts).toEqual([{ runner: 0, attempt: 1, interrupted: true }])
          expect(yield* chargeRow(owner)).toEqual([{ attempts: 1, ambiguous: true, leased: true }])

          yield* cluster.shutdown(0)
          yield* cluster.restart(0)
          yield* eventually(
            Effect.map(
              stateOf(owner, id),
              (inspection) => inspection.effects + inspection.outbox === 0,
            ),
            "the interrupted effect to be taken over",
          )
          expect((yield* stateOf(owner, id)).state).toEqual({
            letters: [{ attempts: 1, ambiguous: true }],
          })
          expect(fixture.drain.attempts.length).toBe(1)
        }),
      ),
  },
  {
    name: "drain: releases an intent delivery it had claimed, and a survivor delivers it once",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        { poll: "1 hour" },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const sender = yield* placed("sender", () => true, Sender.get)
          const drained = sender.owner
          const survivor = (drained + 1) % cluster.runners
          const receiver = yield* placed("receiver", (placedOn) => placedOn !== drained)

          const pause = yield* on(
            drained,
            ActorTest.use((test) => test.pauseNext("afterClaim")),
          )

          yield* on(
            survivor,
            Sender.get(sender.id).pipe(
              Effect.flatMap((handle) => handle.Transfer({ to: receiver.id, amount: 5 })),
            ),
          )
          yield* pause.reached

          expect(yield* drain(drained, "5 seconds")).toEqual({
            outcome: "clean",
            interruptedTurns: 0,
            interruptedEffects: 0,
          })

          const [row] = yield* on(
            survivor,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              return yield* sql<{ due: boolean }>`
                SELECT due_at_ms <= ${sql.literal(NOW_MS)} AS due FROM actor_outbox WHERE kind = 'intent'`
            }).pipe(Effect.orDie),
          )

          expect(row).toEqual({ due: true })

          yield* on(
            survivor,
            ActorTest.use((test) => test.advance("0 millis")),
          )
          expect(yield* stateOf(survivor, receiver.id)).toMatchObject({
            state: { balance: 5 },
            receipts: 1,
            outbox: 0,
          })
          expect([...fixture.drain.runs.values()]).toEqual([1])
        }),
      ),
  },
  {
    name: "drain: drains a runner under load without losing or repeating a command",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        {},
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const drained = 0
          const ids = Array.from({ length: 12 }, (_, index) => `load-${index}`)
          const calls = Array.from({ length: 120 }, (_, index) => ids[index % ids.length]!)

          const load = yield* Effect.forEach(
            calls,
            (id, index) => deposit(1 + (index % 2), id, 1),
            { concurrency: 8, discard: true },
          ).pipe(Effect.forkChild)

          yield* eventually(
            Effect.sync(() => fixture.drain.runs.size >= 20),
            "the load to start",
          )
          const report = yield* drain(drained, "5 seconds")
          expect(report.outcome).toBe("clean")
          yield* cluster.shutdown(drained)
          yield* Fiber.join(load)

          for (const id of ids) {
            const inspection = yield* stateOf(1, id)
            const sent = calls.filter((call) => call === id).length
            expect(inspection).toMatchObject({ state: { balance: sent }, receipts: sent })
          }

          expect(fixture.drain.runs.size).toBe(calls.length)
        }),
      ),
  },
  {
    name: "drain: returns within its deadline while a turn, a relay delivery, and a held connection are in flight, and reports the turn it cut off",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.drain,
        { connections: fixture.connections },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          const drained = 0
          const survivor = 1
          const room = yield* placed("room", (placedOn) => placedOn === drained, Room.get)
          const roomRef = yield* refOf(room.id, Room.get)

          const connection = yield* on(
            drained,
            ActorTest.use((test) => test.connect(roomRef, Live, { name: "alice" })),
          )

          yield* next(connection)

          const sender = yield* placed("sender", (placedOn) => placedOn === drained, Sender.get)
          const receiver = yield* placed("receiver", (placedOn) => placedOn !== drained)

          const receiving = yield* on(
            receiver.owner,
            ActorTest.use((test) => test.pauseNext("beforeCommit")),
          )

          yield* on(
            survivor,
            Sender.get(sender.id).pipe(
              Effect.flatMap((handle) => handle.Transfer({ to: receiver.id, amount: 5 })),
            ),
          )
          yield* receiving.reached

          const locked = yield* Deferred.make<void>()
          const unlock = yield* Deferred.make<void>()

          yield* cluster.sql`SELECT 1 FROM actor_outbox WHERE kind = 'intent' FOR UPDATE`.pipe(
            Effect.andThen(Deferred.succeed(locked, undefined)),
            Effect.andThen(Deferred.await(unlock)),
            cluster.sql.withTransaction,
            Effect.orDie,
            Effect.forkChild,
          )
          yield* Deferred.await(locked)

          const held = yield* placed("held", (placedOn) => placedOn === drained)
          expect(yield* deposit(survivor, held.id, 1)).toBe(1)

          const turning = yield* on(
            drained,
            ActorTest.use((test) => test.pauseNext("beforeCommit")),
          )

          const call = yield* deposit(survivor, held.id, 2).pipe(Effect.forkChild)
          yield* turning.reached

          const slowDatabase = yield* Effect.sleep("1500 millis").pipe(
            Effect.andThen(turning.release),
            Effect.andThen(Effect.sleep("3 seconds")),
            Effect.andThen(Deferred.succeed(unlock, undefined)),
            Effect.forkChild,
          )

          const started = yield* Clock.currentTimeMillis
          const report = yield* drain(drained, "500 millis")
          const took = (yield* Clock.currentTimeMillis) - started

          expect(report).toEqual({
            outcome: "deadline-expired",
            interruptedTurns: 1,
            interruptedEffects: 0,
          })
          expect(took < 500 + 1_000).toBe(true)

          yield* Fiber.join(slowDatabase)
          yield* receiving.release
          yield* cluster.shutdown(drained)
          expect(yield* Fiber.join(call)).toBe(3)

          yield* eventually(
            Effect.map(stateOf(survivor, receiver.id), (inspection) => inspection.outbox === 0),
            "the transfer to be delivered",
          )
          expect(yield* stateOf(survivor, receiver.id)).toMatchObject({
            state: { balance: 5 },
            receipts: 1,
          })
          expect(yield* stateOf(survivor, held.id)).toMatchObject({
            state: { balance: 3 },
            receipts: 2,
          })
          expect([...fixture.drain.runs.values()].reduce((sum, runs) => sum + runs, 0)).toBe(4)
        }),
      ),
  },
]
