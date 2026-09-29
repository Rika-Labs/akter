import { pgTable, text } from "drizzle-orm/pg-core"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, Intent } from "../../index.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { BATCH_CAP } from "../../runtime/entity/mailbox.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

const marks = Actor.table(pgTable("batch_marks", { id: text("id").primaryKey() }))

class Refused extends Schema.TaggedError<Refused>()("Refused", { label: Schema.String }) {}

const Entry = Schema.Struct({ log: Schema.Array(Schema.String), marks: Schema.Finite })

const Append = Actor.command("Append", { input: Schema.String, output: Entry })

const Refuse = Actor.command("Refuse", { input: Schema.String, errors: [Refused] })

const Explode = Actor.command("Explode", { input: Schema.String })

const Noted = Actor.command("Noted", {})

/**
 * Each handler writes state and an owned row, so a batch of its commands
 * takes a savepoint per handler and threads state from one to the next.
 */
const Ledger = Actor.make("BatchLedger", {
  key: Schema.String,
  state: Actor.state({
    log: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  tables: [marks],
  api: { Append, Refuse, Explode },
  internal: { Noted },
})

// Handler runs per label, so a case can tell a rerun from a replay.
const runs = new Map<string, number>()

const ran = (label: string) => runs.set(label, (runs.get(label) ?? 0) + 1)

export const batchesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS batch_marks (
      routing_key bigint, tenant_id text, actor_id text, id text,
      PRIMARY KEY (routing_key, tenant_id, actor_id, id))`)

    return Ledger.toLayer(
      Effect.succeed({
        Append: Effect.fnUntraced(function* (label: string) {
          ran(label)
          const turn = yield* Ledger.Turn
          const log = [...turn.state.log, label]
          yield* turn.state.set({ log })
          yield* turn.rows(marks).insert({ id: label })

          return { log, marks: yield* turn.rows(marks).count() }
        }),
        Refuse: Effect.fnUntraced(function* (label: string) {
          ran(label)
          const turn = yield* Ledger.Turn
          yield* turn.state.set({ log: [...turn.state.log, label] })
          yield* turn.rows(marks).insert({ id: label })
          const self = yield* Ledger.intents(turn.id)
          yield* self.Noted().pipe(Intent.after("1 hour"))

          return yield* Refused.make({ label })
        }),
        Explode: Effect.fnUntraced(function* (label: string) {
          ran(label)
          const turn = yield* Ledger.Turn
          yield* turn.state.set({ log: [...turn.state.log, label] })

          return yield* Effect.die(new Error("Batch member defect"))
        }),
        Noted: () => Effect.void,
      }),
    )
  }).pipe(Effect.orDie),
)

/**
 * Sends each call only once the previous one is in the actor's mailbox, so
 * the calls are delivered in the order given.
 */
export const enqueue = Effect.fnUntraced(function* <A, R>(
  calls: ReadonlyArray<Effect.Effect<A, never, R>>,
) {
  const test = yield* ActorTest
  const fibers: Array<Fiber.Fiber<A>> = []

  for (const call of calls) {
    const queued = yield* test.pauseNext("queued")
    fibers.push(yield* Effect.forkChild(call))
    yield* queued.reached
    yield* queued.release
    // The hook resumes on the next tick, and the command joins a batch only once it has finished.
    yield* Effect.yieldNow
  }

  return fibers
})

/**
 * Holds the actor's next turn before its commit, so every call enqueued
 * meanwhile is already waiting when the actor takes its next batch.
 */
export const holding = Effect.fnUntraced(function* <A, E, R>(first: Effect.Effect<A, E, R>) {
  const test = yield* ActorTest
  const held = yield* test.pauseNext("beforeCommit")
  const fiber = yield* Effect.forkChild(first)
  yield* held.reached

  return { fiber, release: held.release }
})

/** The transaction that committed each receipt of `ref`, by command id. */
const transactions = Effect.fnUntraced(function* (ref: ActorRef) {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{ command_id: string; tx: string }>`
    SELECT command_id, xmin::text AS tx FROM actor_receipts
    WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

  return new Map(rows.map((row) => [row.command_id, row.tx] as const))
}, Effect.orDie)

const mint = Effect.fnUntraced(function* (count: number) {
  const actors = yield* Actors

  return yield* Effect.forEach(Array.from({ length: count }), () => actors.mintCommandId)
})

export const batchesConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "turn batch: waiting commands share one transaction in delivery order, each with its own receipt, and none replies before the commit",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ledger = yield* Ledger.get("order")
          const [lone, ...ids] = yield* mint(5)
          const labels = ["order-a", "order-b", "order-c", "order-d"]
          const first = yield* holding(ledger.Append("order-first").pipe(Actor.commandId(lone!)))

          const waiting = yield* enqueue(
            labels.map((label, index) =>
              ledger.Append(label).pipe(Actor.commandId(ids[index]!), Effect.orDie),
            ),
          )

          const commit = yield* test.pauseNext("beforeCommit")
          yield* first.release
          // The lone command ran with nothing waiting behind it and committed alone.
          expect(yield* Fiber.join(first.fiber)).toEqual({ log: ["order-first"], marks: 1 })
          yield* commit.reached

          // The batch is inside its transaction, and no caller has an answer yet.
          expect(waiting.map((fiber) => fiber.pollUnsafe())).toEqual(labels.map(() => undefined))
          yield* commit.release

          const replies = yield* Effect.forEach(waiting, Fiber.join)
          expect(replies).toEqual(
            labels.map((_, index) => ({
              log: ["order-first", ...labels.slice(0, index + 1)],
              marks: index + 2,
            })),
          )

          const committed = yield* transactions(ledger.ref)
          expect(new Set(ids.map((id) => committed.get(id))).size).toBe(1)
          expect(committed.get(ids[0]!)).not.toBe(committed.get(lone!))
          expect(yield* test.inspect(ledger.ref)).toMatchObject({
            state: { log: ["order-first", ...labels] },
            receipts: 5,
          })
        }),
      ),
  },
  {
    name: "turn batch: no batch exceeds the cap of waiting commands",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const ledger = yield* Ledger.get("cap")
          const total = BATCH_CAP + 8
          const [lone, ...ids] = yield* mint(total + 1)
          const first = yield* holding(ledger.Append("cap-first").pipe(Actor.commandId(lone!)))

          const waiting = yield* enqueue(
            ids.map((id, index) =>
              ledger.Append(`cap-${index}`).pipe(Actor.commandId(id), Effect.orDie),
            ),
          )

          yield* first.release
          yield* Fiber.join(first.fiber)
          const replies = yield* Effect.forEach(waiting, Fiber.join)
          expect(replies.at(-1)).toMatchObject({ marks: total + 1 })

          const committed = yield* transactions(ledger.ref)
          const sizes = new Map<string, number>()

          for (const id of ids) {
            const tx = committed.get(id)!
            sizes.set(tx, (sizes.get(tx) ?? 0) + 1)
          }

          expect([...sizes.values()].sort((a, b) => b - a)).toEqual([BATCH_CAP, 8])
        }),
      ),
  },
  {
    name: "turn batch: a declared failure discards only its own state, rows, and intents, and commits its failure receipt",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ledger = yield* Ledger.get("declared")
          const [lone, before, refused, after] = yield* mint(4)

          const first = yield* holding(ledger.Append("declared-first").pipe(Actor.commandId(lone!)))

          const [a, r, b] = yield* enqueue<Exit.Exit<unknown, unknown>, ActorTest | Actors>([
            ledger.Append("declared-a").pipe(Actor.commandId(before!), Effect.exit),
            ledger.Refuse("declared-r").pipe(Actor.commandId(refused!), Effect.exit),
            ledger.Append("declared-b").pipe(Actor.commandId(after!), Effect.exit),
          ])

          yield* first.release
          yield* Fiber.join(first.fiber)
          expect(yield* Fiber.join(a!)).toEqual(
            Exit.succeed({ log: ["declared-first", "declared-a"], marks: 2 }),
          )
          expect(yield* Fiber.join(r!)).toEqual(Exit.fail(Refused.make({ label: "declared-r" })))
          // The command after the failure sees neither its state nor its row.
          expect(yield* Fiber.join(b!)).toEqual(
            Exit.succeed({ log: ["declared-first", "declared-a", "declared-b"], marks: 3 }),
          )

          const committed = yield* transactions(ledger.ref)
          expect(new Set([before, refused, after].map((id) => committed.get(id!))).size).toBe(1)
          expect(yield* test.inspect(ledger.ref)).toMatchObject({
            state: { log: ["declared-first", "declared-a", "declared-b"] },
            receipts: 4,
            outbox: 0,
          })

          // The failure receipt replays without running the handler again.
          expect(
            yield* ledger.Refuse("declared-r").pipe(Actor.commandId(refused!), Effect.flip),
          ).toEqual(Refused.make({ label: "declared-r" }))
          expect(runs.get("declared-r")).toBe(1)
        }),
      ),
  },
  {
    name: "turn batch: a defect rolls the batch back, then its commands run one per transaction",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ledger = yield* Ledger.get("defect")
          const [lone, before, exploded, after] = yield* mint(4)
          const first = yield* holding(ledger.Append("defect-first").pipe(Actor.commandId(lone!)))

          const [a, x, b] = yield* enqueue<Exit.Exit<unknown, unknown>, ActorTest | Actors>([
            ledger.Append("defect-a").pipe(Actor.commandId(before!), Effect.exit),
            ledger.Explode("defect-x").pipe(Actor.commandId(exploded!), Effect.exit),
            ledger.Append("defect-b").pipe(Actor.commandId(after!), Effect.exit),
          ])

          yield* first.release
          yield* Fiber.join(first.fiber)
          expect(yield* Fiber.join(a!)).toEqual(
            Exit.succeed({ log: ["defect-first", "defect-a"], marks: 2 }),
          )
          const failed = yield* Fiber.join(x!)
          expect(Exit.isFailure(failed) && Cause.hasDies(failed.cause)).toBe(true)
          expect(yield* Fiber.join(b!)).toEqual(
            Exit.succeed({ log: ["defect-first", "defect-a", "defect-b"], marks: 3 }),
          )

          // The aborted batch stopped at the defect, so only the commands
          // before it ran twice: once in the batch and once alone.
          expect(["defect-a", "defect-x", "defect-b"].map((label) => runs.get(label))).toEqual([
            2, 2, 1,
          ])

          const committed = yield* transactions(ledger.ref)
          expect(committed.has(exploded!)).toBe(false)
          expect(committed.get(before!)).not.toBe(committed.get(after!))
          expect(yield* test.inspect(ledger.ref)).toMatchObject({
            state: { log: ["defect-first", "defect-a", "defect-b"] },
            receipts: 3,
          })
        }),
      ),
  },
  {
    name: "turn batch: a crash before the shared commit reruns each command alone, and a crash after it replays each receipt",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ledger = yield* Ledger.get("crash")
          const [lone, ...ids] = yield* mint(7)
          const before = ["crash-a", "crash-b", "crash-c"]
          const after = ["crash-d", "crash-e", "crash-f"]
          const first = yield* holding(ledger.Append("crash-first").pipe(Actor.commandId(lone!)))

          const early = yield* enqueue(
            before.map((label, index) =>
              ledger.Append(label).pipe(Actor.commandId(ids[index]!), Effect.orDie),
            ),
          )

          yield* test.crashNext("beforeCommit")
          yield* first.release
          yield* Fiber.join(first.fiber)
          yield* Effect.forEach(early, Fiber.join)

          // The crash came before the first handler's commit, so the others
          // never ran in the batch; nothing committed, and each command then
          // ran in a transaction of its own.
          expect(before.map((label) => runs.get(label))).toEqual([2, 1, 1])
          let committed = yield* transactions(ledger.ref)
          expect(new Set(ids.slice(0, 3).map((id) => committed.get(id))).size).toBe(3)

          const second = yield* holding(ledger.Append("crash-second"))

          const late = yield* enqueue(
            after.map((label, index) =>
              ledger.Append(label).pipe(Actor.commandId(ids[index + 3]!), Effect.orDie),
            ),
          )

          const shared = yield* test.pauseNext("beforeCommit")
          yield* second.release
          yield* Fiber.join(second.fiber)
          yield* shared.reached
          yield* test.crashNext("afterCommit")
          yield* shared.release
          const replies = yield* Effect.forEach(late, Fiber.join)
          expect(replies.at(-1)).toMatchObject({ marks: 8 })

          // The batch committed before the crash; its retries replayed.
          expect(after.map((label) => runs.get(label))).toEqual([1, 1, 1])
          committed = yield* transactions(ledger.ref)
          expect(new Set(ids.slice(3).map((id) => committed.get(id))).size).toBe(1)
          expect(yield* test.inspect(ledger.ref)).toMatchObject({ receipts: 8 })
        }),
      ),
  },
  {
    name: "turn batch: a retry waiting behind its original resolves through the original's receipt",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ledger = yield* Ledger.get("duplicate")
          const [id] = yield* mint(1)
          const first = yield* holding(ledger.Append("duplicate-first"))
          const call = ledger.Append("duplicate-x").pipe(Actor.commandId(id!), Effect.orDie)
          const [original, retry] = yield* enqueue([call, call])
          yield* first.release
          yield* Fiber.join(first.fiber)
          const reply = { log: ["duplicate-first", "duplicate-x"], marks: 2 }
          expect(yield* Fiber.join(original!)).toEqual(reply)
          expect(yield* Fiber.join(retry!)).toEqual(reply)
          expect(runs.get("duplicate-x")).toBe(1)
          expect(yield* test.inspect(ledger.ref)).toMatchObject({ receipts: 2 })
        }),
      ),
  },
]
