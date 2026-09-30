import { getTableColumns } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { descriptorOf } from "../../actor/descriptor.ts"
import { ownership, type AdoptionAccess, type MappedKind } from "../../tables/owned.ts"
import type { Placement } from "../storage/codec.ts"

/** A command's precondition failed; the message names the table and the fix. */
export class AdoptionRefused extends Schema.TaggedError<AdoptionRefused>()("AdoptionRefused", {
  message: Schema.String,
}) {}

/** One existing table an actor type declares with `Actor.table(existing, { owner })`. */
export interface AdoptionTarget {
  readonly actor: string
  readonly placement: Placement
  readonly access: AdoptionAccess
  readonly schema: string
  readonly table: string
  readonly tenantColumn: string
  readonly actorColumn: string
  readonly tenantKind: MappedKind
  readonly actorKind: MappedKind
  /** SQL names of the primary key columns, in key order. */
  readonly primaryKey: ReadonlyArray<string>
}

/** The table's name as `schema.table`, which the CLI and every report print. */
export const qualifiedName = (target: Pick<AdoptionTarget, "schema" | "table">) =>
  `${target.schema}.${target.table}`

/**
 * The adopted tables of `actors`, resolved against the connection's current
 * schema. `only` is a table name or `schema.table`; naming a table no actor
 * adopts is refused, so a typo never silently does nothing.
 */
export const adoptionTargets = Effect.fnUntraced(function* (
  actors: ReadonlyArray<WeakKey>,
  only?: string,
) {
  const sql = yield* SqlClient.SqlClient
  const current = (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema
  const targets: Array<AdoptionTarget> = []

  for (const actor of actors) {
    const declared = descriptorOf(actor)

    for (const table of declared?.tables ?? []) {
      const info = ownership(table)!

      if (!info.adopted) continue

      const columns = getTableColumns(table)

      targets.push({
        actor: declared!.name,
        placement: declared!.placement,
        access: info.access,
        schema: info.schema ?? current,
        table: info.table,
        tenantColumn: columns[info.tenantKey]!.name,
        actorColumn: columns[info.actorKey]!.name,
        tenantKind: info.tenantKind,
        actorKind: info.actorKind,
        primaryKey: info.primaryKey.map((key) => columns[key]!.name),
      })
    }
  }

  if (only === undefined) return targets

  const named = targets.filter((target) => target.table === only || qualifiedName(target) === only)

  if (named.length === 0)
    return yield* AdoptionRefused.make({ message: `No actor type adopts a table named ${only}` })

  return named
})
