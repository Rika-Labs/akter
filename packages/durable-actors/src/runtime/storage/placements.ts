import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import { parentPlacement, type Placement, PLACEMENT_ENCODING, placementKind } from "./codec.ts"

/**
 * Records `name`'s placement on first registration and refuses one that
 * differs from the record, for the type and every ancestor it routes through:
 * a changed placement, encoding, or parent would read and write under
 * different routing keys.
 */
export const checkPlacement = ({
  name,
  placement,
}: {
  readonly name: string
  readonly placement: Placement
}): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const kind = placementKind(placement)
    const parent = parentPlacement(placement)?.parent ?? null

    yield* sql`INSERT INTO actor_placements (actor_type, placement, encoding, parent_type)
    VALUES (${name}, ${kind}, ${PLACEMENT_ENCODING}, ${parent})
    ON CONFLICT DO NOTHING`

    const [recorded] = yield* sql<{
      placement: string
      encoding: number
      parent_type: string | null
    }>`SELECT placement, encoding, parent_type FROM actor_placements WHERE actor_type = ${name}`

    if (
      recorded?.placement !== kind ||
      recorded.encoding !== PLACEMENT_ENCODING ||
      recorded.parent_type !== parent
    )
      return yield* Effect.die(
        new Error(`Actor ${name} placement differs from the deployment; migrate explicitly`),
      )

    const above = parentPlacement(placement)

    if (above !== undefined)
      yield* checkPlacement({ name: above.parent, placement: above.placement })
  })

/** The placement recorded for `actorType`, resolved through its parents, or `undefined` if none is. */
export const recordedPlacement = (
  actorType: string,
): Effect.Effect<Placement | undefined, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const [recorded] = yield* sql<{
      placement: "tenant" | "actor" | "parent"
      parent_type: string | null
    }>`SELECT placement, parent_type FROM actor_placements WHERE actor_type = ${actorType}`

    if (recorded === undefined) return undefined

    if (recorded.placement !== "parent") return recorded.placement

    const parent = yield* recordedPlacement(recorded.parent_type!)

    if (parent === undefined)
      return yield* Effect.die(
        new Error(`Actor ${actorType}'s parent ${recorded.parent_type} has no recorded placement`),
      )

    return { parent: recorded.parent_type!, placement: parent }
  })
