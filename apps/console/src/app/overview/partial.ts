import { Function } from "effect"
import type { Loaded } from "../api/client.ts"

/** Data tagged with the source it was read from. */
export const sourced: {
  (sample: boolean): <A>(data: A) => Loaded<A>
  <A>(data: A, sample: boolean): Loaded<A>
} = Function.dual(2, <A>(data: A, sample: boolean): Loaded<A> => ({ data, sample }))

/**
 * Joins a page's own source with the source of a section read inside it. The page is sample when
 * either is, so a live summary keeps its live data while a section that fell back to a fixture
 * still makes the whole page read-only.
 */
export const flattenLoaded = <A>(outer: Loaded<Loaded<A>>): Loaded<A> => ({
  data: outer.data.data,
  sample: outer.sample || outer.data.sample,
})
