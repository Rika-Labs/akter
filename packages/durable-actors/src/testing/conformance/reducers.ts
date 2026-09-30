import { Cause, Effect, Exit, Layer, Result, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, CommandConflict } from "../../index.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { decompress } from "../../runtime/storage/codec.ts"
import { VERSION_KEY } from "../../state/migration.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"

class Overflow extends Schema.TaggedError<Overflow>()("Overflow", { max: Schema.Int }) {}

const TallyV0 = { total: Schema.Int }

const TallyFields = {
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  label: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
}

const TallyState = Actor.state(TallyFields, {
  migrations: [
    Actor.migration(TallyV0, TallyFields, ({ total }) => ({ count: total, label: "migrated" })),
  ],
})

const reductions = { count: 0 }

const Add = Actor.reducer("Add", {
  state: TallyState,
  payload: Schema.Int,
  error: Overflow,
  reduce: (state, amount) => {
    reductions.count += 1

    return state.count + amount > 1_000
      ? Result.fail(Overflow.make({ max: 1_000 }))
      : Result.succeed({ ...state, count: state.count + amount })
  },
})

const Label = Actor.reducer("Label", {
  state: TallyState,
  payload: Schema.String,
  reduce: (state, label) => Result.succeed({ ...state, label }),
})

const Tick = Actor.reducer("Tick", {
  state: TallyState,
  payload: Schema.Int,
  reduce: (state, amount) => Result.succeed({ ...state, count: state.count + amount }),
  batch: { combine: (first, second) => first + second },
})

const Corrupt = Actor.reducer("Corrupt", {
  state: TallyState,
  payload: Schema.Boolean,
  reduce: (state, raise) => {
    if (raise) throw new Error("Reducer bug")

    return Result.succeed({ ...state, count: 0.5 })
  },
})

const BasketState = Actor.state({
  items: Schema.mutable(Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
})

const Put = Actor.reducer("Put", {
  state: BasketState,
  payload: Schema.String,
  reduce: (state, item) => {
    state.items.push(item)

    return Result.succeed(state)
  },
})

const Basket = Actor.make("Basket", { key: Schema.String, state: BasketState, api: { Put } })

const Tally = Actor.make("Tally", {
  key: Schema.String,
  state: TallyState,
  api: { Add, Label, Tick, Corrupt },
})

/** Registers the reducer actor: a reducer-only actor still registers through `toLayer`, with no handlers. */
export const reducerLayer = Layer.mergeAll(
  Tally.toLayer(Effect.succeed({})),
  Basket.toLayer(Effect.succeed({})),
)

const storedVersion = Effect.fnUntraced(function* (ref: ActorRef) {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ value: Uint8Array }>`SELECT value FROM actor_state
    WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}
      AND key = ${VERSION_KEY}`

  return row === undefined ? undefined : decompress(row.value)
}, Effect.orDie)

/** Reducer cases: one receipt per committed change, replay without reducing, and rejection of changed input under a reused command id. */
export const reducerConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "reducer commits changed state and one receipt, and replays without reducing again",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tally = yield* Tally.get("reducer-commit")
          const label = tally.Label("first")
          expect(yield* label).toEqual({ count: 0, label: "first" })
          expect(yield* test.inspect(tally.ref)).toEqual({
            generation: "1",
            state: { label: "first" },
            receipts: 1,
            outbox: 0,
            events: 0,
            jobs: 0,
          })
          const add = tally.Add(7)
          const before = reductions.count
          expect(yield* add).toEqual({ count: 7, label: "first" })
          expect(yield* add).toEqual({ count: 7, label: "first" })
          expect(yield* label).toEqual({ count: 0, label: "first" })
          expect(reductions.count - before).toBe(1)
          expect(yield* test.inspect(tally.ref)).toEqual({
            generation: "1",
            state: { count: 7, label: "first" },
            receipts: 2,
            outbox: 0,
            events: 0,
            jobs: 0,
          })
          expect(yield* storedVersion(tally.ref)).toBe("1")
        }),
      ),
  },
  {
    name: "reducer rejects changed input or another member under the same command id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tally = yield* Tally.get("reducer-conflict")
          const id = yield* (yield* Actors).mintCommandId
          expect(yield* tally.Add(3).pipe(Actor.commandId(id))).toEqual({ count: 3, label: "" })
          expect(yield* tally.Add(4).pipe(Actor.commandId(id), Effect.flip)).toMatchObject({
            reason: CommandConflict.make({ commandId: id }),
          })
          expect(yield* tally.Tick(3).pipe(Actor.commandId(id), Effect.flip)).toMatchObject({
            reason: CommandConflict.make({ commandId: id }),
          })
          expect(yield* test.inspect(tally.ref)).toMatchObject({
            state: { count: 3 },
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "failing reduce rolls back state and upcast writes and replays its declared error after conditions change",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tally = yield* Tally.get("reducer-failure")
          yield* test.seed(tally.ref, { total: 998 }, 0)
          const overflow = tally.Add(5)
          const before = reductions.count
          expect(yield* overflow.pipe(Effect.flip)).toEqual(Overflow.make({ max: 1_000 }))
          expect(yield* test.inspect(tally.ref)).toEqual({
            generation: "1",
            state: { total: 998 },
            receipts: 1,
            outbox: 0,
            events: 0,
            jobs: 0,
          })
          expect(yield* storedVersion(tally.ref)).toBe(undefined)
          expect(yield* tally.Add(-998)).toEqual({ count: 0, label: "migrated" })
          expect(yield* overflow.pipe(Effect.flip)).toEqual(Overflow.make({ max: 1_000 }))
          expect(reductions.count - before).toBe(2)
          expect(yield* test.inspect(tally.ref)).toEqual({
            generation: "1",
            state: { count: 0, label: "migrated" },
            receipts: 2,
            outbox: 0,
            events: 0,
            jobs: 0,
          })
          expect(yield* storedVersion(tally.ref)).toBe("1")
        }),
      ),
  },
  {
    name: "recovers reducer turns crashed beforeCommit and afterCommit with one transition each",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tally = yield* Tally.get("reducer-crash")
          const before = reductions.count
          yield* test.crashNext("beforeCommit")
          expect(yield* tally.Add(23)).toEqual({ count: 23, label: "" })
          expect(reductions.count - before).toBe(2)
          yield* test.crashNext("afterCommit")
          expect(yield* tally.Add(4)).toEqual({ count: 27, label: "" })
          expect(reductions.count - before).toBe(3)
          expect(yield* test.inspect(tally.ref)).toMatchObject({
            state: { count: 27 },
            receipts: 2,
          })
        }),
      ),
  },
  {
    name: "recovers failing reducer turns crashed beforeCommit and afterCommit with one terminal receipt each",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tally = yield* Tally.get("reducer-failure-crash")
          yield* tally.Add(999)
          const before = reductions.count
          const beforeCommit = tally.Add(2)
          yield* test.crashNext("beforeCommit")
          expect(yield* beforeCommit.pipe(Effect.flip)).toEqual(Overflow.make({ max: 1_000 }))
          expect(reductions.count - before).toBe(2)
          const afterCommit = tally.Add(3)
          yield* test.crashNext("afterCommit")
          expect(yield* afterCommit.pipe(Effect.flip)).toEqual(Overflow.make({ max: 1_000 }))
          expect(reductions.count - before).toBe(3)
          expect(yield* test.inspect(tally.ref)).toMatchObject({
            state: { count: 999 },
            receipts: 3,
          })
          yield* tally.Add(-999)
          expect(yield* beforeCommit.pipe(Effect.flip)).toEqual(Overflow.make({ max: 1_000 }))
          expect(yield* afterCommit.pipe(Effect.flip)).toEqual(Overflow.make({ max: 1_000 }))
          expect(reductions.count - before).toBe(4)
          expect(yield* test.inspect(tally.ref)).toMatchObject({
            state: { count: 0 },
            receipts: 4,
          })
        }),
      ),
  },
  {
    name: "commutative reducer runs as one receipted turn per call and replies void",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tally = yield* Tally.get("reducer-commutative")
          const tick = tally.Tick(2)
          expect(yield* tick).toBe(undefined)
          expect(yield* tick).toBe(undefined)
          expect(yield* tally.Tick(5)).toBe(undefined)
          expect(yield* test.inspect(tally.ref)).toMatchObject({
            state: { count: 7 },
            receipts: 2,
          })
        }),
      ),
  },
  {
    name: "a throwing reduce or an invalid returned state is a defect with no receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const tally = yield* Tally.get("reducer-defect")
          yield* tally.Add(1)

          for (const raise of [true, false]) {
            const exit = yield* tally.Corrupt(raise).pipe(Effect.exit)
            expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
          }

          expect(yield* test.inspect(tally.ref)).toMatchObject({
            state: { count: 1 },
            receipts: 1,
          })
          expect(yield* tally.Add(1)).toEqual({ count: 2, label: "" })
        }),
      ),
  },
  {
    name: "reducer that mutates its state argument still commits the change",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const basket = yield* Basket.get("reducer-mutation")
          expect(yield* basket.Put("a")).toEqual({ items: ["a"] })
          expect(yield* basket.Put("b")).toEqual({ items: ["a", "b"] })
          expect(yield* test.inspect(basket.ref)).toMatchObject({
            state: { items: ["a", "b"] },
            receipts: 2,
          })
        }),
      ),
  },
]

/** The reducer actors. */
export const reducerSuite: ConformanceSuite = {
  layer: () => reducerLayer,
}
