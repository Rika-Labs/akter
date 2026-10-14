import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { PageCache, PageMiss, PageTrees } from "./page-tree.ts"
import { PagedItems } from "./lists.ts"
import { memoryBucket } from "../store/memory.ts"
import { storeOf } from "../store/service.ts"

const item = { encode: (value: any) => value as Schema.Json, decode: (value: Schema.Json) => value }
const ordering = { key: "id", by: "at" }

describe("Page tree", () => {
  it.effect(
    "rejects eager loading, unbounded caching, order/key confusion, and full-tree rewrites",
    () =>
      Effect.gen(function* () {
        const raw = memoryBucket()
        const gets: Array<string> = []
        const puts: Array<string> = []
        const store = yield* storeOf(
          {
            ...raw,
            get: (key) =>
              Effect.andThen(
                Effect.sync(() => gets.push(key)),
                raw.get(key),
              ),
            put: (key, bytes) =>
              Effect.andThen(
                Effect.sync(() => puts.push(key)),
                raw.put(key, bytes),
              ),
          },
          { shards: 1 },
        )
        const cache = new PageCache(80_000)
        const values = Array.from({ length: 900 }, (_, id) => ({
          id,
          at: 899 - id,
          text: `${id}:` + "a".repeat(900),
        }))
        const initial = new PagedItems(
          PageTrees.empty,
          PageTrees.empty,
          cache,
          ordering,
          item,
        ).apply({ put: values, delete: [] })
        const keys = yield* PageTrees.persist(initial.keys, store, cache)
        const ordered = yield* PageTrees.persist(initial.ordered, store, cache)
        const total = puts.length
        cache.clear()
        const cold = new PagedItems(keys, ordered, cache, ordering, item)
        expect(() => cold.get(317)).toThrow(PageMiss)
        gets.length = 0
        expect(yield* cache.resolve(store, () => cold.get(317))).toEqual(values[317])
        expect(gets.length).toBeLessThan(5)
        expect(cache.size).toBeLessThanOrEqual(80_000)
        const window = yield* cache.resolve(store, () =>
          cold.range({ from: 123, to: 129, reverse: true, limit: 3 }),
        )
        expect(window.map((value) => value.id)).toEqual([771, 772, 773])
        puts.length = 0
        const changed = yield* cache.resolve(store, () =>
          cold.apply({ put: [{ id: 317, at: -7, text: "moved" }], delete: [600] }),
        )
        yield* PageTrees.persist(changed.keys, store, cache)
        yield* PageTrees.persist(changed.ordered, store, cache)
        expect(puts.length).toBeGreaterThan(0)
        expect(puts.length).toBeLessThan(total / 2)
        expect(yield* cache.resolve(store, () => changed.get(600))).toBeUndefined()
        expect(yield* cache.resolve(store, () => changed.range({ to: 0 }))).toEqual([
          { id: 317, at: -7, text: "moved" },
        ])
      }),
  )

  it.effect("keeps an invocation's working set even when every page exceeds the cache bound", () =>
    Effect.gen(function* () {
      const store = yield* storeOf(memoryBucket(), { shards: 1 })
      const cache = new PageCache(0)
      const values = Array.from({ length: 180 }, (_, id) => ({
        id,
        at: id % 7,
        text: "z".repeat(1300),
      }))
      const made = new PagedItems(PageTrees.empty, PageTrees.empty, cache, ordering, item).apply({
        put: values,
        delete: [],
      })
      const keys = yield* PageTrees.persist(made.keys, store, cache)
      const ordered = yield* PageTrees.persist(made.ordered, store, cache)
      const cold = new PagedItems(keys, ordered, cache, ordering, item)
      const all = yield* cache.resolve(store, () => cold.range())
      expect(all.map((value) => value.id)).toEqual(
        values.toSorted((a, b) => a.at - b.at || a.id - b.id).map((value) => value.id),
      )
      expect(cache.size).toBe(0)
    }),
  )
})
