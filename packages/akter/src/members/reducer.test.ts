import { Effect, type Layer, Result, Schema } from "effect"
import { Arbitrary } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor, type ActorError } from "../index.ts"
import type { InternalActors } from "../runtime/actors.ts"

class Overflow extends Schema.TaggedError<Overflow>()("Overflow", { max: Schema.Int }) {}

const CounterState = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

const Increment = Actor.reducer("Increment", {
  state: CounterState,
  payload: Schema.Int,
  error: Overflow,
  reduce: (state, amount) =>
    state.count + amount > 1_000
      ? Result.fail(Overflow.make({ max: 1_000 }))
      : Result.succeed({ count: state.count + amount }),
})

const Add = Actor.reducer("Add", {
  state: CounterState,
  payload: Schema.Int,
  reduce: (state, amount) => Result.succeed({ count: state.count + amount }),
  batch: { combine: (first, second) => first + second },
})

const Reset = Actor.command("Reset")

describe("reducer declarations", () => {
  it("gives reducers a command-shaped handle method that replies with the new state", () => {
    const Counter = Actor.make("Counter", {
      state: CounterState,
      api: { Increment, Add, Reset },
    })

    type Public = Effect.Success<ReturnType<typeof Counter.create>>

    type Reason<F extends (...args: never[]) => Effect.Effect<unknown, unknown>> = Extract<
      Effect.Error<ReturnType<F>>,
      ActorError
    >["reason"]["_tag"]

    expectTypeOf<Parameters<Public["Increment"]>>().toEqualTypeOf<[payload: number]>()
    expectTypeOf<Effect.Success<ReturnType<Public["Increment"]>>>().toEqualTypeOf<{
      readonly count: number
    }>()
    expectTypeOf<
      Exclude<Effect.Error<ReturnType<Public["Increment"]>>, ActorError>
    >().toEqualTypeOf<Overflow>()
    expectTypeOf<Reason<Public["Increment"]>>().toEqualTypeOf<Reason<Public["Reset"]>>()
    expectTypeOf<Effect.Success<ReturnType<Public["Add"]>>>().toEqualTypeOf<void>()
    expectTypeOf<
      Exclude<Effect.Error<ReturnType<Public["Add"]>>, ActorError>
    >().toEqualTypeOf<never>()
    expect(Increment.kind).toBe("reducer")
    expect(Add.error).toBe(Schema.Never)
  })

  it("gives reducers no handler in toLayer", () => {
    const Counter = Actor.make("Counter", { state: CounterState, api: { Increment, Reset } })

    const _reducerHandler: Layer.Layer<never, never, InternalActors> = Counter.toLayer({
      Reset: () => Effect.void,
      // @ts-expect-error a reducer has no handler
      Increment: () => Effect.void,
    })

    expectTypeOf(Counter.toLayer(Effect.succeed({ Reset: () => Effect.void }))).toEqualTypeOf<
      Layer.Layer<never, never, InternalActors>
    >()

    const Reducers = Actor.make("Reducers", { state: CounterState, api: { Increment, Add } })

    expectTypeOf(Reducers.toLayer(Effect.succeed({}))).toEqualTypeOf<
      Layer.Layer<never, never, InternalActors>
    >()

    const _serverHandler: Layer.Layer<never, never, InternalActors> = Counter.toLayer(
      // @ts-expect-error a reducer has no server handler
      Effect.succeed({
        Reset: () => Effect.void,
        Increment: (amount: number) => Effect.succeed({ count: amount }),
      }),
    )
  })

  it("requires a reducer's state to be its actor's state", () => {
    const Other = Actor.state({ total: Schema.Int })
    const Wider = Actor.state({ count: Schema.Int, extra: Schema.String })

    expect(() =>
      Actor.make("Mismatch", {
        state: Other,
        // @ts-expect-error the reducer transforms a different state
        api: { Increment },
      }),
    ).toThrow("must declare its actor's state")
    expect(() =>
      Actor.make("Wider", {
        state: Wider,
        // @ts-expect-error the reducer's state lacks a key the actor stores
        api: { Increment },
      }),
    ).toThrow("must declare its actor's state")
    expect(() =>
      // @ts-expect-error an actor without state cannot host a reducer
      Actor.make("Stateless", { api: { Increment } }),
    ).toThrow("must declare its actor's state")
    expect(() =>
      // @ts-expect-error reducers are public members, never internal commands
      Actor.make("Hidden", { state: CounterState, api: {}, internal: { Increment } }),
    ).toThrow("commands")
  })

  it("keeps batched reducers void and free of declared errors", () => {
    expectTypeOf(Add.success).toEqualTypeOf<Schema.Void>()
    expectTypeOf(Add.error).toEqualTypeOf<Schema.Never>()

    const combine = (first: number, second: number) => first + second

    const failing = {
      state: CounterState,
      payload: Schema.Int,
      reduce: () => Result.fail(Overflow.make({ max: 0 })),
      batch: { combine },
    }

    // @ts-expect-error a batched reducer cannot fail
    Actor.reducer("Failing", failing)

    const declaring = {
      state: CounterState,
      payload: Schema.Int,
      error: Overflow,
      reduce: (state: { readonly count: number }) => Result.succeed(state),
      batch: { combine },
    }

    // @ts-expect-error a batched reducer declares no error
    expect(() => Actor.reducer("Declaring", declaring)).toThrow("cannot declare an error")

    Actor.reducer("Undeclared", {
      state: CounterState,
      payload: Schema.Int,
      // @ts-expect-error a reducer can only fail with a declared error
      reduce: () => Result.fail(Overflow.make({ max: 0 })),
    })
  })

  it("satisfies the merge law reduce(reduce(s, a), b) = reduce(s, combine(a, b))", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const int = Arbitrary.schema(Schema.Int)

        const result = yield* Arbitrary.checkEffect(
          Arbitrary.all([int, int, int]),
          ([count, first, second]) => {
            const sequential = Result.flatMap(Add.reduce({ count }, first), (state) =>
              Add.reduce(state, second),
            )

            const merged = Add.reduce({ count }, Add.batch!.combine(first, second))

            return (
              Result.isSuccess(sequential) &&
              Result.isSuccess(merged) &&
              sequential.success.count === merged.success.count
            )
          },
          { runs: 1_000 },
        )

        expect(result._tag).toBe("Passed")
      }),
    ))
})
