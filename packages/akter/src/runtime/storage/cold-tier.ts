import { PgClient } from "@effect/sql-pg"
import { Context, Crypto, Data, Duration, Effect, Fiber, Schema, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import type { ActorRef } from "../../identity/caller.ts"
import { System } from "../../identity/caller.ts"
import { sha256Bytes } from "../../identity/digest.ts"
import { VERSION_KEY } from "../../state/migration.ts"
import { databaseTime, FrameworkClock } from "../turn/admission.ts"
import { CallerJson, bucketOf } from "../turn/outbox.ts"
import { compress, decompress } from "./codec.ts"
import { ColdStorageError, type ColdObject, type ColdStorage } from "./cold-storage.ts"
import { actorRow, type OwnedActor } from "./generation.ts"

/** Cold-state lifecycle and the configured database backup horizon. */
export interface ColdStorageOptions {
  readonly store: ColdStorage
  /** Longest supported database backup age. Must match the operator's retention policy. */
  readonly backupRetention: Duration.Input
  /** Additional object retention. Default 24 hours. */
  readonly grace?: Duration.Input
  /** Deadline for one object operation. Default 30 seconds. */
  readonly timeout?: Duration.Input
  /** Offloads running at once per runner, separate from job executors. Default 4. */
  readonly concurrency?: number
  /** Renewable offload lease. Default 60 seconds, at least 3 seconds. */
  readonly lease?: Duration.Input
}

/** The durable pointer tuple a fetch must still match at renewed admission. */
export interface ColdPointer {
  readonly ref: string
  readonly digest: string
  readonly version: number
}

const Envelope = Schema.Struct({
  format: Schema.Literal(1),
  codec: Schema.Literal(1),
  tenant: Schema.String,
  actor: Schema.String,
  id: Schema.String,
  routingKey: Schema.String,
  generation: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  blobs: Schema.Array(
    Schema.Struct({
      blob: Schema.String,
      name: Schema.String,
      chunk: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      bytes: Schema.String,
    }),
  ),
})

/** Fetched bytes are not a committed activation snapshot until restoration commits. */
export interface ColdMaterial extends ColdPointer {
  readonly envelope: typeof Envelope.Type
}

/** Abandons ordinary fenced admission without running or publishing any handler. */
export class FetchCold extends Data.TaggedError("FetchCold")<{
  readonly pointer: ColdPointer
}> {}

/** A leased cold outbox row; it is never delivered to an application command. */
export interface ColdClaim {
  readonly routing_key: string
  readonly tenant_id: string
  readonly actor_type: string
  readonly actor_id: string
  readonly intent_id: string
  readonly attempts: number
  readonly claimed_until: string
}

/** Test-only boundaries for an offload and object collection. */
export type ColdPoint =
  | "afterSnapshot"
  | "afterUpload"
  | "afterFlip"
  | "beforeGarbageCheck"
  | "beforeDelete"
  | "afterDelete"

export const ColdHooks = Context.Reference<{
  readonly at: (point: ColdPoint, actor: ActorRef) => Effect.Effect<void>
  readonly periodic: boolean
}>("akter/ColdHooks", {
  defaultValue: () => ({ at: () => Effect.void, periodic: true }),
})

/** The configured tier, absent on deployments that keep every actor in Postgres. */
export const ColdTier = Context.Reference<Effect.Success<ReturnType<typeof coldTier>> | undefined>(
  "akter/ColdTier",
  { defaultValue: () => undefined },
)

const digestOf = (bytes: Uint8Array) => Buffer.from(sha256Bytes(bytes)).toString("hex")

const objectKey = (deployment: string, envelope: typeof Envelope.Type, digest: string) =>
  [
    deployment,
    encodeURIComponent(envelope.tenant),
    envelope.actor,
    envelope.routingKey,
    digestOf(new TextEncoder().encode(envelope.id)),
    `${envelope.generation}-${digest}`,
  ].join("/")

const decode = (bytes: Uint8Array) =>
  Effect.sync(() => decompress(bytes)).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Envelope))),
    Effect.orDie,
  )

/**
 * Owns the timer, upload-before-flip protocol, restoration writes, and both
 * collectors. Generation rows are authority; object calls use no database
 * transaction, and a candidate is deleted only after fresh durable checks.
 */
export const coldTier = Effect.fnUntraced(function* (
  options: ColdStorageOptions,
  deployment: string,
  maxBackoffMs: number,
) {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const clock = yield* FrameworkClock
  const hooks = yield* ColdHooks
  const { store } = options
  const duration = (name: string, input: Duration.Input, minimum = 0) => {
    const millis = Duration.toMillis(input)

    if (!Number.isSafeInteger(millis) || millis < minimum)
      throw new Error(`coldStorage.${name} must be finite whole milliseconds, at least ${minimum}`)

    return millis
  }
  const retentionMs =
    duration("backupRetention", options.backupRetention, 1) +
    duration("grace", options.grace ?? "24 hours")
  const timeoutMs = duration("timeout", options.timeout ?? "30 seconds", 1)
  const leaseMs = duration("lease", options.lease ?? "60 seconds", 3000)
  const concurrency = options.concurrency ?? 4

  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("coldStorage.concurrency must be a positive integer")

  const objectIO = <A>(effect: Effect.Effect<A, ColdStorageError>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new ColdStorageError({ cause: new Error("Cold object operation timed out") }),
          ),
      }),
    )

  const fetch = Effect.fnUntraced(function* (actor: OwnedActor, pointer: ColdPointer) {
    if ((yield* Effect.serviceOption(sql.transactionService))._tag === "Some")
      return yield* Effect.die(new Error("Cold object fetch cannot hold a transaction"))

    const bytes = yield* objectIO(store.get(pointer.ref))

    if (digestOf(bytes) !== pointer.digest)
      return yield* Effect.die(new Error(`Cold object digest mismatch: ${pointer.ref}`))

    const envelope = yield* decode(bytes)

    if (
      envelope.tenant !== actor.ref.tenant ||
      envelope.actor !== actor.ref.actor ||
      envelope.id !== actor.ref.id ||
      envelope.routingKey !== String(actor.key) ||
      envelope.version !== pointer.version ||
      objectKey(deployment, envelope, pointer.digest) !== pointer.ref
    )
      return yield* Effect.die(new Error(`Cold object envelope mismatch: ${pointer.ref}`))

    return { ...pointer, envelope } satisfies ColdMaterial
  })

  const garbage = (actor: OwnedActor, key: string) =>
    Effect.asVoid(sql`INSERT INTO actor_cold_garbage
      (routing_key, tenant_id, actor_type, actor_id, object_key, unreferenced_at_ms)
      VALUES (${actor.key}, ${actor.ref.tenant}, ${actor.ref.actor}, ${actor.ref.id}, ${key},
        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${clock.offsetMillis()})
      ON CONFLICT (routing_key, object_key) DO UPDATE
      SET unreferenced_at_ms = greatest(actor_cold_garbage.unreferenced_at_ms, EXCLUDED.unreferenced_at_ms)`)

  const restore = Effect.fnUntraced(function* (actor: OwnedActor, material: ColdMaterial) {
    const { ref, key } = actor

    if (material.envelope.state.length > 0)
      yield* sql`INSERT INTO actor_state ${sql.insert(
        material.envelope.state.map(([name, value]) => ({
          routing_key: key,
          tenant_id: ref.tenant,
          actor_type: ref.actor,
          actor_id: ref.id,
          key: name,
          value: compress(value),
        })),
      )}`

    for (const chunk of material.envelope.blobs)
      yield* sql`INSERT INTO actor_blobs ${sql.insert({
        routing_key: key,
        tenant_id: ref.tenant,
        actor_type: ref.actor,
        actor_id: ref.id,
        blob: chunk.blob,
        name: chunk.name,
        chunk: chunk.chunk,
        bytes: Buffer.from(chunk.bytes, "base64"),
      })}`

    yield* sql`UPDATE actor_generations SET cold_ref = NULL, cold_digest = NULL, cold_state_version = NULL
      WHERE ${actorRow({ sql, actor })} AND cold_ref = ${material.ref}`
    yield* garbage(actor, material.ref)
  })

  const hibernate = Effect.fnUntraced(function* (
    actor: OwnedActor,
    generation: string,
    delayMs: number,
  ) {
    const now = yield* databaseTime.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(FrameworkClock, clock),
    )
    const intentId = yield* crypto.randomUUIDv4.pipe(Effect.orDie)
    const caller = yield* Schema.encodeEffect(CallerJson)(System.make({ source: "cold" })).pipe(
      Effect.orDie,
    )
    const due = now + delayMs
    yield* sql`WITH held AS MATERIALIZED (
        SELECT 1 FROM actor_generations WHERE ${actorRow({ sql, actor })}
          AND generation = ${generation} AND cold_ref IS NULL FOR SHARE)
      INSERT INTO actor_outbox (routing_key, intent_id, bucket, kind, due_at_ms, scheduled_at_ms,
        tenant_id, actor_type, actor_id, timer_key, target_type, target_id, command, payload, caller)
      SELECT ${actor.key}, ${intentId}, ${bucketOf(actor.key)}, 'cold', ${due}, ${due},
        ${actor.ref.tenant}, ${actor.ref.actor}, ${actor.ref.id}, '$cold', ${actor.ref.actor},
        ${actor.ref.id}, '$cold', 'null', ${caller} FROM held
      ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, timer_key) WHERE timer_key IS NOT NULL
      DO UPDATE SET intent_id = EXCLUDED.intent_id, kind = 'cold', due_at_ms = EXCLUDED.due_at_ms,
        scheduled_at_ms = EXCLUDED.scheduled_at_ms, attempts = 0, last_error = NULL,
        target_type = EXCLUDED.target_type, target_id = EXCLUDED.target_id,
        command = EXCLUDED.command, payload = EXCLUDED.payload, caller = EXCLUDED.caller`
  })

  const offload = Effect.fnUntraced(function* (row: ColdClaim) {
    const actor: OwnedActor = {
      key: BigInt(row.routing_key),
      ref: {
        tenant: row.tenant_id,
        actor: row.actor_type,
        id: row.actor_id,
      },
    }
    const where = actorRow({ sql, actor })
    const lease = { until: Number(row.claimed_until) }
    const claimed = () => sql`routing_key = ${actor.key} AND intent_id = ${row.intent_id}
      AND kind = 'cold' AND attempts = ${row.attempts} AND due_at_ms = ${lease.until}`
    const renew = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(leaseMs / 3)
        const until =
          (yield* databaseTime.pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(FrameworkClock, clock),
          )) + leaseMs
        const rows =
          yield* sql`UPDATE actor_outbox SET due_at_ms = ${until} WHERE ${claimed()} RETURNING intent_id`

        if (rows.length === 0) return
        lease.until = until
      }
    })

    const perform = Effect.gen(function* () {
      const snapshot = yield* sql<{
        generation: string | null
        cold_ref: string | null
        key: string | null
        value: Uint8Array | null
        blob: string | null
        name: string | null
        chunk: number | null
      }>`SELECT generation::text, cold_ref, NULL::text AS key, NULL::bytea AS value,
          NULL::text AS blob, NULL::text AS name, NULL::integer AS chunk
        FROM actor_generations WHERE ${where}
        UNION ALL SELECT NULL, NULL, key, value, NULL, NULL, NULL FROM actor_state WHERE ${where}
        UNION ALL SELECT NULL, NULL, NULL, bytes, blob, name, chunk FROM actor_blobs WHERE ${where}`
      const held = snapshot.find((value) => value.generation !== null)

      if (held === undefined || held.cold_ref !== null) {
        yield* sql`DELETE FROM actor_outbox WHERE ${claimed()}`

        return
      }

      const state = snapshot
        .filter((value) => value.key !== null)
        .map(({ key, value }) => [key!, decompress(value!)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      const blobs = snapshot
        .filter((value) => value.blob !== null)
        .map(({ blob, name, chunk, value }) => ({
          blob: blob!,
          name: name!,
          chunk: chunk!,
          bytes: Buffer.from(value!).toString("base64"),
        }))
        .sort((a, b) =>
          a.blob < b.blob
            ? -1
            : a.blob > b.blob
              ? 1
              : a.name < b.name
                ? -1
                : a.name > b.name
                  ? 1
                  : a.chunk - b.chunk,
        )

      yield* hooks.at("afterSnapshot", actor.ref)

      if (state.length === 0 && blobs.length === 0) {
        yield* sql`DELETE FROM actor_outbox WHERE ${claimed()}
          AND EXISTS (SELECT 1 FROM actor_generations WHERE ${where} AND generation = ${held.generation!})`

        return
      }

      const envelope = Envelope.make({
        format: 1,
        codec: 1,
        tenant: actor.ref.tenant,
        actor: actor.ref.actor,
        id: actor.ref.id,
        routingKey: String(actor.key),
        generation: held.generation!,
        version: Number(state.find(([key]) => key === VERSION_KEY)?.[1] ?? "0"),
        state,
        blobs,
      })
      const bytes = compress(JSON.stringify(envelope))
      const digest = digestOf(bytes)
      const key = objectKey(deployment, envelope, digest)

      if (!(yield* objectIO(store.put(key, bytes)))) {
        const previous = yield* objectIO(store.get(key))

        if (digestOf(previous) !== digest)
          return yield* Effect.die(
            new Error(`Existing immutable cold object has different bytes: ${key}`),
          )
      }

      yield* hooks.at("afterUpload", actor.ref)

      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [current] = yield* sql<{ generation: string; cold_ref: string | null }>`
          SELECT generation::text, cold_ref FROM actor_generations WHERE ${where} FOR UPDATE`
          const claim = yield* sql`SELECT 1 FROM actor_outbox WHERE ${claimed()} FOR UPDATE`

          if (claim.length === 0) return

          if (current?.generation === held.generation && current.cold_ref === null) {
            yield* sql`UPDATE actor_generations SET cold_ref = ${key}, cold_digest = ${digest},
            cold_state_version = ${envelope.version} WHERE ${where}`
            yield* sql`DELETE FROM actor_state WHERE ${where}`
            yield* sql`DELETE FROM actor_blobs WHERE ${where}`
          } else if (current?.cold_ref !== key) yield* garbage(actor, key)

          yield* sql`DELETE FROM actor_outbox WHERE ${claimed()}`
        }),
      )

      yield* hooks.at("afterFlip", actor.ref)
    })

    yield* Effect.scoped(
      Effect.gen(function* () {
        const renewal = yield* renew.pipe(Effect.forkScoped)
        yield* perform.pipe(Effect.ensuring(Fiber.interrupt(renewal)))
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cold offload failed; retaining its durable retry", cause).pipe(
          Effect.andThen(
            databaseTime.pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.provideService(FrameworkClock, clock),
            ),
          ),
          Effect.flatMap(
            (
              now,
            ) => sql`UPDATE actor_outbox SET due_at_ms = ${now + Math.min(1000 * 2 ** Math.min(row.attempts - 1, 31), maxBackoffMs)},
          last_error = ${String(cause)} WHERE ${claimed()}`,
          ),
          Effect.ignore,
        ),
      ),
    )
  })

  const collect = Effect.fnUntraced(function* (
    actor: OwnedActor,
    object: ColdObject,
    client: SqlClient.SqlClient,
  ) {
    yield* hooks.at("beforeGarbageCheck", actor.ref)
    const [guard] = yield* client<{ safe: boolean; unreferenced: string | null }>`SELECT
      NOT EXISTS (SELECT 1 FROM actor_generations WHERE ${actorRow({ sql: client, actor })} AND cold_ref = ${object.key})
      AND NOT EXISTS (SELECT 1 FROM actor_outbox WHERE ${actorRow({ sql: client, actor })} AND kind = 'cold')
      AND coalesce((SELECT unreferenced_at_ms FROM actor_cold_garbage
        WHERE routing_key = ${actor.key} AND object_key = ${object.key}), ${object.createdAtMs})
        < floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${clock.offsetMillis()} - ${retentionMs}
      AS safe,
      (SELECT unreferenced_at_ms::text FROM actor_cold_garbage
        WHERE routing_key = ${actor.key} AND object_key = ${object.key}) AS unreferenced`

    if (!guard!.safe) return 0
    yield* hooks.at("beforeDelete", actor.ref)
    yield* objectIO(store.delete(object.key))
    yield* hooks.at("afterDelete", actor.ref)
    yield* client`DELETE FROM actor_cold_garbage WHERE routing_key = ${actor.key}
      AND object_key = ${object.key} AND unreferenced_at_ms = ${guard!.unreferenced}`

    return 1
  })

  const sweepOn = Effect.fnUntraced(function* (client: SqlClient.SqlClient, reconcile: boolean) {
    const candidates = yield* client<{
      routing_key: string
      tenant_id: string
      actor_type: string
      actor_id: string
      object_key: string
      unreferenced_at_ms: string
    }>`SELECT routing_key::text, tenant_id, actor_type, actor_id, object_key, unreferenced_at_ms::text
      FROM actor_cold_garbage WHERE unreferenced_at_ms
        < floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${clock.offsetMillis()} - ${retentionMs}
      ORDER BY unreferenced_at_ms LIMIT 1000`
    let deleted = 0

    for (const candidate of candidates)
      deleted += yield* collect(
        {
          key: BigInt(candidate.routing_key),
          ref: {
            tenant: candidate.tenant_id,
            actor: candidate.actor_type,
            id: candidate.actor_id,
          },
        },
        { key: candidate.object_key, createdAtMs: Number(candidate.unreferenced_at_ms) },
        client,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Cold garbage candidate retained", cause).pipe(Effect.as(0)),
        ),
      )

    if (reconcile) {
      const now = yield* databaseTime.pipe(
        Effect.provideService(SqlClient.SqlClient, client),
        Effect.provideService(FrameworkClock, clock),
      )
      yield* store.list(`${deployment}/`).pipe(
        Stream.filter((object) => object.createdAtMs < now - retentionMs),
        Stream.runForEach((object) =>
          Effect.gen(function* () {
            const bytes = yield* objectIO(store.get(object.key))
            const envelope = yield* decode(bytes)

            if (objectKey(deployment, envelope, digestOf(bytes)) !== object.key)
              return yield* Effect.die(new Error(`Invalid cold object key: ${object.key}`))

            deleted += yield* collect(
              {
                key: BigInt(envelope.routingKey),
                ref: {
                  tenant: envelope.tenant,
                  actor: envelope.actor,
                  id: envelope.id,
                },
              },
              object,
              client,
            )
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Cold reconciliation candidate retained", cause),
            ),
          ),
        ),
      )
    }

    return deleted
  })

  const sweep = (reconcile = false) =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* sql.reserve
        const [lock] = yield* connection
          .execute("SELECT pg_try_advisory_lock(1935764837, 488) AS held", [], undefined)
          .pipe(Effect.map((rows) => rows as ReadonlyArray<{ held: boolean }>))

        if (!lock!.held) return 0
        yield* Effect.addFinalizer(() =>
          connection
            .execute("SELECT pg_advisory_unlock(1935764837, 488)", [], undefined)
            .pipe(Effect.orDie),
        )
        const reactivity = yield* Reactivity.make
        const client = yield* SqlClient.make({
          acquirer: Effect.succeed(connection),
          compiler: PgClient.makeCompiler(),
          spanAttributes: [],
        }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity))

        return yield* sweepOn(client, reconcile)
      }),
    )

  const run = Effect.gen(function* () {
    let reconciledAt = 0

    while (true) {
      yield* Effect.sleep("1 minute")
      const now = Date.now()
      const reconcile = now - reconciledAt >= 86_400_000
      yield* sweep(reconcile).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Cold garbage sweep failed", cause)),
      )
      if (reconcile) reconciledAt = now
    }
  })

  return {
    fetch,
    restore,
    hibernate,
    offload,
    sweep,
    run,
    concurrency,
    leaseMs,
    periodic: hooks.periodic,
  }
})
