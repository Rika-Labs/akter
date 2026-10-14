import { Schema } from "effect"
import type { Bounds, Fields, FindQuery } from "../contract/context.ts"
import { Finds } from "../contract/find.ts"
import type { FindRow, IndexValue } from "../contract/find.ts"
import type { Scalar } from "../contract/find.ts"
import type { AnyActor } from "../contract/make.ts"
import type { ActorRecord } from "./durable.ts"

/** Index rows persisted in the same content-addressed checkpoint page as their durable states. */
export const IndexSnapshot = Schema.Array(
  Schema.Struct({
    actor: Schema.String,
    id: Schema.Json,
    fields: Schema.Record(
      Schema.String,
      Schema.Union([
        Schema.String,
        Schema.Finite,
        Schema.Boolean,
        Schema.Struct({ bigint: Schema.String }),
      ]),
    ),
  }),
)

interface Row {
  readonly actor: string
  readonly id: Schema.Json
  readonly fields: Readonly<Record<string, IndexValue>>
}

/** An owner-held index: one row per created actor and sorted row references per scalar field. */
export interface OwnerIndex {
  readonly rows: Map<string, Row>
  readonly fields: Map<string, Array<Row>>
}

const empty = (): OwnerIndex => ({ rows: new Map(), fields: new Map() })
const fieldKey = (actor: string, field: string) => JSON.stringify([actor, field])
const addressOf = (row: Row) => `${row.actor}/${JSON.stringify(row.id)}`
const compare = (field: string, a: Row, b: Row): number =>
  Finds.compare(a.fields[field], b.fields[field]) ||
  (addressOf(a) < addressOf(b) ? -1 : addressOf(a) > addressOf(b) ? 1 : 0)

const insert = (index: OwnerIndex, row: Row): void => {
  index.rows.set(addressOf(row), row)
  for (const field of Object.keys(row.fields)) {
    const key = fieldKey(row.actor, field)
    const sorted = index.fields.get(key) ?? []
    let low = 0
    let high = sorted.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (compare(field, sorted[middle]!, row) < 0) low = middle + 1
      else high = middle
    }
    sorted.splice(low, 0, row)
    index.fields.set(key, sorted)
  }
}

/** Replaces one row only after its action is durable; discarded drafts never reach this function. */
const update = (index: OwnerIndex, record: ActorRecord): void => {
  const old = index.rows.get(record.address)
  if (old !== undefined)
    for (const field of Object.keys(old.fields)) {
      const key = fieldKey(old.actor, field)
      const sorted = index.fields.get(key)!
      const position = sorted.indexOf(old)
      if (position >= 0) sorted.splice(position, 1)
    }
  if (!record.created) return
  const fields: Record<string, IndexValue> = {}
  for (const name of Object.keys(record.actor.state.fields)) {
    if (Finds.field(record.actor, name) === undefined) continue
    const value = Finds.value(record.image.state[name])
    if (value !== undefined) fields[name] = value
  }
  insert(index, { actor: record.actor.name, id: record.keyJson, fields })
}

/** Filters index rows, not actor states, using a sorted field as the candidate set when available. */
const query = (
  index: OwnerIndex,
  actor: AnyActor,
  query: FindQuery<Fields>,
): ReadonlyArray<FindRow> => {
  const where = query.where ?? {}
  const first = Object.keys(where)[0]
  const candidates =
    first === undefined
      ? Array.from(index.rows.values()).filter((row) => row.actor === actor.name)
      : (index.fields.get(fieldKey(actor.name, first)) ?? [])
  return Finds.rows(
    query,
    candidates
      .filter((row) =>
        Object.entries(where).every(([field, condition]) =>
          Finds.matches(row.fields[field], condition as Scalar | Bounds<Scalar>),
        ),
      )
      .map((row) => ({
        id: row.id,
        order: query.orderBy === undefined ? null : (row.fields[query.orderBy.field] ?? null),
      })),
  )
}

const capture = (index: OwnerIndex): typeof IndexSnapshot.Type => Array.from(index.rows.values())
const restore = (rows: typeof IndexSnapshot.Type): OwnerIndex => {
  const index = empty()
  for (const row of rows) {
    if (index.rows.has(addressOf(row))) throw new Error("Checkpoint index repeats an actor")
    insert(index, row)
  }
  return index
}

/** Durable owner indexes and their checkpoint representation. */
export const Indexes = { empty, update, query, capture, restore }
