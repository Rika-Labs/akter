import { Schema } from "effect"

/** The most rows one fleet page returns. */
export const FLEET_PAGE_LIMIT = 1000

/** The rows a fleet page returns unless the caller asks for fewer or more. */
export const FLEET_PAGE_DEFAULT = 100

/** A fleet page as JSON, before its rows are typed by their view. */
export const FleetPageJson = Schema.Struct({
  asOf: Schema.NullOr(Schema.String),
  stale: Schema.Boolean,
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
})

/** A filter as the served route takes it: each value in its text form. */
export const fleetFilterText = (filter: Readonly<Record<string, string | number | boolean>>) =>
  Object.fromEntries(Object.entries(filter).map(([key, value]) => [key, String(value)]))
