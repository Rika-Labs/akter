import { Cause, Effect, Option, Predicate, Result, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { inTenant, TenantScope } from "../database/tenancy.ts"
import { InvalidContentRef } from "../../errors/content.ts"
import { ContentRef } from "../../identity/content.ts"
import { type AnyBlob, isContent } from "../../members/blob.ts"
import type {
  BlobAccess,
  BlobRead,
  BlobScope,
  BlobWrite,
  ContentRead,
  ContentWrite,
} from "../../state/blob.ts"
import type { ContentStoreImpl } from "../content/store.ts"
import { routingKey as routingKeyOf } from "../storage/codec.ts"

/** UTF-8 bytes of an entry name; the name shares a btree key with the ownership columns. */
export const MAX_NAME_BYTES = 512

/**
 * Bytes one entry may hold. `get` returns an entry as one row, and the Postgres
 * driver closes a connection on any message over 16 MiB, so an entry stays well below it.
 */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024

/** What content references need from the runtime: its store, the skew margin, and the clock offset. */
export interface ContentBinding {
  readonly store: ContentStoreImpl
  readonly skewMs: number
  readonly offset: () => number
}

const isContentRef = Schema.is(ContentRef)

/**
 * Binds blob capabilities to the calling fiber's turn or query. Every row is
 * addressed by the trusted scope, so equal blob and entry names of two actors
 * or tenants never meet; writes run on the turn's connection, inside its
 * savepoint, and roll back with it. Off-turn contexts get read methods only,
 * and turns get no content bytes.
 *
 * Declared blobs, names, and byte arrays are checked on every call, so misuse
 * is a defect of the turn. Entry names reject lone surrogates, which Postgres
 * would turn into U+FFFD and alias another name, and NUL. Byte arrays are
 * copied on the way in and out, since the caller may reuse its buffer and a
 * driver may decode into a pooled one. Content references count against the
 * entry cap with the actor's own entries, and an existing entry stays
 * writable at the cap; the quota is named only after a write changed nothing.
 * A set overwrites chunk 0 and drops the rest in one statement that changes
 * nothing past the quota, so a caught defect leaves the entry whole. Turns of
 * one actor serialize on its generation lock, so an appended chunk index is
 * free at insert. Attaching content verifies its grant by MAC without a read
 * and requires the grant to outlive this shard's clock by the skew margin, so
 * the tenant shard's sweep sees a horizon past this turn's commit. Content
 * keys are required only when a content blob is used.
 */
export const bindBlobs = Effect.fnUntraced(function* (
  scope: BlobScope,
  write: boolean,
  content: ContentBinding | undefined,
) {
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

  const references = sql`(SELECT count(*) FROM actor_content_refs WHERE ${owner})`

  const tooManyEntries = Effect.die(
    new Error(`One actor's blobs hold at most ${scope.maxEntries} entries (policy.maxBlobEntries)`),
  )

  const declared = Effect.fnUntraced(function* (blob: AnyBlob) {
    yield* scope.guard

    if (!scope.blobs.includes(blob))
      return yield* Effect.die(
        new Error(`${String(blob?.name)} is not a declared blob of ${ref.actor}`),
      )
  })

  const entry = Effect.fnUntraced(function* (blob: AnyBlob, name: string) {
    yield* declared(blob)

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

  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      (bound) =>
        Option.isSome(connection)
          ? Effect.provideService(bound, sql.transactionService, connection.value)
          : inTenant({ sql, role, tenant: ref.tenant })(bound),
      Effect.orDie,
    )

  const contentAccess = (blob: AnyBlob): ContentRead | ContentWrite => {
    const bound = Effect.suspend(() =>
      content === undefined
        ? Effect.die(new Error("Content blobs need the runtime's content.keys"))
        : Effect.succeed(content),
    )

    const list = run(
      Effect.gen(function* () {
        yield* declared(blob)

        const rows = yield* sql<{ name: string; hash: string; size: number }>`
            SELECT name, hash, size::float8 AS size FROM actor_content_refs
            WHERE ${owner} AND blob = ${blob.name} ORDER BY name COLLATE "C"`

        return rows.map(({ name, hash, size }) => ({ name, hash, size }))
      }),
    )

    const resolve = (name: string) =>
      run(
        Effect.gen(function* () {
          const where = yield* entry(blob, name)

          const [found] = yield* sql<{ hash: string; size: number }>`
            SELECT hash, size::float8 AS size FROM actor_content_refs WHERE ${where}`

          return Option.fromUndefinedOr(found)
        }),
      )

    if (!write)
      return {
        get: (name) =>
          Effect.gen(function* () {
            const { store } = yield* bound
            const found = yield* resolve(name)

            if (Option.isNone(found)) return Option.none<Uint8Array>()

            return yield* store
              .read(ref.tenant, found.value.hash, found.value.size)
              .pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)
          }),
        stream: (name) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const { store } = yield* bound
              const found = yield* resolve(name)

              if (Option.isNone(found))
                return Stream.fail(new Cause.NoSuchElementError(`No content entry ${name}`))

              return store
                .stream(ref.tenant, found.value.hash, found.value.size, scope.timeoutMs)
                .pipe(Stream.provideService(SqlClient.SqlClient, sql))
            }),
          ),
        list,
      } satisfies ContentRead

    return {
      attach: (name, contentRef) =>
        Effect.gen(function* () {
          const { store, skewMs, offset } = yield* bound
          const where = yield* run(entry(blob, name))

          if (!isContentRef(contentRef))
            return yield* InvalidContentRef.make({ reason: "malformed" })

          const verified = yield* store.verify(contentRef.grant, {
            tenant: ref.tenant,
            hash: contentRef.hash,
            size: contentRef.size,
          })

          if (Result.isFailure(verified))
            return yield* InvalidContentRef.make({ reason: verified.failure })

          const [checked] = yield* run(
            sql<{ live: boolean; fits: boolean }>`WITH used AS (
                SELECT ${verified.success} > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                    + ${offset() + skewMs} AS live,
                  EXISTS (SELECT 1 FROM actor_content_refs WHERE ${where}) AS present,
                  (SELECT count(*) FROM actor_blobs WHERE ${owner} AND chunk = 0) + ${references} AS entries),
              attached AS (
                INSERT INTO actor_content_refs (routing_key, tenant_id, actor_type, actor_id, blob, name, hash, size)
                SELECT ${routingKey}, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${blob.name}, ${name},
                  ${contentRef.hash}, ${contentRef.size}
                FROM used WHERE live AND (present OR entries < ${scope.maxEntries})
                ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, blob, name)
                DO UPDATE SET hash = EXCLUDED.hash, size = EXCLUDED.size)
              SELECT live, present OR entries < ${scope.maxEntries} AS fits FROM used`,
          )

          if (!checked!.live) return yield* InvalidContentRef.make({ reason: "expired" })

          if (!checked!.fits) return yield* tooManyEntries
        }),
      detach: (name) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(blob, name)

            yield* sql`DELETE FROM actor_content_refs WHERE ${where}`
          }),
        ),
      list,
    } satisfies ContentWrite
  }

  const access: BlobAccess = (blob: AnyBlob) => {
    if (isContent(blob)) return contentAccess(blob)

    const copy = (bytes: Uint8Array) => {
      if (!(bytes instanceof Uint8Array))
        return Effect.die(new Error("Blob bytes are a Uint8Array"))

      return bytes.byteLength > MAX_ENTRY_BYTES ? oversized : Effect.succeed(Uint8Array.from(bytes))
    }

    const oversized = Effect.die(new Error(`A blob entry holds at most ${MAX_ENTRY_BYTES} bytes`))

    const read: BlobRead = {
      get: (name) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(blob, name)

            const [found] = yield* sql<{ bytes: Uint8Array | null }>`
              SELECT string_agg(bytes, ''::bytea ORDER BY chunk) AS bytes
              FROM actor_blobs WHERE ${where}`

            const bytes = found?.bytes ?? null

            return bytes === null ? Option.none<Uint8Array>() : Option.some(Uint8Array.from(bytes))
          }),
        ),
    }

    if (!write) return read

    const values = (name: string, chunk: ReturnType<typeof sql.literal>, bytes: Uint8Array) =>
      sql`${routingKey}::bigint, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${blob.name}, ${name}, ${chunk}, ${bytes}::bytea`

    const usage = (where: Effect.Success<ReturnType<typeof entry>>) =>
      sql<{ entries: number; present: boolean; entry_bytes: number }>`
        SELECT (count(*) FILTER (WHERE chunk = 0) + ${references})::float8 AS entries,
          COALESCE(bool_or(${where}), false) AS present,
          COALESCE(sum(octet_length(bytes)) FILTER (WHERE ${where}), 0)::float8 AS entry_bytes
        FROM actor_blobs WHERE ${owner}`.pipe(Effect.map(([row]) => row!))

    const refused = (used: { readonly entries: number; readonly present: boolean }) =>
      !used.present && used.entries >= scope.maxEntries ? tooManyEntries : overQuota

    return {
      ...read,
      set: (name, bytes) =>
        run(
          Effect.gen(function* () {
            const where = yield* entry(blob, name)
            const copied = yield* copy(bytes)

            const written = yield* sql`WITH used AS (
                SELECT COALESCE(sum(octet_length(bytes)) FILTER (WHERE NOT (${where})), 0) AS other,
                  count(*) FILTER (WHERE chunk = 0) + ${references} AS entries,
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
            const where = yield* entry(blob, name)
            const copied = yield* copy(bytes)

            const inserted =
              yield* sql`INSERT INTO actor_blobs (routing_key, tenant_id, actor_type, actor_id, blob, name, chunk, bytes)
              SELECT ${values(name, sql.literal("COALESCE(max(chunk) FILTER (WHERE entry) + 1, 0)"), copied)}
              FROM (SELECT chunk, bytes, (${where}) AS entry FROM actor_blobs WHERE ${owner}) AS owned
              HAVING COALESCE(sum(octet_length(bytes)) FILTER (WHERE entry), 0) + ${copied.byteLength} <= ${MAX_ENTRY_BYTES}
                AND COALESCE(sum(octet_length(bytes)), 0) + ${copied.byteLength} <= ${scope.maxBytes}
                AND (bool_or(entry) OR count(*) FILTER (WHERE chunk = 0) + ${references} < ${scope.maxEntries})
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
            const where = yield* entry(blob, name)

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
            const where = yield* entry(blob, name)

            yield* sql`DELETE FROM actor_blobs WHERE ${where}`
          }),
        ),
    } satisfies BlobWrite
  }

  return access
})
