import { Cause, Crypto, Effect, Option, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ContentTooLarge } from "../../errors/content.ts"
import type { ContentRef } from "../../identity/content.ts"
import { tenantRoutingKey } from "../storage/codec.ts"
import type { ContentPoint } from "../turn/hooks.ts"
import { textArray } from "../turn/outbox.ts"
import { GRANT_LIFETIME_MS, type Grants } from "./grant.ts"

/** Bytes one content may hold. */
export const MAX_CONTENT_BYTES = 64 * 1024 * 1024

/**
 * Bytes per stored chunk: well below the driver's 16 MiB message limit, so
 * content of any size reads as one row per chunk.
 */
export const CHUNK_BYTES = 1024 * 1024

/** A tenant's content is swept at most this often. */
export const SWEEP_INTERVAL_MS = 3_600_000

/** Candidates one sweep statement considers. */
const SWEEP_BATCH = 500

/** Tenants one sweep pass claims. */
const SWEEP_TENANTS = 100

export interface ContentSettings {
  readonly grants: Grants
  /** How long unreferenced content outlives its last grant, before the turn and skew margins. */
  readonly graceMs: number
  /** The bound on clock skew between any two shards' databases. */
  readonly skewMs: number
  /**
   * PGlite has one connection, so no transaction may stay open across a
   * client's upload or download; those buffer in memory instead.
   */
  readonly singleConnection: boolean
  /** The framework clock's offset from database time; only tests move it. */
  readonly offset: () => number
  readonly hooks: { readonly at: (point: ContentPoint) => Effect.Effect<void> }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const concat = (parts: ReadonlyArray<Uint8Array>, size: number) => {
  const bytes = new Uint8Array(size)
  let offset = 0

  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }

  return bytes
}

/** Stored chunks, checked against the size its reference recorded; none when any is missing. */
const complete = (
  rows: ReadonlyArray<{ readonly chunk: number; readonly bytes: Uint8Array }>,
  size: number,
) => {
  let total = 0

  for (const [index, row] of rows.entries()) {
    if (row.chunk !== index) return Option.none()
    total += row.bytes.byteLength
  }

  // Every content has chunk 0, even an empty one, so no rows means swept.
  return rows.length > 0 && total === size
    ? Option.some(rows.map((row) => Uint8Array.from(row.bytes)))
    : Option.none()
}

export const tenantContent = (settings: ContentSettings) => {
  const { grants, hooks } = settings

  // The database clock plus the framework offset, read inside the statement
  // that uses it, so the time and the write come from one shard.
  const clock = (sql: SqlClient.SqlClient) =>
    sql`(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${settings.offset()})`

  const now = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ now: string }>`SELECT ${clock(sql)}::text AS now`

    return Number(row!.now)
  })

  const refOf = (tenant: string, hash: string, size: number, expiresAt: number) =>
    Effect.map(grants.sign({ tenant, hash, size, expiresAt }), (grant): ContentRef => ({
      hash,
      size,
      grant,
    }))

  /**
   * Creates the content row or raises its grant horizon, and registers the
   * tenant with the sweep. The returned horizon is at least the new grant's expiry.
   */
  const upsert = Effect.fnUntraced(function* (tenant: string, hash: string, size: number) {
    const sql = yield* SqlClient.SqlClient
    const key = tenantRoutingKey(tenant)

    const [row] = yield* sql<{ inserted: boolean; granted_until_ms: string }>`
      WITH swept AS (
        INSERT INTO tenant_content_sweeps (routing_key, tenant_id, swept_at_ms)
        VALUES (${key}, ${tenant}, 0) ON CONFLICT DO NOTHING)
      INSERT INTO tenant_contents (routing_key, tenant_id, hash, size, granted_until_ms)
      VALUES (${key}, ${tenant}, ${hash}, ${size}, ${clock(sql)} + ${GRANT_LIFETIME_MS})
      ON CONFLICT (routing_key, tenant_id, hash) DO UPDATE
        SET granted_until_ms = greatest(tenant_contents.granted_until_ms, EXCLUDED.granted_until_ms)
      RETURNING (xmax = 0) AS inserted, granted_until_ms::text AS granted_until_ms`

    return { inserted: row!.inserted, expiresAt: Number(row!.granted_until_ms) }
  })

  const writeChunk = Effect.fnUntraced(function* (
    tenant: string,
    hash: string,
    chunk: number,
    bytes: Uint8Array,
  ) {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO tenant_content_chunks (routing_key, tenant_id, hash, chunk, bytes)
      VALUES (${tenantRoutingKey(tenant)}, ${tenant}, ${hash}, ${chunk}, ${bytes}::bytea)`
  })

  /** Stores bytes already in memory: hashed first, so existing content writes no bytes. */
  const uploadBytes = Effect.fnUntraced(function* (tenant: string, bytes: Uint8Array) {
    const sql = yield* SqlClient.SqlClient

    if (bytes.byteLength > MAX_CONTENT_BYTES)
      return yield* ContentTooLarge.make({ maxBytes: MAX_CONTENT_BYTES })

    const hash = hex(new Bun.CryptoHasher("sha256").update(bytes).digest())
    const size = bytes.byteLength

    const stored = yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* upsert(tenant, hash, size)

        if (row.inserted)
          for (let chunk = 0; chunk === 0 || chunk * CHUNK_BYTES < size; chunk += 1)
            yield* writeChunk(
              tenant,
              hash,
              chunk,
              bytes.subarray(chunk * CHUNK_BYTES, (chunk + 1) * CHUNK_BYTES),
            )

        return row
      }),
    )

    return yield* refOf(tenant, hash, size, stored.expiresAt)
  })

  /**
   * Stores a body as it arrives, in one transaction: 1 MiB chunks are written
   * under a pending name while the body is hashed, then renamed to the hash,
   * or dropped when the tenant already holds those bytes. Past `limit` the
   * transaction rolls back, so no part of the body stays.
   */
  const uploadStream = <E>(tenant: string, body: Stream.Stream<Uint8Array, E>, limit: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      if (settings.singleConnection) {
        const parts: Array<Uint8Array> = []
        let size = 0

        yield* body.pipe(
          Stream.runForEach((part) => {
            size += part.byteLength
            parts.push(part)

            return size > limit ? ContentTooLarge.make({ maxBytes: limit }) : Effect.void
          }),
        )

        return yield* uploadBytes(tenant, concat(parts, size))
      }

      const pending = `pending:${yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)}`
      const hasher = new Bun.CryptoHasher("sha256")

      const stored = yield* sql.withTransaction(
        Effect.gen(function* () {
          let size = 0
          let chunk = 0
          let buffer = new Uint8Array(CHUNK_BYTES)
          let filled = 0

          const flush = Effect.suspend(() => {
            const bytes = buffer.slice(0, filled)
            const index = chunk
            chunk += 1
            filled = 0

            return writeChunk(tenant, pending, index, bytes)
          })

          yield* body.pipe(
            Stream.runForEach((part) =>
              Effect.gen(function* () {
                size += part.byteLength

                if (size > limit) return yield* ContentTooLarge.make({ maxBytes: limit })

                hasher.update(part)
                let read = 0

                while (read < part.byteLength) {
                  const taken = Math.min(CHUNK_BYTES - filled, part.byteLength - read)
                  buffer.set(part.subarray(read, read + taken), filled)
                  filled += taken
                  read += taken

                  if (filled === CHUNK_BYTES) {
                    yield* flush
                    buffer = new Uint8Array(CHUNK_BYTES)
                  }
                }
              }),
            ),
          )

          if (filled > 0 || chunk === 0) yield* flush

          const hash = hex(hasher.digest())
          const row = yield* upsert(tenant, hash, size)
          const key = tenantRoutingKey(tenant)

          yield* row.inserted
            ? sql`UPDATE tenant_content_chunks SET hash = ${hash}
                WHERE routing_key = ${key} AND tenant_id = ${tenant} AND hash = ${pending}`
            : sql`DELETE FROM tenant_content_chunks
                WHERE routing_key = ${key} AND tenant_id = ${tenant} AND hash = ${pending}`

          return { hash, size, expiresAt: row.expiresAt }
        }),
      )

      return yield* refOf(tenant, stored.hash, stored.size, stored.expiresAt)
    })

  /**
   * Raises the content's grant horizon and signs a grant for it; none when
   * the content no longer exists. The row lock orders the raise with a
   * sweep's delete: a raise first moves the horizon past the sweep's re-check.
   */
  const grant = Effect.fnUntraced(function* (tenant: string, hash: string, size: number) {
    const sql = yield* SqlClient.SqlClient
    yield* hooks.at("beforeRaise")

    const [row] = yield* sql<{ granted_until_ms: string }>`
      UPDATE tenant_contents
      SET granted_until_ms = greatest(granted_until_ms, ${clock(sql)} + ${GRANT_LIFETIME_MS})
      WHERE routing_key = ${tenantRoutingKey(tenant)} AND tenant_id = ${tenant}
        AND hash = ${hash} AND size = ${size}
      RETURNING granted_until_ms::text AS granted_until_ms`

    if (row === undefined) return Option.none<ContentRef>()

    return Option.some(yield* refOf(tenant, hash, size, Number(row.granted_until_ms)))
  })

  const chunksOf = (sql: SqlClient.SqlClient, tenant: string, hash: string) =>
    sql`routing_key = ${tenantRoutingKey(tenant)} AND tenant_id = ${tenant} AND hash = ${hash}`

  /** Every chunk from one statement's snapshot, so a sweep deletes all of them or none. */
  const readRows = Effect.fnUntraced(function* (tenant: string, hash: string, size: number) {
    const sql = yield* SqlClient.SqlClient
    yield* hooks.at("afterResolve")

    const rows = yield* sql<{ chunk: number; bytes: Uint8Array }>`
      SELECT chunk, bytes FROM tenant_content_chunks WHERE ${chunksOf(sql, tenant, hash)}
      ORDER BY chunk`

    return complete(rows, size)
  })

  const read = (tenant: string, hash: string, size: number) =>
    Effect.map(
      readRows(tenant, hash, size),
      Option.map((parts) => concat(parts, size)),
    )

  /**
   * The content's chunks from one read-only REPEATABLE READ snapshot held for
   * the whole stream, at most `timeoutMs`. The first statement checks every
   * chunk is there before any is emitted.
   */
  const stream = (
    tenant: string,
    hash: string,
    size: number,
    timeoutMs: number,
  ): Stream.Stream<Uint8Array, Cause.NoSuchElementError, SqlClient.SqlClient> => {
    const missing = new Cause.NoSuchElementError(`Content ${hash} is not stored`)

    if (settings.singleConnection)
      return Stream.unwrap(
        Effect.map(
          readRows(tenant, hash, size).pipe(Effect.orDie),
          Option.match({
            onNone: () => Stream.fail(missing),
            onSome: (parts) => Stream.fromArray(parts),
          }),
        ),
      )

    return Stream.unwrap(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const connection = yield* sql.reserve

        const onSnapshot = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, sql.transactionService, [connection, 0])

        yield* Effect.acquireRelease(
          onSnapshot(sql.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")),
          () => onSnapshot(sql.unsafe("ROLLBACK")).pipe(Effect.ignore),
        )

        yield* hooks.at("afterResolve")

        const [head] = yield* onSnapshot(
          sql<{ chunks: number; last: number | null; bytes: number }>`
            SELECT count(*)::int AS chunks, max(chunk) AS last,
              COALESCE(sum(octet_length(bytes)), 0)::float8 AS bytes
            FROM tenant_content_chunks WHERE ${chunksOf(sql, tenant, hash)}`,
        )

        if (head!.chunks === 0 || head!.last !== head!.chunks - 1 || head!.bytes !== size)
          return Stream.fail(missing)

        return Stream.range(0, head!.chunks - 1).pipe(
          Stream.mapEffect((chunk) =>
            onSnapshot(
              sql<{ bytes: Uint8Array }>`SELECT bytes FROM tenant_content_chunks
                WHERE ${chunksOf(sql, tenant, hash)} AND chunk = ${chunk}`,
            ).pipe(
              Effect.map(([row]) => Uint8Array.from(row!.bytes)),
              Effect.orDie,
            ),
          ),
        )
      }).pipe(Effect.orDie),
    ).pipe(
      Stream.interruptWhen(
        Effect.sleep(timeoutMs).pipe(
          Effect.andThen(Effect.die(new Error("A content stream outlived commandTimeout"))),
        ),
      ),
    )
  }

  /**
   * Deletes content no actor references once its last grant is more than
   * `grace + T` old, where `T` is the longest turn of any actor type that
   * declares content. Candidates come from before a reference scan, and the
   * delete re-checks the grant horizon against `sweep start − T − S`: a
   * reference committed after its shard was scanned was attached under a
   * grant that keeps the horizon past it. Each tenant goes at most once an
   * hour, unless `force`.
   */
  const sweep = Effect.fnUntraced(function* (force: boolean) {
    const sql = yield* SqlClient.SqlClient
    const started = yield* now

    const tenants = force
      ? yield* sql<{ routing_key: string; tenant_id: string }>`
          SELECT routing_key::text AS routing_key, tenant_id FROM tenant_content_sweeps`
      : yield* sql<{ routing_key: string; tenant_id: string }>`
          UPDATE tenant_content_sweeps SET swept_at_ms = ${started}
          WHERE (routing_key, tenant_id) IN (
            SELECT routing_key, tenant_id FROM tenant_content_sweeps
            WHERE swept_at_ms <= ${started - SWEEP_INTERVAL_MS}
            LIMIT ${SWEEP_TENANTS} FOR UPDATE SKIP LOCKED)
          RETURNING routing_key::text AS routing_key, tenant_id`

    const [longest] = yield* sql<{ turn_ms: number }>`
      SELECT COALESCE(max(turn_ms), 0)::float8 AS turn_ms FROM actor_content_types`

    const turnMs = longest!.turn_ms
    let deleted = 0

    for (const { routing_key, tenant_id: tenant } of tenants) {
      const key = BigInt(routing_key)
      const sweepStart = yield* now
      const candidateBefore = sweepStart - settings.graceMs - turnMs - settings.skewMs
      const recheckBefore = sweepStart - turnMs - settings.skewMs
      let after = { granted: Number.MIN_SAFE_INTEGER, hash: "" }

      for (;;) {
        const candidates = yield* sql<{ hash: string; granted_until_ms: string }>`
          SELECT hash, granted_until_ms::text AS granted_until_ms FROM tenant_contents
          WHERE routing_key = ${key} AND tenant_id = ${tenant}
            AND granted_until_ms < ${candidateBefore}
            AND (granted_until_ms, hash) > (${after.granted}, ${after.hash})
          ORDER BY granted_until_ms, hash LIMIT ${SWEEP_BATCH}`

        if (candidates.length === 0) break

        const last = candidates.at(-1)!
        after = { granted: Number(last.granted_until_ms), hash: last.hash }

        // On a sharded backend this is the scatter across every actor shard.
        const referenced = new Set(
          (yield* sql<{ hash: string }>`
            SELECT DISTINCT hash FROM actor_content_refs
            WHERE tenant_id = ${tenant}
              AND hash = ANY(${textArray({ sql, values: candidates.map((row) => row.hash) })})`).map(
            (row) => row.hash,
          ),
        )

        yield* hooks.at("afterReferenceScan")

        const unreferenced = candidates
          .map((row) => row.hash)
          .filter((hash) => !referenced.has(hash))

        if (unreferenced.length === 0) continue

        // One statement, so a content row and its chunks go together.
        const [gone] = yield* sql<{ deleted: number }>`
          WITH gone AS (
            DELETE FROM tenant_contents
            WHERE routing_key = ${key} AND tenant_id = ${tenant}
              AND hash = ANY(${textArray({ sql, values: unreferenced })})
              AND granted_until_ms < ${recheckBefore}
            RETURNING hash),
          chunks AS (
            DELETE FROM tenant_content_chunks c USING gone
            WHERE c.routing_key = ${key} AND c.tenant_id = ${tenant} AND c.hash = gone.hash)
          SELECT count(*)::int AS deleted FROM gone`

        deleted += gone!.deleted
      }
    }

    return deleted
  })

  return { uploadBytes, uploadStream, grant, read, stream, sweep, verify: grants.verify }
}

export type ContentStoreImpl = ReturnType<typeof tenantContent>
