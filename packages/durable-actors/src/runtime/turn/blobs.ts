import { Effect, Option, Predicate } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { AnyBlob } from "../../members/blob.ts"
import type { BlobAccess, BlobRead, BlobScope, BlobWrite } from "../../state/blob.ts"
import { routingKey as routingKeyOf } from "../storage/codec.ts"

const MAX_NAME_LENGTH = 1024

/**
 * Binds blob capabilities to the calling fiber's turn or query. Every row is
 * addressed by the trusted scope, so equal blob and entry names of two actors
 * or tenants never meet; writes run on the turn's connection, inside its
 * savepoint, and roll back with it.
 */
export const bindBlobs = Effect.fnUntraced(function* (scope: BlobScope, write: boolean) {
  const sql = yield* SqlClient.SqlClient
  const connection = yield* Effect.serviceOption(sql.transactionService)

  if (write && Option.isNone(connection))
    return yield* Effect.die(new Error("Blob writes need the turn transaction"))

  const { ref } = scope
  const routingKey = routingKeyOf({ ref, placement: scope.placement })

  const access: BlobAccess = (blob: AnyBlob) => {
    // Checked per call, like owned rows, so a misuse is a defect of the turn.
    const entry = Effect.fnUntraced(function* (name: string) {
      yield* scope.guard

      if (!scope.blobs.includes(blob))
        return yield* Effect.die(
          new Error(`${String(blob?.name)} is not a declared blob of ${ref.actor}`),
        )

      if (!Predicate.isString(name) || name.length === 0 || name.length > MAX_NAME_LENGTH)
        return yield* Effect.die(
          new Error(`Blob entry names are 1-${MAX_NAME_LENGTH} character strings`),
        )

      return sql`routing_key = ${routingKey} AND tenant_id = ${ref.tenant}
        AND actor_type = ${ref.actor} AND actor_id = ${ref.id}
        AND blob = ${blob.name} AND name = ${name}`
    })

    // A copy taken once, so later changes to the caller's buffer never reach the row.
    const copy = (bytes: Uint8Array) =>
      bytes instanceof Uint8Array
        ? Effect.succeed(Uint8Array.from(bytes))
        : Effect.die(new Error("Blob bytes are a Uint8Array"))

    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        (bound) =>
          Option.isSome(connection)
            ? Effect.provideService(bound, sql.transactionService, connection.value)
            : bound,
        // The SqlError itself decides whether the turn retries or is a defect.
        Effect.orDie,
      )

    const read: BlobRead = {
      get: (name) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(name)

            const [found] = yield* sql<{ bytes: Uint8Array | null }>`
              SELECT string_agg(bytes, ''::bytea ORDER BY chunk) AS bytes
              FROM actor_blobs WHERE ${where}`

            const bytes = found?.bytes ?? null

            return bytes === null
              ? Option.none<Uint8Array>()
              : Option.some(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
          }),
        ),
    }

    // Off-turn contexts get no mutation methods at all, whatever their static type.
    if (!write) return read

    const values = (name: string, chunk: ReturnType<typeof sql.literal>, bytes: Uint8Array) =>
      sql`${routingKey}::bigint, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${blob.name}, ${name}, ${chunk}, ${bytes}::bytea`

    return {
      ...read,
      set: (name, bytes) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(name)
            const copied = yield* copy(bytes)

            // Chunk 0 always heads an entry, so a set overwrites it and drops the rest.
            yield* sql`WITH dropped AS (DELETE FROM actor_blobs WHERE ${where} AND chunk > 0)
              INSERT INTO actor_blobs (routing_key, tenant_id, actor_type, actor_id, blob, name, chunk, bytes)
              VALUES (${values(name, sql.literal("0"), copied)})
              ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, blob, name, chunk)
              DO UPDATE SET bytes = EXCLUDED.bytes`
          }),
        ),
      append: (name, bytes) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(name)
            const copied = yield* copy(bytes)

            // Turns of one actor are serialized by its generation lock, so the next chunk is free.
            yield* sql`INSERT INTO actor_blobs (routing_key, tenant_id, actor_type, actor_id, blob, name, chunk, bytes)
              SELECT ${values(name, sql.literal("COALESCE(max(chunk) + 1, 0)"), copied)}
              FROM actor_blobs WHERE ${where}`
          }),
        ),
      compact: (name) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(name)

            yield* sql`WITH merged AS (
                DELETE FROM actor_blobs WHERE ${where} AND chunk > 0 RETURNING chunk, bytes)
              UPDATE actor_blobs AS head
              SET bytes = head.bytes || (SELECT string_agg(m.bytes, ''::bytea ORDER BY m.chunk) FROM merged AS m)
              WHERE ${where} AND head.chunk = 0 AND EXISTS (SELECT 1 FROM merged)`
          }),
        ),
    } satisfies BlobWrite
  }

  return access
})
