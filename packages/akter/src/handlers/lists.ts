import { HashMap, Option } from "effect"
import type { List, ListDraft, ListReader, RangeOptions } from "../contract/members.ts"

/** A decoded list item; lists are read and written by their key and order fields. */
type Item = any

/** The value of a list's key or order field. */
export type Ordered = string | number

/** One list's items, keyed by the JSON of their key field; immutable, so durable and speculative share structure. */
export type Items = HashMap.HashMap<string, Item>

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

const compare = (left: Ordered, right: Ordered): number => (left < right ? -1 : left > right ? 1 : 0)

/** The ordering of a list: by its `by` field, ties broken by key. */
export interface Ordering {
  readonly key: string
  readonly by: string
}

/** The ordering a list field declares. */
export const orderingOf = (list: List): Ordering => ({ key: list.keyField, by: list.byField })

const slot = (key: Ordered): string => JSON.stringify(key)

const sorted = (items: Iterable<Item>, ordering: Ordering): Array<Item> =>
  Array.from(items).sort(
    (left, right) =>
      compare(left[ordering.by], right[ordering.by]) || compare(left[ordering.key], right[ordering.key]),
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
const window = (items: Items, ordering: Ordering, options: RangeOptions<Ordered> | undefined): ReadonlyArray<Item> =>
  select(HashMap.values(items), ordering, options)

/** A list as a view reads it. */
const reader = (items: Items, ordering: Ordering): ListReader<Item, Ordered, Ordered> => ({
  get: (key) => Option.getOrUndefined(HashMap.get(items, slot(key))),
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
    return Option.getOrUndefined(HashMap.get(this.#items, key))
  }

  #merged(): Array<Item> {
    const out: Array<Item> = []
    for (const [key, item] of HashMap.entries(this.#items)) if (!this.#staged.has(key)) out.push(item)
    for (const item of this.#staged.values()) if (item !== undefined) out.push(item)
    return out
  }

  get(key: Ordered): Item {
    return this.#lookup(slot(key))
  }

  range(options?: RangeOptions<Ordered>): ReadonlyArray<Item> {
    return select(this.#merged(), this.#ordering, options)
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
        if (!HashMap.has(next, key)) continue
        next = HashMap.remove(next, key)
        deleted.push(JSON.parse(key))
      } else {
        next = HashMap.set(next, key, item)
        put.push(item)
      }
    }
    if (put.length === 0 && deleted.length === 0) return { items: this.#items, writes: undefined }
    return { items: next, writes: { put, delete: deleted } }
  }
}

const draft = (items: Items, ordering: Ordering): StagedList => new StagedList(items, ordering)

/** Applies recorded writes to items: the replay and recovery path, which never runs a handler. */
const apply = (items: Items, ordering: Ordering, writes: ListWrites): Items => {
  let next = items
  for (const item of writes.put) next = HashMap.set(next, slot(item[ordering.key]), item)
  for (const key of writes.delete) next = HashMap.remove(next, slot(key))
  return next
}

/** Every item in `by` order. */
const all = (items: Items, ordering: Ordering): ReadonlyArray<Item> => sorted(HashMap.values(items), ordering)

/** In-memory lists: every item resident, ordered on read. */
export const Lists = { reader, draft, apply, all, window, empty: emptyItems }
