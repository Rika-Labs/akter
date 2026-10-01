import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ActorRef } from "../../identity/caller.ts"

/**
 * What one activation remembers of its authority between writes. `generation`
 * is the fenced epoch it acquired and `state` the committed state it last read
 * or wrote. Memory is never authority: every durable writer proves in its own
 * transaction that the stored generation still equals `generation`, and only
 * that proof lets a turn skip reading state again. Command turns, connection
 * sessions and workflow runs of one activation share this one object.
 */
export interface ActivationCache {
  generation: string | undefined
  state: ReadonlyMap<string, string> | undefined
}

/** A fresh activation has acquired no generation and read no state. */
export const emptyActivationCache = (): ActivationCache => ({
  generation: undefined,
  state: undefined,
})

/**
 * Drops what an activation remembers once a writer found its generation stale,
 * so no later writer trusts that generation or the state read under it; the
 * next one acquires a new generation and reads state again.
 */
export const forget = (cache: ActivationCache) => {
  cache.generation = undefined
  cache.state = undefined
}

/** One actor's stored identity: the routing key its rows live under and its address. */
export interface OwnedActor {
  readonly key: bigint
  readonly ref: ActorRef
}

/**
 * The predicate naming `actor`'s rows in any table keyed by actor identity,
 * with columns qualified by `alias` when the statement joins another such table.
 */
export const actorRow = ({
  sql,
  actor: { key, ref },
  alias,
}: {
  readonly sql: SqlClient.SqlClient
  readonly actor: OwnedActor
  readonly alias?: string
}) => {
  const at = sql.literal(alias === undefined ? "" : `${alias}.`)

  return sql`${at}routing_key = ${key} AND ${at}tenant_id = ${ref.tenant}
    AND ${at}actor_type = ${ref.actor} AND ${at}actor_id = ${ref.id}`
}

/**
 * How a writer outside the turn's own admission holds the generation row until
 * it commits. `UPDATE` serializes the writer with command turns, which lock the
 * row the same way, for a multi-statement write that reads actor data. `SHARE`
 * only stops another activation advancing the generation until the writer
 * commits, for one statement that writes rows of its own.
 */
export type GenerationLock = "UPDATE" | "SHARE"

/**
 * The actor's generation row while it is still at `generation`, locked by
 * `lock`, as a query or a derived table a single write statement joins. No row
 * means another activation took over and the statement must write nothing. The
 * lock waits out a concurrent takeover and then rechecks the generation, so a
 * write that commits was ordered before any newer generation was acquired.
 */
export const heldGeneration = ({
  sql,
  actor,
  generation,
  lock,
}: {
  readonly sql: SqlClient.SqlClient
  readonly actor: OwnedActor
  readonly generation: string
  readonly lock: GenerationLock
}) =>
  sql`SELECT routing_key, tenant_id, actor_type, actor_id FROM actor_generations
    WHERE ${actorRow({ sql, actor })} AND generation = ${generation} FOR ${sql.literal(lock)}`

/**
 * Proves inside the caller's transaction that `cache` still holds the actor's
 * generation, and holds the row by `lock` until that transaction ends. A stale
 * or never-fenced activation answers false and has forgotten its generation
 * and state; each caller maps that answer to its own retryable failure.
 */
export const fence = Effect.fnUntraced(function* ({
  actor,
  cache,
  lock,
}: {
  readonly actor: OwnedActor
  readonly cache: ActivationCache
  readonly lock: GenerationLock
}) {
  if (cache.generation === undefined) return false

  const sql = yield* SqlClient.SqlClient
  const held = yield* heldGeneration({ sql, actor, generation: cache.generation, lock })

  if (held.length === 0) forget(cache)

  return held.length > 0
})
