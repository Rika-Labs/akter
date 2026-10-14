import { HashMap, Option } from "effect"
import type { List, ListDraft, ListReader, RangeOptions } from "../contract/members.ts"
import type { Codec } from "../execution/layout.ts"
import { PageCache, PageDocuments, PageTrees } from "./page-tree.ts"
import type { Tree } from "./page-tree.ts"

/** A decoded list item; lists are read and written by their key and order fields. */
type Item = any

/** The value of a list's key or order field. */
export type Ordered = string | number

/** One list's items, keyed by the JSON of their key field; immutable, so durable and speculative share structure. */
export type Items = HashMap.HashMap<string, Item> | PagedItems

/** The writes one action made to one list, in order of the final state: puts, then deletes. */
export interface ListWrites {
  readonly put: ReadonlyArray<Item>
  readonly delete: ReadonlyArray<Ordered>
}

/** What an action did to one list: the next items, and its writes unless it wrote nothing. */
export interface Staged {
  readonly items: Items
  readonly writes: ListWrites | undefined
}

/** An empty list. */
export const emptyItems: Items = HashMap.empty()

const compare = (left: Ordered, right: Ordered): number =>
  left < right ? -1 : left > right ? 1 : 0

/** The ordering of a list: by its `by` field, ties broken by key. */
export interface Ordering {
  readonly key: string
  readonly by: string
}

/** The ordering a list field declares. */
export const orderingOf = (list: List): Ordering => ({ key: list.keyField, by: list.byField })

const slot = (key: Ordered): string => JSON.stringify(key)

/** Two page trees keep key lookups independent of the list's ordering field. */
export class PagedItems implements Iterable<readonly [string, Item]> {
  readonly keys: Tree
  readonly ordered: Tree
  readonly cache: PageCache
  readonly ordering: Ordering
  readonly codec: Codec

  constructor(keys: Tree, ordered: Tree, cache: PageCache, ordering: Ordering, codec: Codec) {
    this.keys = keys
    this.ordered = ordered
    this.cache = cache
    this.ordering = ordering
    this.codec = codec
  }

  get(key: Ordered): Item {
    const value = PageTrees.get(this.keys, [key], this.cache)
    return value === undefined ? undefined : this.codec.decode(PageDocuments.json(value))
  }

  range(options?: RangeOptions<Ordered>): ReadonlyArray<Item> {
    return PageTrees.range(
      this.ordered,
      this.cache,
      options?.from === undefined ? undefined : [options.from],
      options?.to === undefined ? undefined : [options.to],
      options?.reverse,
      options?.limit,
    ).map((value) => this.codec.decode(PageDocuments.json(value)))
  }

  apply(writes: ListWrites): PagedItems {
    let keys = this.keys
    let ordered = this.ordered
    for (const key of [...writes.delete, ...writes.put.map((item) => item[this.ordering.key])]) {
      const before = PageTrees.get(keys, [key], this.cache)
      if (before !== undefined) {
        const item = this.codec.decode(before)
        ordered = PageTrees.set(ordered, [item[this.ordering.by], key], undefined, this.cache)
      }
      keys = PageTrees.set(keys, [key], undefined, this.cache)
    }
    for (const item of writes.put) {
      const key = item[this.ordering.key]
      const encoded = PageDocuments.json(this.codec.encode(item))
      keys = PageTrees.set(keys, [key], encoded, this.cache)
      ordered = PageTrees.set(ordered, [item[this.ordering.by], key], encoded, this.cache)
    }
    return new PagedItems(keys, ordered, this.cache, this.ordering, this.codec)
  }

  *[Symbol.iterator](): Iterator<readonly [string, Item]> {
    for (const item of this.range()) yield [slot(item[this.ordering.key]), item]
  }
}

const sorted = (items: Iterable<Item>, ordering: Ordering): Array<Item> =>
  Array.from(items).sort(
    (left, right) =>
      compare(left[ordering.by], right[ordering.by]) ||
      compare(left[ordering.key], right[ordering.key]),
  )

const select = (
  items: Iterable<Item>,
  ordering: Ordering,
  options: RangeOptions<Ordered> | undefined,
): ReadonlyArray<Item> => {
  const from = options?.from
  const to = options?.to
  const selected = sorted(items, ordering).filter(
    (item) =>
      (from === undefined || compare(item[ordering.by], from) >= 0) &&
      (to === undefined || compare(item[ordering.by], to) < 0),
  )
  if (options?.reverse === true) selected.reverse()
  return options?.limit === undefined ? selected : selected.slice(0, options.limit)
}

/** A window over items in `by` order: `from` inclusive, `to` exclusive, then `reverse`, then `limit`. */
const window = (
  items: Items,
  ordering: Ordering,
  options: RangeOptions<Ordered> | undefined,
): ReadonlyArray<Item> =>
  items instanceof PagedItems
    ? items.range(options)
    : select(HashMap.values(items), ordering, options)

/** A list as a view reads it. */
const reader = (items: Items, ordering: Ordering): ListReader<Item, Ordered, Ordered> => ({
  get: (key) =>
    items instanceof PagedItems
      ? items.get(key)
      : Option.getOrUndefined(HashMap.get(items, slot(key))),
  range: (options) => window(items, ordering, options),
})

/**
 * A list as an action stages writes to it. A class instance, so the state draft treats it as a value
 * and never copies it; `finish` yields the next items and the writes.
 */
class StagedList implements ListDraft<Item, Ordered, Ordered> {
  readonly #items: Items
  readonly #ordering: Ordering
  readonly #staged = new Map<string, Item>()

  constructor(items: Items, ordering: Ordering) {
    this.#items = items
    this.#ordering = ordering
  }

  #lookup(key: string): Item {
    if (this.#staged.has(key)) return this.#staged.get(key)
    return reader(this.#items, this.#ordering).get(JSON.parse(key))
  }

  #merged(): Array<Item> {
    const out: Array<Item> = []
    for (const [key, item] of this.#items) if (!this.#staged.has(key)) out.push(item)
    for (const item of this.#staged.values()) if (item !== undefined) out.push(item)
    return out
  }

  get(key: Ordered): Item {
    return this.#lookup(slot(key))
  }

  range(options?: RangeOptions<Ordered>): ReadonlyArray<Item> {
    if (this.#staged.size === 0) return window(this.#items, this.#ordering, options)
    const base = window(this.#items, this.#ordering, {
      ...options,
      limit: options?.limit === undefined ? undefined : options.limit + this.#staged.size,
    }).filter((item) => !this.#staged.has(slot(item[this.#ordering.key])))
    return select(
      [...base, ...Array.from(this.#staged.values()).filter((item) => item !== undefined)],
      this.#ordering,
      options,
    )
  }

  put(item: Item): void {
    this.#staged.set(slot(item[this.#ordering.key]), item)
  }

  delete(key: Ordered): boolean {
    const existed = this.#lookup(slot(key)) !== undefined
    this.#staged.set(slot(key), undefined)
    return existed
  }

  deleteBefore(by: Ordered): number {
    let count = 0
    for (const item of this.#merged())
      if (compare(item[this.#ordering.by], by) < 0) {
        this.#staged.set(slot(item[this.#ordering.key]), undefined)
        count++
      }
    return count
  }

  finish(): Staged {
    let next = this.#items
    const put: Array<Item> = []
    const deleted: Array<Ordered> = []
    for (const [key, item] of this.#staged) {
      if (item === undefined) {
        if (reader(this.#items, this.#ordering).get(JSON.parse(key)) === undefined) continue
        deleted.push(JSON.parse(key))
      } else {
        put.push(item)
      }
    }
    if (put.length === 0 && deleted.length === 0) return { items: this.#items, writes: undefined }
    put.sort((left, right) => compare(left[this.#ordering.key], right[this.#ordering.key]))
    deleted.sort(compare)
    next = apply(next, this.#ordering, { put, delete: deleted })
    return { items: next, writes: { put, delete: deleted } }
  }
}

const draft = (items: Items, ordering: Ordering): StagedList => new StagedList(items, ordering)

/** Applies recorded writes to items: the replay and recovery path, which never runs a handler. */
const apply = (items: Items, ordering: Ordering, writes: ListWrites): Items => {
  if (items instanceof PagedItems) return items.apply(writes)
  let next = items
  for (const item of writes.put) next = HashMap.set(next, slot(item[ordering.key]), item)
  for (const key of writes.delete) next = HashMap.remove(next, slot(key))
  return next
}

/** Every item in `by` order. */
const all = (items: Items, ordering: Ordering): ReadonlyArray<Item> =>
  items instanceof PagedItems ? items.range() : sorted(HashMap.values(items), ordering)

/** In-memory lists: every item resident, ordered on read. */
export const Lists = { reader, draft, apply, all, window, empty: emptyItems }
