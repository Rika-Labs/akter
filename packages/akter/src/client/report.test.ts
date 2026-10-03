import { Result, Schema } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import { Optimistic } from "./optimistic.ts"

afterEach(() => vi.unstubAllGlobals())

it("continues notifying optimistic listeners without a browser error reporter", () => {
  vi.stubGlobal("reportError", undefined)
  const reducer = {
    state: Schema.Struct({ count: Schema.Int }),
    reduce: () => Result.succeed({ count: 19 }),
    commutative: false,
  }
  const store = new Optimistic(reducer)
  const seen: Array<unknown> = []
  store.subscribe(() => {
    throw new Error("listener rejected update")
  })
  store.subscribe((state) => seen.push(state))

  expect(() => store.reconcile({ count: 7 })).not.toThrow()
  expect(seen).toEqual([{ count: 7 }])
  expect(store.state).toEqual({ count: 7 })
})
