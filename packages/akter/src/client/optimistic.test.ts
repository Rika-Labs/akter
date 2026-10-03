import { Effect, Predicate, Result, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OptimisticReducer } from "../actor/served.ts"
import { Optimistic } from "./optimistic.ts"

const reducer: OptimisticReducer = {
  state: Schema.Struct({ count: Schema.Int }),
  reduce: (state, by) => Result.succeed({ count: Number(state["count"]) + Number(by) }),
  commutative: false,
}

/** Lets settled promises' callbacks run. */
const settle = Effect.sleep("1 millis")

describe("Optimistic", () => {
  beforeEach(() => {
    if (globalThis.reportError === undefined) vi.stubGlobal("reportError", () => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("reports a throwing listener and still adds the input and calls the others", () => {
    const reported = vi.spyOn(globalThis, "reportError").mockImplementation(() => undefined)
    const store = new Optimistic(reducer)
    const seen: Array<unknown> = []
    const failure = new Error("listener")

    store.reconcile({ count: 0 })
    store.subscribe(() => {
      throw failure
    })
    store.subscribe((state) => seen.push(state))
    store.follow({ member: "Add", input: 2, reducer }, Promise.withResolvers<undefined>().promise)

    expect(store.state).toEqual({ count: 2 })
    expect(store.pending).toEqual([{ member: "Add", input: 2 }])
    expect(seen).toEqual([{ count: 2 }])
    expect(reported).toHaveBeenCalledWith(failure)
  })

  it("never lets a caller-held state change committed state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bump = { ...reducer, commutative: true }
        const store = new Optimistic(bump)
        const committed = { count: 0 }

        store.reconcile(committed)
        committed.count = 10
        store.follow({ member: "Bump", input: 1, reducer: bump }, Promise.resolve(undefined))

        const shown = store.state

        expect(shown).toEqual({ count: 1 })
        Object.assign(shown!, { count: 20 })
        yield* settle

        expect(store.state).toEqual({ count: 1 })
        expect(store.pending).toEqual([])
      }),
    ))

  it("never lets a caller-held pending input change what a receipt applies", () => {
    const receipt = Promise.withResolvers<undefined>()

    return Effect.runPromise(
      Effect.gen(function* () {
        const bump: OptimisticReducer = {
          ...reducer,
          reduce: (state, input) =>
            Result.succeed({
              count: Number(state["count"]) + (Predicate.isObject(input) ? Number(input["by"]) : 0),
            }),
          commutative: true,
        }

        const store = new Optimistic(bump)

        store.reconcile({ count: 0 })

        store.follow({ member: "Bump", input: { by: 1 }, reducer: bump }, receipt.promise)

        const [pending] = store.pending

        expect(pending?.input).toEqual({ by: 1 })
        Object.assign(pending!.input as object, { by: 9 })
        receipt.resolve(undefined)
        yield* settle

        expect(store.state).toEqual({ count: 1 })
      }),
    )
  })

  it("sends reducer calls one at a time, and a rejected one leaves the view but not the line", () => {
    const first = Promise.withResolvers<undefined>()

    return Effect.runPromise(
      Effect.gen(function* () {
        const store = new Optimistic(reducer)
        const started: Array<string> = []

        store.reconcile({ count: 0 })

        const one = store.sendInOrder({ member: "Add", input: 1, reducer }, () => {
          started.push("one")

          return first.promise
        })

        const two = store.sendInOrder({ member: "Add", input: 10, reducer }, (after) =>
          after.then(() => {
            started.push("two")

            return { count: 10 }
          }),
        )

        yield* settle
        expect(started).toEqual(["one"])
        expect(store.state).toEqual({ count: 11 })

        first.reject(new Error("refused"))
        yield* Effect.promise(() => one.catch(() => undefined))
        yield* Effect.promise(() => two)
        yield* settle

        expect(started).toEqual(["one", "two"])
        expect(store.state).toEqual({ count: 10 })
        expect(store.pending).toEqual([])
      }),
    )
  })
})
