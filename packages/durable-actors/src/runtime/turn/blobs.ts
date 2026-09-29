import { Effect, Option, Predicate } from "effect"
import { inTenant, TenantScope } from "../database/tenancy.ts"
import { SqlClient } from "effect/unstable/sql"
import type { AnyBlob } from "../../members/blob.ts"
import type { BlobAccess, BlobRead, BlobScope, BlobWrite } from "../../state/blob.ts"
import { routingKey as routingKeyOf } from "../storage/codec.ts"

/** UTF-8 bytes of an entry name; the name shares a btree key with the ownership columns. */
export const MAX_NAME_BYTES = 512

/**
 * Bytes one entry may hold. `get` returns an entry as one row, and the Postgres
 * driver closes a connection on any message over 16 MiB, so an entry stays well below it.
 */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024

/**
 * Binds blob capabilities to the calling fiber's turn or query. Every row is
 * addressed by the trusted scope, so equal blob and entry names of two actors
 * or tenants never meet; writes run on the turn's connection, inside its
 * savepoint, and roll back with it.
 */
export const bindBlobs = Effect.fnUntraced(function* (scope: BlobScope, write: boolean) {
  const sql = yield* SqlClient.SqlClient
  const connection = yield* Effect.serviceOption(sql.transactionService)
  const { role } = yield* TenantScope

  if (write && Option.isNone(connection))
    return yield* Effect.die(new Error("Blob writes need the turn transaction"))

  const { ref } = scope
  const routingKey = routingKeyOf({ ref, placement: scope.placement })

  const owner = sql`routing_key = ${routingKey} AND tenant_id = ${ref.tenant}
    AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

  const overQuota = Effect.die(
    new Error(`One actor's blobs hold at most ${scope.maxBytes} bytes (policy.maxBlobBytes)`),
  )

  const tooManyEntries = Effect.die(
    new Error(`One actor's blobs hold at most ${scope.maxEntries} entries (policy.maxBlobEntries)`),
  )

  const access: BlobAccess = (blob: AnyBlob) => {
    // Checked per call, like owned rows, so a misuse is a defect of the turn.
    const entry = Effect.fnUntraced(function* (name: string) {
      yield* scope.guard

      if (!scope.blobs.includes(blob))
        return yield* Effect.die(
          new Error(`${String(blob?.name)} is not a declared blob of ${ref.actor}`),
        )

      // A lone surrogate would reach Postgres as U+FFFD and alias another name; NUL is rejected by Postgres.
      if (
        !Predicate.isString(name) ||
        name.length === 0 ||
        new TextEncoder().encode(name).byteLength > MAX_NAME_BYTES ||
        !name.isWellFormed() ||
        name.includes("\u0000")
      )
        return yield* Effect.die(
          new Error(
            `Blob entry names are well-formed strings of 1-${MAX_NAME_BYTES} UTF-8 bytes without NUL`,
          ),
        )

      return sql`${owner} AND blob = ${blob.name} AND name = ${name}`
    })

    // A copy taken once, so later changes to the caller's buffer never reach the row.
    const copy = (bytes: Uint8Array) => {
      if (!(bytes instanceof Uint8Array))
        return Effect.die(new Error("Blob bytes are a Uint8Array"))

      return bytes.byteLength > MAX_ENTRY_BYTES ? oversized : Effect.succeed(Uint8Array.from(bytes))
    }

    const oversized = Effect.die(new Error(`A blob entry holds at most ${MAX_ENTRY_BYTES} bytes`))

    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        // Reads outside a transaction, as in a stream handler, take their own tenant transaction.
        (bound) =>
          Option.isSome(connection)
            ? Effect.provideService(bound, sql.transactionService, connection.value)
            : inTenant({ sql, role, tenant: ref.tenant })(bound),
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

            // A copy: a driver may decode into a pooled buffer shared with unrelated values.
            return bytes === null ? Option.none<Uint8Array>() : Option.some(Uint8Array.from(bytes))
          }),
        ),
    }

    // Off-turn contexts get no mutation methods at all, whatever their static type.
    if (!write) return read

    const values = (name: string, chunk: ReturnType<typeof sql.literal>, bytes: Uint8Array) =>
      sql`${routingKey}::bigint, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${blob.name}, ${name}, ${chunk}, ${bytes}::bytea`

    // Read only after a write changed nothing, to name the quota it would pass.
    const usage = (where: Effect.Success<ReturnType<typeof entry>>) =>
      sql<{ entries: number; present: boolean; entry_bytes: number }>`
        SELECT count(*) FILTER (WHERE chunk = 0)::float8 AS entries,
          COALESCE(bool_or(${where}), false) AS present,
          COALESCE(sum(octet_length(bytes)) FILTER (WHERE ${where}), 0)::float8 AS entry_bytes
        FROM actor_blobs WHERE ${owner}`.pipe(Effect.map(([row]) => row!))

    // Chunk 0 heads every entry, so counting it counts entries; an existing
    // entry stays writable even when the actor already holds the maximum.
    const refused = (used: { readonly entries: number; readonly present: boolean }) =>
      !used.present && used.entries >= scope.maxEntries ? tooManyEntries : overQuota

    return {
      ...read,
      set: (name, bytes) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(name)
            const copied = yield* copy(bytes)

            // Chunk 0 always heads an entry, so a set overwrites it and drops the
            // rest. The entry's old bytes don't count against the quota, and past
            // it the statement changes nothing, so a caught defect leaves the entry whole.
            const written = yield* sql`WITH used AS (
                SELECT COALESCE(sum(octet_length(bytes)) FILTER (WHERE NOT (${where})), 0) AS other,
                  count(*) FILTER (WHERE chunk = 0) AS entries,
                  COALESCE(bool_or(${where}), false) AS present
                FROM actor_blobs WHERE ${owner}),
              fits AS (
                SELECT 1 FROM used WHERE other + ${copied.byteLength} <= ${scope.maxBytes}
                  AND (present OR entries < ${scope.maxEntries})),
              dropped AS (
                DELETE FROM actor_blobs WHERE ${where} AND chunk > 0 AND EXISTS (SELECT 1 FROM fits))
              INSERT INTO actor_blobs (routing_key, tenant_id, actor_type, actor_id, blob, name, chunk, bytes)
              SELECT ${values(name, sql.literal("0"), copied)} FROM fits
              ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, blob, name, chunk)
              DO UPDATE SET bytes = EXCLUDED.bytes
              RETURNING chunk`

            if (written.length === 0) return yield* refused(yield* usage(where))
          }),
        ),
      append: (name, bytes) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(name)
            const copied = yield* copy(bytes)

            // Turns of one actor are serialized by its generation lock, so the next
            // chunk is free and the size read here still holds at insert.
            const inserted =
              yield* sql`INSERT INTO actor_blobs (routing_key, tenant_id, actor_type, actor_id, blob, name, chunk, bytes)
              SELECT ${values(name, sql.literal("COALESCE(max(chunk) FILTER (WHERE entry) + 1, 0)"), copied)}
              FROM (SELECT chunk, bytes, (${where}) AS entry FROM actor_blobs WHERE ${owner}) AS owned
              HAVING COALESCE(sum(octet_length(bytes)) FILTER (WHERE entry), 0) + ${copied.byteLength} <= ${MAX_ENTRY_BYTES}
                AND COALESCE(sum(octet_length(bytes)), 0) + ${copied.byteLength} <= ${scope.maxBytes}
                AND (bool_or(entry) OR count(*) FILTER (WHERE chunk = 0) < ${scope.maxEntries})
              RETURNING chunk`

            if (inserted.length === 0) {
              const used = yield* usage(where)

              return yield* used.entry_bytes + copied.byteLength > MAX_ENTRY_BYTES
                ? oversized
                : refused(used)
            }
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
      delete: (name) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(name)

            yield* sql`DELETE FROM actor_blobs WHERE ${where}`
          }),
        ),
    } satisfies BlobWrite
  }

  return access
})
