import { Cause, Duration, Effect, Exit, Fiber, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Intent, NotCreated, System, User } from "../../index.ts"
import type { ActorRef, Caller } from "../../identity/caller.ts"
import { CallerJson } from "../../runtime/turn/outbox.ts"
import { claimIntents } from "../../runtime/turn/relay.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"
import { CLAIM_LEASE } from "./outbox.ts"

/** One tick handler run, rolled back or not. */
interface Fired {
  readonly actor: string
  readonly id: string
  readonly commandId: string
  readonly source: string | undefined
}

// Cases use distinct actor ids, and a cluster's runners share this process.
const fired: Array<Fired> = []

const firedFor = (id: string) => fired.filter((run) => run.id === id)

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Open = Actor.command("Open")

const Refuse = Actor.command("Refuse", { errors: [Refused] })

const Stop = Actor.command("Stop")

const Hijack = Actor.command("Hijack", { input: Schema.Literals(["key", "cancel"]) })

const Beat = Actor.command("Beat")

const Yearly = Actor.command("Yearly")

const EVERY_MINUTE = "$cron:* * * * *"

const YEARLY = "$cron:0 0 1 1 *"

const SKIP = "10 minutes"

const Heartbeat = Actor.make("CronHeartbeat", {
  key: Schema.String,
  state: Actor.state({
    beats: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    ignored: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    stopped: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  api: { Open, Refuse, Stop, Hijack },
  internal: { Beat, Yearly },
  policy: {
    // Extra whitespace is normalized out of the timer key.
    cron: { "*  * * * *": Beat, "0 0 1 1 *": Yearly },
    cronSkipIfOlderThan: SKIP,
  },
})

const Peek = Actor.command("Peek")

const Gated = Actor.make("CronGated", {
  key: Schema.String,
  api: { Open, Peek },
  internal: { Beat },
  policy: { createdBy: Open, cron: { "* * * * *": Beat } },
})

const Pulse = Actor.command("Pulse")

const Beacon = Actor.make("CronBeacon", {
  key: Actor.singleton,
  state: Actor.state({ pulses: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: {},
  internal: { Pulse },
  policy: { cron: { "* * * * *": Pulse } },
})

const record = (ref: ActorRef, commandId: string, caller: Caller) =>
  Effect.sync(() => {
    fired.push({
      actor: ref.actor,
      id: ref.id,
      commandId,
      source: Schema.is(System)(caller) ? caller.source : undefined,
    })
  })

const HeartbeatLive = Heartbeat.toLayer(
  Effect.succeed({
    Open: () => Effect.void,
    Refuse: () => Effect.fail(Refused.make()),
    Stop: Effect.fnUntraced(function* () {
      yield* (yield* Heartbeat.Turn).state.set({ stopped: true })
    }),
    Hijack: Effect.fnUntraced(function* (how) {
      const turn = yield* Heartbeat.Turn

      if (how === "cancel") return yield* Intent.cancel(EVERY_MINUTE)

      yield* (yield* Heartbeat.intents(turn.ref.id)).Open().pipe(Intent.key(EVERY_MINUTE))
    }),
    // A claimed tick fires even after the actor stopped, so the handler checks.
    Beat: Effect.fnUntraced(function* () {
      const turn = yield* Heartbeat.Turn
      yield* record(turn.ref, turn.commandId, turn.caller)

      if (turn.state.stopped) yield* turn.state.set({ ignored: turn.state.ignored + 1 })
      else yield* turn.state.set({ beats: turn.state.beats + 1 })
    }),
    Yearly: () => Effect.void,
  }),
)

const GatedLive = Gated.toLayer(
  Effect.succeed({
    Open: () => Effect.void,
    Peek: () => Effect.void,
    Beat: Effect.fnUntraced(function* () {
      const turn = yield* Gated.Turn
      yield* record(turn.ref, turn.commandId, turn.caller)
    }),
  }),
)

const BeaconLive = Beacon.toLayer(
  Effect.succeed({
    Pulse: Effect.fnUntraced(function* () {
      const turn = yield* Beacon.Turn
      yield* record(turn.ref, turn.commandId, turn.caller)
      yield* turn.state.set({ pulses: turn.state.pulses + 1 })
    }),
  }),
)

const CronLive = Layer.mergeAll(HeartbeatLive, GatedLive)

/**
 * One runtime of the cron actors for one case. The singleton's minutely tick
 * joins only when asked, so it cannot take another case's fault injection, and
 * the case's ticks are removed after it, since PGlite shares one database.
 */
const withRuntime = <A, E>(
  environment: ConformanceEnvironment,
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof ActorTest.layer>>>,
  options: { readonly singleton?: boolean } = {},
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        Layer.fresh(
          (options.singleton === true ? Layer.merge(CronLive, BeaconLive) : CronLive).pipe(
            Layer.provideMerge(ActorTest.layer({ database, as: User.make({ subject: "alice" }) })),
            Layer.orDie,
          ),
        ),
      )

      return yield* body.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const test = yield* ActorTest
            yield* sql`DELETE FROM actor_outbox WHERE timer_key LIKE '$cron:%'
              AND (tenant_id = ${test.tenant} OR actor_type = 'CronBeacon')`
          }).pipe(Effect.orDie),
        ),
        Effect.provideContext(context),
      )
    }),
  )

interface TickRow {
  readonly timer_key: string
  readonly intent_id: string
  readonly command: string
  readonly caller: string
  readonly attempts: number
  readonly due: string
  readonly scheduled: string
}

const ticksOf = (ref: ActorRef) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<TickRow>`SELECT timer_key, intent_id, command, caller, attempts,
        due_at_ms::text AS due, scheduled_at_ms::text AS scheduled
      FROM actor_outbox WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor}
        AND actor_id = ${ref.id} AND timer_key LIKE '$cron:%'
      ORDER BY timer_key COLLATE "C" DESC`
  }).pipe(Effect.orDie)

const nowMs = ActorTest.use((test) => test.now).pipe(Effect.map((now) => now.epochMilliseconds))

const MINUTE = 60_000

/** Holds when `row` is the first whole minute after `now`. */
const nextMinuteAfter = (row: TickRow | undefined, now: number) =>
  row !== undefined &&
  Number(row.scheduled) === Number(row.due) &&
  Number(row.scheduled) === (Math.floor(now / MINUTE) + 1) * MINUTE

const receipts = (ref: ActorRef, command: string) =>
  ActorTest.use((test) => test.receiptsFor(ref, command))

const stateOf = (ref: ActorRef) =>
  ActorTest.use((test) => test.inspect(ref)).pipe(Effect.map(({ state }) => state))

export const cronConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "writes one tick per cron entry on the first committed turn, including a declared failure",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const heartbeat = yield* Heartbeat.get("first-turn")
          const before = yield* nowMs
          expect(Exit.isFailure(yield* heartbeat.Refuse().pipe(Effect.exit))).toBe(true)
          const rows = yield* ticksOf(heartbeat.ref)

          expect(rows.map((row) => [row.timer_key, row.command, row.attempts])).toEqual([
            [YEARLY, "Yearly", 0],
            [EVERY_MINUTE, "Beat", 0],
          ])
          expect(
            nextMinuteAfter(rows[1], before) || nextMinuteAfter(rows[1], before + MINUTE),
          ).toBe(true)
          const caller = yield* Schema.decodeEffect(CallerJson)(rows[1]!.caller)
          expect(Schema.is(System)(caller) ? [caller.source, caller.onBehalfOf] : caller).toEqual([
            "cron",
            undefined,
          ])

          // Later turns and later generations leave the pending ticks as they are.
          yield* heartbeat.Open()
          yield* ActorTest.use((test) => test.invalidate(heartbeat.ref))
          yield* heartbeat.Open()
          expect(yield* ticksOf(heartbeat.ref)).toEqual(rows)
        }),
      ),
  },
  {
    name: "writes no tick for a turn rejected NotCreated",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const gated = yield* Gated.get("gated")
          expect(yield* gated.Peek().pipe(Effect.flip)).toMatchObject({
            reason: NotCreated.make({}),
          })
          expect(yield* ticksOf(gated.ref)).toEqual([])
          yield* gated.Open()
          expect((yield* ticksOf(gated.ref)).map((row) => row.timer_key)).toEqual([
            "$cron:* * * * *",
          ])
        }),
      ),
  },
  {
    name: "fires a due tick once as System cron and rewrites its row to the next scheduled time",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const heartbeat = yield* Heartbeat.get("fires")
          yield* heartbeat.Open()
          const [, first] = yield* ticksOf(heartbeat.ref)
          yield* test.advance("1 minute")

          const runs = firedFor("fires")
          expect(runs).toEqual([
            { actor: "CronHeartbeat", id: "fires", commandId: first!.intent_id, source: "cron" },
          ])
          expect(yield* receipts(heartbeat.ref, "Beat")).toBe(1)
          const [, next] = yield* ticksOf(heartbeat.ref)
          expect(next!.intent_id).not.toBe(first!.intent_id)
          expect(next!.attempts).toBe(0)
          expect(nextMinuteAfter(next, yield* nowMs)).toBe(true)

          yield* test.advance("1 minute")
          expect(yield* stateOf(heartbeat.ref)).toMatchObject({ beats: 2 })
          expect(new Set(firedFor("fires").map((run) => run.commandId)).size).toBe(2)
          expect((yield* ticksOf(heartbeat.ref)).length).toBe(2)
        }),
      ),
  },
  {
    name: "fires once after downtime inside the skip window and skips a tick older than it",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const heartbeat = yield* Heartbeat.get("downtime")
          yield* heartbeat.Open()

          // Five missed minutes catch up with one tick, not five.
          yield* test.advance("5 minutes")
          expect(yield* stateOf(heartbeat.ref)).toMatchObject({ beats: 1 })
          expect(nextMinuteAfter((yield* ticksOf(heartbeat.ref))[1], yield* nowMs)).toBe(true)

          // A tick later than cronSkipIfOlderThan is skipped and rescheduled.
          yield* test.advance("15 minutes")
          expect(yield* stateOf(heartbeat.ref)).toMatchObject({ beats: 1 })
          expect(yield* receipts(heartbeat.ref, "Beat")).toBe(1)
          expect(nextMinuteAfter((yield* ticksOf(heartbeat.ref))[1], yield* nowMs)).toBe(true)

          yield* test.advance("1 minute")
          expect(yield* stateOf(heartbeat.ref)).toMatchObject({ beats: 2 })
        }),
      ),
  },
  {
    name: "rewrites a tick once after a crash between its receipt and the rewrite",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const heartbeat = yield* Heartbeat.get("crash-rewrite")
          yield* heartbeat.Open()
          const [, first] = yield* ticksOf(heartbeat.ref)
          yield* test.crashNext("beforeOutboxDelete")
          // Exactly to the tick, so its claim cannot expire within this advance.
          yield* test.advance(Number(first!.scheduled) - (yield* nowMs))

          // The receipt committed; the row still holds the fired tick's claim.
          expect(yield* receipts(heartbeat.ref, "Beat")).toBe(1)
          const [, claimed] = yield* ticksOf(heartbeat.ref)
          expect(claimed).toMatchObject({ intent_id: first!.intent_id, attempts: 1 })

          // Redelivery replays the receipt, then rewrites the row once.
          yield* test.advance(CLAIM_LEASE)
          expect(yield* receipts(heartbeat.ref, "Beat")).toBe(1)
          expect(yield* stateOf(heartbeat.ref)).toMatchObject({ beats: 1 })
          const rows = yield* ticksOf(heartbeat.ref)
          expect(rows.length).toBe(2)
          expect(rows[1]!.intent_id).not.toBe(first!.intent_id)
          expect(nextMinuteAfter(rows[1], yield* nowMs)).toBe(true)
        }),
      ),
  },
  {
    name: "fires a claimed tick once even after the actor stopped, and its handler rechecks state",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const heartbeat = yield* Heartbeat.get("claimed-then-stopped")
          yield* heartbeat.Open()
          const pause = yield* test.pauseNext("afterClaim")
          const advancing = yield* test.advance("1 minute").pipe(Effect.forkChild)
          yield* pause.reached
          yield* heartbeat.Stop()
          yield* pause.release
          yield* Fiber.join(advancing)

          // The handler saw `stopped` and counted no beat.
          expect(yield* stateOf(heartbeat.ref)).toEqual({ stopped: true, ignored: 1 })
          expect(firedFor("claimed-then-stopped").length).toBe(1)
        }),
      ),
  },
  {
    name: "rejects application intents that stage or cancel a $cron: key",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const heartbeat = yield* Heartbeat.get("reserved")
          yield* heartbeat.Open()
          const rows = yield* ticksOf(heartbeat.ref)

          for (const how of ["key", "cancel"] as const) {
            const exit = yield* heartbeat.Hijack(how).pipe(Effect.exit)
            expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("reserved for cron")
          }

          expect(yield* ticksOf(heartbeat.ref)).toEqual(rows)
        }),
      ),
  },
  {
    name: "restores a missing entry's tick on the actor's next activation",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const heartbeat = yield* Heartbeat.get("restored")
          yield* heartbeat.Open()
          const { ref } = heartbeat
          yield* sql`DELETE FROM actor_outbox WHERE tenant_id = ${ref.tenant}
            AND actor_type = ${ref.actor} AND actor_id = ${ref.id} AND timer_key = ${YEARLY}`.pipe(
            Effect.orDie,
          )

          // The same activation's turns write nothing; the next generation does.
          yield* heartbeat.Open()
          expect((yield* ticksOf(ref)).map((row) => row.timer_key)).toEqual([EVERY_MINUTE])
          yield* test.invalidate(ref)
          yield* heartbeat.Open()
          expect((yield* ticksOf(ref)).map((row) => row.timer_key)).toEqual([YEARLY, EVERY_MINUTE])
        }),
      ),
  },
  {
    name: "releases a tick whose entry left the policy and deletes it past the skip window",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const heartbeat = yield* Heartbeat.get("removed")
          yield* heartbeat.Open()
          const { ref } = heartbeat
          const removed = "$cron:5 4 * * *"

          // A tick an earlier deployment wrote for an entry this one dropped.
          yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, kind, bucket, due_at_ms,
              scheduled_at_ms, tenant_id, actor_type, actor_id, timer_key, target_type, target_id,
              command, payload, caller)
            SELECT routing_key, intent_id || '-removed', kind, bucket, ${yield* nowMs},
              ${yield* nowMs}, tenant_id, actor_type, actor_id, ${removed}, target_type,
              target_id, command, payload, caller
            FROM actor_outbox WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor}
              AND actor_id = ${ref.id} AND timer_key = ${EVERY_MINUTE}`.pipe(Effect.orDie)

          yield* test.advance(0)
          const released = (yield* ticksOf(ref)).find((row) => row.timer_key === removed)
          expect(released).toMatchObject({ attempts: 1 })
          expect(yield* receipts(ref, "Beat")).toBe(0)

          yield* test.advance("9 minutes")
          expect((yield* ticksOf(ref)).map((row) => row.timer_key)).toEqual([
            removed,
            YEARLY,
            EVERY_MINUTE,
          ])
          expect(yield* receipts(ref, "Beat")).toBe(1)

          yield* test.advance("2 minutes")
          expect((yield* ticksOf(ref)).map((row) => row.timer_key)).toEqual([YEARLY, EVERY_MINUTE])
          // Only the declared entry fired.
          expect(yield* receipts(ref, "Beat")).toBe(2)
        }),
      ),
  },
  {
    name: "writes a singleton's ticks in the default tenant at startup",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ref = (yield* Beacon.get()).ref
          expect(ref.tenant).toBe(test.tenant)
          const [row] = yield* ticksOf(ref)
          expect(row).toMatchObject({ timer_key: "$cron:* * * * *", command: "Pulse" })
          expect(yield* test.inspect(ref)).toMatchObject({ receipts: 0 })

          yield* test.advance("1 minute")
          expect(yield* receipts(ref, "Pulse")).toBe(1)
          expect(yield* stateOf(ref)).toMatchObject({ pulses: 1 })
        }),
        { singleton: true },
      ),
  },
  {
    name: "claims $cron: ticks only for actor types registered on the claiming runner",
    run: ({ expect, environment }) =>
      withRuntime(
        environment,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const heartbeat = yield* Heartbeat.get("claim-filter")
          yield* heartbeat.Open()
          const later = (yield* nowMs) + 400 * 24 * 60 * MINUTE

          const claim = (cronActors: ReadonlyArray<string>) =>
            claimIntents({
              sql,
              now: later,
              limit: 1000,
              leaseMs: 1000,
              maxBackoffMs: 1000,
              cronActors,
            }).pipe(
              Effect.orDie,
              Effect.map((rows) =>
                rows.filter((row) => row.kind === "intent" && row.target_id === "claim-filter"),
              ),
            )

          expect(yield* claim(["CronGated"])).toEqual([])
          const claimed = yield* claim(["CronHeartbeat"])
          expect(claimed.map((row) => row.command).toSorted()).toEqual(["Beat", "Yearly"])
        }),
      ),
  },
]

const EXPIRATION_SECONDS = 3

/** A poll far longer than any case, so only a runner's own `advance` claims its rows. */
const NO_POLL = { poll: "1 hour" } as const

const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  runners: number,
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: BeaconLive,
          as: User.make({ subject: "alice" }),
          relay: NO_POLL,
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

const advanceOn = (runner: number, duration: Duration.Input) =>
  on(
    runner,
    ActorTest.use((test) => test.advance(duration)),
  )

const beaconRef = on(0, Beacon.get().pipe(Effect.map((beacon) => beacon.ref)))

const pulsesOn = (runner: number, ref: ActorRef) => on(runner, receipts(ref, "Pulse"))

const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

const kill = (runner: number) =>
  ActorCluster.use((cluster) => cluster.kill(runner).pipe(Effect.andThen(cluster.ready)))

/** Multi-runner cases: real Postgres only, each on a fresh database and cluster. */
export const cronClusterConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "keeps one singleton tick row and fires one logical tick per scheduled time on three runners",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const ref = yield* beaconRef
          const before = fired.length
          // Every runner wrote its bootstrap ticks; the timer key kept one.
          expect((yield* on(1, ticksOf(ref))).length).toBe(1)

          for (const round of [1, 2, 3]) {
            yield* Effect.forEach([0, 1, 2], (runner) => advanceOn(runner, "1 minute"), {
              concurrency: "unbounded",
              discard: true,
            })
            yield* eventually(
              pulsesOn(2, ref).pipe(Effect.map((count) => count === round)),
              `tick ${round}`,
            )
          }

          const runs = fired.slice(before).filter((run) => run.id === ref.id)
          expect(new Set(runs.map((run) => run.commandId)).size).toBe(3)
          expect(yield* pulsesOn(0, ref)).toBe(3)
          expect((yield* on(0, ticksOf(ref))).length).toBe(1)
        }),
      ),
  },
  ...(["afterClaim", "beforeOutboxDelete"] as const).map((point): ConformanceCase => ({
    name: `fires a tick once when the runner delivering it is killed at ${point}`,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const ref = yield* beaconRef
          const [first] = yield* on(1, ticksOf(ref))

          const pause = yield* on(
            0,
            ActorTest.use((test) => test.pauseNext(point)),
          )

          yield* advanceOn(0, "1 minute").pipe(Effect.forkChild)
          yield* pause.reached
          yield* kill(0)

          // The dead runner's claim holds the row until its lease ends.
          yield* advanceOn(1, "1 minute")
          yield* advanceOn(2, "1 minute")
          const held = yield* on(1, ticksOf(ref))
          expect(held).toMatchObject([{ intent_id: first!.intent_id, attempts: 1 }])
          expect(yield* pulsesOn(1, ref)).toBe(point === "afterClaim" ? 0 : 1)

          yield* advanceOn(1, CLAIM_LEASE)
          yield* advanceOn(2, CLAIM_LEASE)
          yield* eventually(
            on(1, ticksOf(ref)).pipe(
              Effect.map((rows) => rows.length === 1 && rows[0]!.intent_id !== first!.intent_id),
            ),
            "the tick's rewrite",
          )
          expect(yield* pulsesOn(1, ref)).toBe(1)
          expect(yield* on(2, stateOf(ref))).toMatchObject({ pulses: 1 })
          expect((yield* on(1, ticksOf(ref)))[0]).toMatchObject({ attempts: 0 })
        }),
      ),
  })),
  {
    name: "keeps a singleton's ticks firing after its runner is killed",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const ref = yield* beaconRef
          const owner = (yield* cluster.owner(ref))!
          const survivor = (owner + 1) % 3
          yield* kill(owner)

          yield* advanceOn(survivor, "1 minute")
          yield* eventually(
            pulsesOn(survivor, ref).pipe(Effect.map((count) => count === 1)),
            "a tick on a survivor",
          )
          expect((yield* on(survivor, ticksOf(ref))).length).toBe(1)
        }),
      ),
  },
]
