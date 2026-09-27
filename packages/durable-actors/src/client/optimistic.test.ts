import { Result, Schema } from "effect"
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

    if (shown !== undefined) Object.assign(shown, { count: 20 })

    store.confirm(entry, undefined)

    expect(store.state).toEqual({ count: 1 })
  })
})
