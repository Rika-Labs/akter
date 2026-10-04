import {
  Cause,
  Clock,
  Crypto,
  Deferred,
  Duration,
  Option,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import type { Scope } from "effect"
import { SqlClient } from "effect/sql"
import { Actor, type ActorError, Actors } from "../../index.ts"
import { TurnGroupSettings } from "../../runtime/turn/group.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"
import { transactions } from "./batches.ts"

class Refused extends Schema.TaggedError<Refused>()("GroupRefused", {}) {}

const Add = Actor.command("Add", { payload: Schema.Finite, success: Schema.Finite })

const Refuse = Actor.command("Refuse", { payload: Schema.Finite, error: Refused })

const Explode = Actor.command("Explode", { payload: Schema.Finite })

/**
 * Warm actors without owned tables, so concurrent turns of different ones
 * share a group. A short execution timeout lets a case interrupt one member.
 */
const Tally = Actor.make("GroupTally", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Add, Refuse, Explode },
  policy: { executionTimeout: "2 seconds" },
})

/** Handler runs per actor id. */
const runs = new Map<string, number>()

const ran = Effect.gen(function* () {
  const turn = yield* Tally.Turn
  runs.set(turn.id, (runs.get(turn.id) ?? 0) + 1)

  return turn
})

const tallyLive = Tally.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* ran
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
    Refuse: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* ran
      yield* turn.state.set({ count: turn.state.count + amount })

      return yield* Refused.make({})
    }),
    Explode: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* ran
      yield* turn.state.set({ count: turn.state.count + amount })

      return yield* Effect.die(new Error("Group member defect"))
    }),
  }),
)

/** Runs `body` on a runner over a fresh database whose closed groups wait `wait` for members. */
const withGroups = <A, E>(
  environment: ConformanceEnvironment,
  wait: Duration.Input,
  body: Effect.Effect<A, E, Actors | ActorTest | SqlClient.SqlClient | Scope.Scope>,
) =>
  environment.run(Effect.service(Crypto.Crypto)).then((crypto) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(environment.stop, () => environment.restart)
        const database = yield* environment.freshDatabase

        if (!Redacted.isRedacted(database))
          return yield* Effect.die(new Error("The group cases need a Postgres database"))

        const context = yield* Layer.build(
          tallyLive.pipe(
            Layer.provideMerge(ActorTest.layer({ database })),
            Layer.provide(
              Layer.succeed(TurnGroupSettings, { wait: Duration.fromInputUnsafe(wait) }),
            ),
          ),
        )

        return yield* body.pipe(Effect.provideContext(context))
      }).pipe(Effect.scoped, Effect.provideService(Crypto.Crypto, crypto)),
    ),
  )

type Handle = Effect.Success<ReturnType<typeof Tally.get>>

interface Call {
  readonly id: string
  readonly commandId: string
  readonly call: (tally: Handle) => Effect.Effect<unknown, ActorError | Refused>
}

/**
 * Warms each actor with one `Add(1)`, then sends every call at once and holds
 * each turn before its handler until all of them reached it, so they joined
 * one group before any member handed over its writes.
 */
const together = Effect.fnUntraced(function* (calls: ReadonlyArray<Call>) {
  const test = yield* ActorTest

  for (const { id } of calls) {
    const warm = yield* (yield* Tally.get(id)).Add(1)

    if (warm !== 1) return yield* Effect.die(new Error(`Warming ${id} returned ${warm}`))
  }

  const pauses = yield* Effect.forEach(calls, ({ commandId }) =>
    test.pauseNext("beforeHandler", { commandId }),
  )

  const fibers = yield* Effect.forEach(calls, ({ id, commandId, call }) =>
    Effect.flatMap(Tally.get(id), (tally) =>
      Effect.forkChild(call(tally).pipe(Actor.commandId(commandId), Effect.exit)),
    ),
  )

  yield* Effect.forEach(pauses, ({ reached }) => reached, { concurrency: "unbounded" })

  return { fibers, release: Effect.forEach(pauses, ({ release }) => release, { discard: true }) }
})

const mintAll = Effect.fnUntraced(function* (count: number) {
  const actors = yield* Actors

  return yield* Effect.forEach(Array.from({ length: count }), () => actors.mintCommandId)
})

/** The transaction that committed `commandId` on actor `id`, if it committed. */
const committedIn = Effect.fnUntraced(function* (id: string, commandId: string) {
  return (yield* transactions((yield* Tally.get(id)).ref)).get(commandId)
})

/**
 * Waits until a turn waits for a generation row lock, which only a group
 * still holding a departed member's fenced read can hold here.
 */
const lockWaiter = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ waiting: number }>`SELECT count(*)::int AS waiting
    FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`

  if (row!.waiting === 0) return yield* Effect.fail("no lock waiter yet")
}).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.orDie)

const stateOf = Effect.fnUntraced(function* (id: string) {
  const test = yield* ActorTest

  return (yield* test.inspect((yield* Tally.get(id)).ref)).state
})

/**
 * Group commit cases: warm turns of different actors share one transaction,
 * and each keeps its own fence, receipt, failure, interruption and statement
 * outcome.
 */
export const groupsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "group commit: concurrent warm turns commit in one transaction; a declared failure keeps only its receipt and a defect leaves only itself out",
    requiresIndependentConnections: true,
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withGroups(
        environment,
        "10 seconds",
        Effect.gen(function* () {
          const [a, b, refused, exploded, e] = yield* mintAll(5)
          const ids = ["one", "two", "refused", "exploded", "five"].map((id) => `group-${id}`)
          const { fibers, release } = yield* together([
            { id: ids[0]!, commandId: a!, call: (tally) => tally.Add(10) },
            { id: ids[1]!, commandId: b!, call: (tally) => tally.Add(20) },
            { id: ids[2]!, commandId: refused!, call: (tally) => tally.Refuse(30) },
            { id: ids[3]!, commandId: exploded!, call: (tally) => tally.Explode(40) },
            { id: ids[4]!, commandId: e!, call: (tally) => tally.Add(50) },
          ])

          runs.clear()
          yield* release
          const [one, two, refusal, defect, five] = yield* Effect.forEach(fibers, Fiber.join)

          expect([one, two, five]).toEqual([Exit.succeed(11), Exit.succeed(21), Exit.succeed(51)])
          expect(Exit.isFailure(refusal!) && Cause.squash(refusal.cause)).toBeInstanceOf(Refused)
          expect(Exit.isFailure(defect!) && Cause.hasDies(defect.cause)).toBe(true)

          const shared = yield* committedIn(ids[0]!, a!)
          expect(shared).not.toBe(undefined)
          expect(yield* committedIn(ids[1]!, b!)).toBe(shared)
          expect(yield* committedIn(ids[2]!, refused!)).toBe(shared)
          expect(yield* committedIn(ids[4]!, e!)).toBe(shared)
          expect(yield* committedIn(ids[3]!, exploded!)).toBe(undefined)

          expect(yield* stateOf(ids[2]!)).toEqual({ count: 1 })
          expect(yield* stateOf(ids[3]!)).toEqual({ count: 1 })
          expect(ids.map((id) => runs.get(id))).toEqual([1, 1, 1, 1, 1])
        }),
      ),
  },
  {
    name: "group commit: a member fenced by a newer generation leaves its group before its handler runs, runs again alone, and its neighbours commit together",
    requiresIndependentConnections: true,
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withGroups(
        environment,
        "10 seconds",
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const [a, fenced, c] = yield* mintAll(3)
          const ids = ["group-left", "group-fenced", "group-right"]

          for (const id of ids) expect(yield* (yield* Tally.get(id)).Add(1)).toBe(1)

          yield* sql`UPDATE actor_generations SET generation = generation + 1
            WHERE actor_type = 'GroupTally' AND actor_id = ${ids[1]!}`

          const pauses = yield* Effect.forEach([a!, c!], (commandId) =>
            test.pauseNext("beforeHandler", { commandId }),
          )

          runs.clear()

          const fibers = yield* Effect.forEach(
            [
              [ids[0]!, a!],
              [ids[1]!, fenced!],
              [ids[2]!, c!],
            ] as const,
            ([id, commandId]) =>
              Effect.flatMap(Tally.get(id), (tally) =>
                Effect.forkChild(tally.Add(1).pipe(Actor.commandId(commandId))),
              ),
          )

          yield* Effect.forEach(pauses, ({ reached }) => reached, { concurrency: "unbounded" })
          yield* lockWaiter
          expect(runs.size).toBe(0)
          yield* Effect.forEach(pauses, ({ release }) => release, { discard: true })

          expect(yield* Effect.forEach(fibers, Fiber.join)).toEqual([2, 2, 2])

          const shared = yield* committedIn(ids[0]!, a!)
          expect(yield* committedIn(ids[2]!, c!)).toBe(shared)
          expect(yield* committedIn(ids[1]!, fenced!)).not.toBe(shared)
          expect(ids.map((id) => runs.get(id))).toEqual([1, 1, 1])
          expect(yield* test.receiptsFor((yield* Tally.get(ids[1]!)).ref, "Add")).toBe(2)
        }),
      ),
  },
  {
    name: "group commit: a member interrupted after handing over its writes is withdrawn, and the group commits its neighbour",
    requiresIndependentConnections: true,
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withGroups(
        environment,
        "30 seconds",
        Effect.gen(function* () {
          const test = yield* ActorTest
          const [early, late] = yield* mintAll(2)
          const ids = ["group-early", "group-late"]

          for (const id of ids) expect(yield* (yield* Tally.get(id)).Add(1)).toBe(1)

          const lateHeld = yield* test.pauseNext("beforeHandler", { commandId: late! })
          const earlyHeld = yield* test.pauseNext("beforeHandler", { commandId: early! })
          runs.clear()

          const earlyCall = yield* Effect.forkChild(
            (yield* Tally.get(ids[0]!)).Add(10).pipe(Actor.commandId(early!)),
          )
          yield* earlyHeld.reached
          yield* Effect.sleep("1 second")

          const lateCall = yield* Effect.forkChild(
            (yield* Tally.get(ids[1]!)).Add(20).pipe(Actor.commandId(late!)),
          )
          yield* lateHeld.reached
          yield* earlyHeld.release
          yield* lockWaiter

          expect(runs.get(ids[0]!)).toBe(1)
          expect(yield* committedIn(ids[0]!, early!)).toBe(undefined)
          expect(yield* stateOf(ids[0]!)).toEqual({ count: 1 })

          yield* lateHeld.release
          expect(yield* Fiber.join(lateCall)).toBe(21)
          expect(yield* Fiber.join(earlyCall)).toBe(11)

          expect(runs.get(ids[0]!)).toBe(2)
          expect(runs.get(ids[1]!)).toBe(1)
          expect(yield* committedIn(ids[0]!, early!)).not.toBe(yield* committedIn(ids[1]!, late!))
          expect(yield* stateOf(ids[0]!)).toEqual({ count: 11 })
        }),
      ),
  },
  {
    name: "group commit: a member still running when the group's wait ends is evicted, runs again alone, and commits once",
    requiresIndependentConnections: true,
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withGroups(
        environment,
        "50 millis",
        Effect.gen(function* () {
          const test = yield* ActorTest
          const [quick, slow] = yield* mintAll(2)
          const ids = ["group-quick", "group-slow"]
          const { fibers, release } = yield* together([
            { id: ids[0]!, commandId: quick!, call: (tally) => tally.Add(10) },
            { id: ids[1]!, commandId: slow!, call: (tally) => tally.Add(20) },
          ])

          const slowHeld = yield* test.pauseNext("beforeCommit", { commandId: slow! })
          runs.clear()
          yield* release
          yield* slowHeld.reached

          expect(yield* Fiber.join(fibers[0]!)).toEqual(Exit.succeed(11))
          expect(yield* committedIn(ids[1]!, slow!)).toBe(undefined)

          yield* Effect.sleep("200 millis")
          yield* slowHeld.release
          expect(yield* Fiber.join(fibers[1]!)).toEqual(Exit.succeed(21))

          expect(runs.get(ids[0]!)).toBe(1)
          expect(runs.get(ids[1]!)).toBe(2)
          expect(yield* committedIn(ids[1]!, slow!)).not.toBe(yield* committedIn(ids[0]!, quick!))
          expect(yield* test.receiptsFor((yield* Tally.get(ids[1]!)).ref, "Add")).toBe(2)
          expect(yield* stateOf(ids[1]!)).toEqual({ count: 21 })
        }),
      ),
  },
  {
    name: "group commit: a statement error in one member's writes rolls the group back; that member fails and its neighbours commit alone, once each",
    requiresIndependentConnections: true,
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withGroups(
        environment,
        "10 seconds",
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [poisoned, b, c] = yield* mintAll(3)
          const ids = ["group-poisoned", "group-b", "group-c"]

          yield* sql.unsafe(`CREATE FUNCTION group_poison() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.command_id = '${poisoned!}' THEN RAISE EXCEPTION 'poisoned receipt'; END IF;
              RETURN NEW;
            END $$`)
          yield* sql.unsafe(`CREATE TRIGGER group_poison BEFORE INSERT ON actor_receipts
            FOR EACH ROW EXECUTE FUNCTION group_poison()`)

          const { fibers, release } = yield* together([
            { id: ids[0]!, commandId: poisoned!, call: (tally) => tally.Add(10) },
            { id: ids[1]!, commandId: b!, call: (tally) => tally.Add(20) },
            { id: ids[2]!, commandId: c!, call: (tally) => tally.Add(30) },
          ])

          runs.clear()
          yield* release
          const [failed, second, third] = yield* Effect.forEach(fibers, Fiber.join)

          expect(Exit.isFailure(failed!) && Cause.hasDies(failed.cause)).toBe(true)
          expect([second, third]).toEqual([Exit.succeed(21), Exit.succeed(31)])
          expect(runs.get(ids[1]!)).toBe(2)
          expect(runs.get(ids[2]!)).toBe(2)
          expect(yield* committedIn(ids[0]!, poisoned!)).toBe(undefined)
          expect(yield* committedIn(ids[1]!, b!)).not.toBe(yield* committedIn(ids[2]!, c!))
          expect(yield* stateOf(ids[0]!)).toEqual({ count: 1 })
          expect(yield* stateOf(ids[1]!)).toEqual({ count: 21 })
        }),
      ),
  },
  {
    name: "group commit: a member whose next batch rides behind the COMMIT, interrupted while that COMMIT runs, never gets the session back with its chained transaction open",
    requiresIndependentConnections: true,
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withGroups(
        environment,
        "30 seconds",
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const [a1, a2, b1] = yield* mintAll(3)
          const ids = ["group-handoff", "group-neighbour"]

          for (const id of ids) expect(yield* (yield* Tally.get(id)).Add(1)).toBe(1)

          yield* sql.unsafe(`CREATE FUNCTION group_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(1.4); RETURN NULL; END $$`)
          yield* sql.unsafe(`CREATE CONSTRAINT TRIGGER group_slow_commit AFTER INSERT ON actor_receipts
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.command_id = '${a1!}')
            EXECUTE FUNCTION group_slow_commit()`)

          const a1Held = yield* test.pauseNext("beforeHandler", { commandId: a1! })
          const b1Held = yield* test.pauseNext("beforeHandler", { commandId: b1! })
          const handoff = yield* Tally.get(ids[0]!)
          const first = yield* Effect.forkChild(
            handoff.Add(10).pipe(Actor.commandId(a1!), Effect.exit),
          )
          yield* a1Held.reached
          const second = yield* Effect.forkChild(
            handoff.Add(100).pipe(Actor.commandId(a2!), Effect.exit),
          )
          yield* Effect.sleep("900 millis")
          const neighbour = yield* Effect.forkChild(
            (yield* Tally.get(ids[1]!)).Add(20).pipe(Actor.commandId(b1!), Effect.exit),
          )
          yield* b1Held.reached
          yield* a1Held.release
          yield* b1Held.release

          expect(yield* Fiber.join(neighbour)).toEqual(Exit.succeed(21))

          const seen: Array<string> = []
          const deadline = (yield* Clock.currentTimeMillis) + 4_000

          while ((yield* Clock.currentTimeMillis) < deadline) {
            const rows = yield* sql<{ pid: number; state: string; waiting: string | null }>`
              SELECT pid, state, wait_event_type AS waiting FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND clock_timestamp() - state_change > interval '300 milliseconds'
                AND (state = 'idle in transaction' OR wait_event_type = 'Lock')`
            for (const row of rows) seen.push(`${row.pid}:${row.state}:${row.waiting}`)
            yield* Effect.sleep("25 millis")
          }

          expect([...new Set(seen)]).toEqual([])
          expect(yield* Fiber.join(first)).toEqual(Exit.succeed(11))
          expect(yield* Fiber.join(second)).toEqual(Exit.succeed(111))
          expect(yield* stateOf(ids[0]!)).toEqual({ count: 111 })
          expect(yield* test.receiptsFor(handoff.ref, "Add")).toBe(3)
        }),
      ),
  },
  {
    name: "group commit: a member whose generation row another transaction holds is skipped, and its neighbours commit together without waiting for that lock",
    requiresIndependentConnections: true,
    requiresFreshDatabase: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      withGroups(
        environment,
        "10 seconds",
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const [l, x, y] = yield* mintAll(3)
          const ids = ["group-locked", "group-x", "group-y"]

          for (const id of ids) expect(yield* (yield* Tally.get(id)).Add(1)).toBe(1)

          const locked = Deferred.makeUnsafe<void>()
          const unlock = Deferred.makeUnsafe<void>()
          const holder = yield* Effect.forkChild(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT 1 FROM actor_generations
                  WHERE actor_type = 'GroupTally' AND actor_id = ${ids[0]!} FOR UPDATE`
                yield* Deferred.succeed(locked, undefined)
                yield* Deferred.await(unlock)
              }),
            ),
          )
          yield* Deferred.await(locked)

          const pauses = yield* Effect.forEach([x!, y!], (commandId) =>
            test.pauseNext("beforeHandler", { commandId }),
          )
          runs.clear()
          const lockedCall = yield* Effect.forkChild(
            (yield* Tally.get(ids[0]!)).Add(5).pipe(Actor.commandId(l!), Effect.exit),
          )
          yield* Effect.sleep("20 millis")
          const others = yield* Effect.forEach(
            [
              [ids[1]!, x!],
              [ids[2]!, y!],
            ] as const,
            ([id, commandId]) =>
              Effect.flatMap(Tally.get(id), (tally) =>
                Effect.forkChild(tally.Add(5).pipe(Actor.commandId(commandId), Effect.exit)),
              ),
          )
          const reached = yield* Effect.forEach(pauses, ({ reached }) => reached, {
            concurrency: "unbounded",
          }).pipe(Effect.timeoutOption("1500 millis"))
          expect(reached._tag).toBe("Some")
          yield* Effect.forEach(pauses, ({ release }) => release, { discard: true })

          const answered = yield* Effect.forEach(others, Fiber.join).pipe(
            Effect.timeoutOption("1500 millis"),
          )
          expect(answered).toEqual(Option.some([Exit.succeed(6), Exit.succeed(6)]))
          expect(yield* committedIn(ids[1]!, x!)).toBe(yield* committedIn(ids[2]!, y!))

          yield* Deferred.succeed(unlock, undefined)
          yield* Fiber.join(holder)
          expect(yield* Fiber.join(lockedCall)).toEqual(Exit.succeed(6))
          expect(yield* committedIn(ids[0]!, l!)).not.toBe(yield* committedIn(ids[1]!, x!))
        }),
      ),
  },
]
