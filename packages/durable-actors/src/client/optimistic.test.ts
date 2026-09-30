import { Predicate, Result, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { OptimisticReducer } from "../actor/served.ts"
import { Optimistic } from "./optimistic.ts"

const reducer: OptimisticReducer = {
  state: Schema.Struct({ count: Schema.Int }),
  reduce: (state, by) => Result.succeed({ count: Number(state["count"]) + Number(by) }),
  commutative: false,
}

describe("Optimistic", () => {
  afterEach(() => {
    vi.restoreAllMocks()
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
    store.add({ member: "Add", input: 2, reducer })

    expect(store.state).toEqual({ count: 2 })
    expect(store.pending).toEqual([{ member: "Add", input: 2 }])
    expect(seen).toEqual([{ count: 2 }])
    expect(reported).toHaveBeenCalledWith(failure)
  })

  it("never lets a caller-held state change committed state", () => {
    const store = new Optimistic({ ...reducer, commutative: true })
    const committed = { count: 0 }
    const entry = { member: "Bump", input: 1, reducer }

    store.reconcile(committed)
    committed.count = 10
    store.add(entry)

    const shown = store.state

    expect(shown).toEqual({ count: 1 })
    Object.assign(shown!, { count: 20 })

    store.confirm(entry, undefined)

    expect(store.state).toEqual({ count: 1 })
  })

  it("never lets a caller-held pending input change what a receipt applies", () => {
    const bump: OptimisticReducer = {
      ...reducer,
      reduce: (state, input) =>
        Result.succeed({
          count: Number(state["count"]) + (Predicate.isObject(input) ? Number(input["by"]) : 0),
        }),
      commutative: true,
    }

    const store = new Optimistic(bump)
    const entry = { member: "Bump", input: { by: 1 }, reducer: bump }

    store.reconcile({ count: 0 })
    store.add(entry)

    const [pending] = store.pending

    expect(pending?.input).toEqual({ by: 1 })
    Object.assign(pending!.input as object, { by: 9 })

    store.confirm(entry, undefined)

    expect(store.state).toEqual({ count: 1 })
  })
})
