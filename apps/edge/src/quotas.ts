import {
  COMMAND_UNITS,
  commandLimitUnits,
  Pricing,
  projectedSpendCents,
  READ_UNITS,
  refusesConnection,
  refusesSpend,
  refusesStorage,
  refusesUnits,
  storageLimitBytes,
} from "@akter/billing"
import {
  ConnectionLimitExceeded,
  QuotaExceeded,
  SpendLimitExceeded,
  StorageQuotaExceeded,
} from "@rikalabs/akter"

export {
  ConnectionLimitExceeded,
  QuotaExceeded,
  SpendLimitExceeded,
  StorageQuotaExceeded,
} from "@rikalabs/akter"
import { Clock, Crypto, Deferred, Duration, Effect, Fiber, Match, Schedule, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import type { EdgeOptions } from "./config.ts"

export { COMMAND_UNITS, READ_UNITS } from "@akter/billing"

/** No organization, billing account, or known plan is bound to the request's deployment and tenant. */
export class QuotaUnbound extends Schema.TaggedError<QuotaUnbound>()("QuotaUnbound", {
  deployment: Schema.String,
  tenant: Schema.String,
  reason: Schema.Literals(["tenant", "account", "plan"]),
}) {}

/** The usage tables could not be read or written, so the request cannot be admitted. */
export class QuotaUnavailable extends Schema.TaggedError<QuotaUnavailable>()(
  "QuotaUnavailable",
  {},
) {}

/**
 * An authenticated request to a route the edge cannot attribute to one command
 * id, so no reservation could be matched to a receipt.
 */
export class UnsupportedBillingRoute extends Schema.TaggedError<UnsupportedBillingRoute>()(
  "UnsupportedBillingRoute",
  { method: Schema.String, path: Schema.String },
) {}

/** Every failure the edge's usage admission can answer itself. */
export type QuotaError =
  | QuotaExceeded
  | SpendLimitExceeded
  | ConnectionLimitExceeded
  | StorageQuotaExceeded
  | QuotaUnbound
  | QuotaUnavailable
  | UnsupportedBillingRoute

const ReasonCodec = Schema.toCodecJson(
  Schema.Union([
    QuotaExceeded,
    SpendLimitExceeded,
    ConnectionLimitExceeded,
    StorageQuotaExceeded,
    QuotaUnbound,
    QuotaUnavailable,
    UnsupportedBillingRoute,
  ]),
)

const Envelope = Schema.TaggedStruct("ActorError", {
  reason: Schema.Json,
  isRetryable: Schema.Boolean,
  retryAfter: Schema.optionalKey(Schema.Finite),
})

const encodeReason = Schema.encodeEffect(ReasonCodec)

const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

/**
 * How an edge answers a `QuotaError`: the HTTP status, the WebSocket close
 * code, and the body in the served `ActorError` envelope, so callers that
 * read an unknown reason as no reason still see a refusal with its status
 * and `retry-after`.
 */
export const quotaFailure = Effect.fnUntraced(function* (error: QuotaError) {
  const [status, closeCode, isRetryable] = Match.value(error).pipe(
    Match.tagsExhaustive({
      QuotaExceeded: () => [429, 1008, false] as const,
      ConnectionLimitExceeded: () => [429, 1008, true] as const,
      SpendLimitExceeded: () => [402, 1008, false] as const,
      StorageQuotaExceeded: () => [429, 1008, false] as const,
      UnsupportedBillingRoute: () => [501, 1008, false] as const,
      QuotaUnbound: () => [503, 1013, false] as const,
      QuotaUnavailable: () => [503, 1013, true] as const,
    }),
  )

  const reason = yield* encodeReason(error).pipe(Effect.orDie)
  const retryAfterMs = Schema.is(QuotaExceeded)(error) ? error.retryAfterMs : undefined

  return {
    status,
    closeCode,
    retryAfterMs,
    body:
      retryAfterMs === undefined
        ? Envelope.make({ reason, isRetryable })
        : Envelope.make({ reason, isRetryable, retryAfter: retryAfterMs }),
  }
})

/** What a request costs the organization it is billed to. */
export type Metering =
  | { readonly kind: "free" }
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "command"
      readonly actor: string
      readonly id: string
      readonly commandId: string
    }
  | { readonly kind: "read"; readonly actor: string; readonly id: string }

/**
 * The exact paths the control plane reads with its service credential: a
 * runner's readiness, which rollouts probe before going live, and the
 * inspector's operator reads, which the console's runtime views ask through
 * the edge.
 */
const SERVICE_READS: ReadonlySet<string> = new Set([
  "/ready",
  "/inspector/overview",
  "/inspector/actors",
  "/inspector/actor",
  "/inspector/outbox",
  "/inspector/jobs",
  "/inspector/dead-letters",
  "/inspector/workflows",
])

const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Classifies a non-upgrade HTTP request. Commands, reducers, queries and
 * streams share `POST /actors/{Actor}/{id}/{Member}`, and only commands carry
 * `Idempotency-Key`, so a keyed POST is a command (5 units) and a credentialed
 * unkeyed one is a read (1 unit). A singleton omits `{id}`. Only the
 * authenticated edge can sign the usage token a read settles by, so an
 * anonymous unkeyed POST under `/actors` is unsupported, while an anonymous
 * command still settles through its own command id. A content grant
 * (`POST .../content/{blob}/{name}/grant`, the only member path of five or more
 * segments) records neither a receipt nor a read, so it is unsupported keyed
 * or not. Feeds (`GET .../events`)
 * cost a connection lease and no units, and every other request under
 * `/actors`, the protocol routes and preflights are free. Credentialed
 * requests elsewhere, including inspector GETs and MCP calls whose command
 * ids travel in their bodies, are unsupported rather than reserving usage
 * that cannot be correlated to the runner's read journal.
 *
 * The control plane's own service credential is free on exactly the GETs in
 * `SERVICE_READS`, which neither run a handler nor read through the read
 * journal; every other request it makes, its commands included, is metered as
 * a tenant's would be.
 */
export const meteringOf = (request: {
  readonly method: string
  readonly path: string
  readonly idempotencyKey: string | null
  readonly credentialed: boolean
  readonly service: boolean
}): Metering => {
  const method = request.method.toUpperCase()

  if (method === "OPTIONS") return { kind: "free" }

  if (request.service && method === "GET" && SERVICE_READS.has(request.path))
    return { kind: "free" }

  const segments = request.path.split("/")
  const at = segments.indexOf("actors")

  if (at === -1) {
    if (method === "POST" && segments.at(-1) !== "command-ids" && request.credentialed)
      return { kind: "unsupported" }

    if (method === "GET" && segments.at(-1) !== "protocol" && request.credentialed)
      return { kind: "unsupported" }

    return { kind: "free" }
  }

  const rest = segments.slice(at + 1).map(decoded)

  if (rest.length < 2) return request.credentialed ? { kind: "unsupported" } : { kind: "free" }

  if (method !== "POST") return { kind: "free" }

  if (rest.length >= 5 && rest.at(-1) === "grant") return { kind: "unsupported" }

  const actor = rest[0] ?? ""
  const id =
    rest.length >= 3 && !(rest.length === 3 && rest[2] === "watch") ? (rest[1] ?? "") : "singleton"
  const commandId = request.idempotencyKey?.trim().replace(/^"(.*)"$/u, "$1") ?? ""

  if (rest.length >= 2 && commandId !== "") return { kind: "command", actor, id, commandId }

  return request.credentialed ? { kind: "read", actor, id } : { kind: "unsupported" }
}

/** One counted unit of usage held against an organization's period until settled. */
export interface Reservation {
  readonly identity: string
  readonly organizationId: string
  readonly period: string
  readonly kind: "command" | "read"
  readonly units: number
  /** The command id of a command, or the fresh UUID that names a read. */
  readonly usageIdentity: string
  /** The identity already held a reservation, so nothing more was reserved. */
  readonly reused: boolean
}

/**
 * One live connection counted against an organization's plan. `lost`
 * completes once the edge can no longer prove the lease is still counted: the
 * holder must stop serving the connection then, because another edge may
 * already have taken its capacity.
 */
export interface Lease {
  readonly id: string
  readonly organizationId: string
  readonly tenant: string
  readonly lost: Effect.Effect<void>
  readonly isLost: Effect.Effect<boolean>
}

const SCHEMA_LOCK = 7_243_001

interface Account {
  readonly commandUnits: number
  readonly reservedUnits: number
  readonly storageGbMonths: number
  readonly resetMs: number
}

/**
 * The edge's usage admission, all of it in the control-plane database so any
 * number of edges share one cap. It creates the tables it needs, idempotently,
 * at startup.
 *
 * Every period starts at the first of a UTC month by the database clock. A
 * reservation is keyed by the whole command reference, so a retry of the same
 * command returns the reservation it already holds even when the cap is full.
 * Reservations count against the cap until a receipt import settles them; the
 * edge itself releases one only when no attempt ever left it, because after
 * an attempt it cannot know whether the command or read executed.
 *
 * A Free tenant whose latest storage sample is at or over its tier's
 * included decimal gigabytes takes no new command until a lower sample
 * arrives; reads and a command that already holds its reservation still pass.
 * A tenant with no sample yet is not refused, because no evidence says it is
 * over.
 *
 * Reads are reserved with a fresh UUID and kept once an attempt started: a
 * read that executed with a lost reply is still chargeable, and only the
 * runner's own read journal can settle it.
 *
 * Connections are leases that expire unless their edge renews them, so a
 * lost edge frees its connections after one lease lifetime. A renewal never
 * revives an expired row, and each lease carries a local deadline set from
 * the time before its last confirmed database write, a fifth of the lifetime
 * short of the row's expiry. The holder is told through `lost` at that
 * deadline or at the first renewal that finds the row gone, so a connection
 * is always closed before the database could count its capacity again.
 */
export const quotas = Effect.fnUntraced(function* (
  options: Pick<EdgeOptions, "leaseTtl" | "leaseHeartbeat">,
) {
  const sql = yield* SqlClient.SqlClient
  const pricing = yield* Pricing
  const random = yield* Crypto.Crypto
  const edgeId = yield* random.randomUUIDv4.pipe(Effect.orDie)
  const ttlSeconds = Duration.toSeconds(options.leaseTtl)
  const ttlMs = Duration.toMillis(options.leaseTtl)
  const validMs = ttlMs - ttlMs / 5
  const scope = yield* Effect.scope

  const held = new Map<
    string,
    {
      deadline: number
      readonly lost: Deferred.Deferred<void>
      guard: Fiber.Fiber<void> | undefined
    }
  >()

  const lose = (id: string) => {
    const entry = held.get(id)

    if (entry === undefined) return

    held.delete(id)
    Deferred.doneUnsafe(entry.lost, Effect.void)
  }

  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`
        yield* sql`CREATE TABLE IF NOT EXISTS cloud_meter_tenant (
          deployment_id text NOT NULL,
          tenant text NOT NULL,
          organization_id text NOT NULL,
          project_id text NOT NULL,
          PRIMARY KEY (deployment_id, tenant)
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_account (
          organization_id text PRIMARY KEY,
          plan text NOT NULL DEFAULT 'free',
          subscribed_plan text NOT NULL DEFAULT 'free',
          spend_limit_cents bigint,
          customer_id text,
          billing_email text,
          subscription_id text,
          provider_updated_at bigint NOT NULL DEFAULT 0,
          payment_status text NOT NULL DEFAULT 'free'
        )`
        yield* sql`ALTER TABLE cloud_billing_account
          ADD COLUMN IF NOT EXISTS subscribed_plan text NOT NULL DEFAULT 'free'`
        yield* sql`CREATE TABLE IF NOT EXISTS cloud_usage_account (
          organization_id text NOT NULL,
          period text NOT NULL,
          command_units bigint NOT NULL DEFAULT 0,
          reserved_units bigint NOT NULL DEFAULT 0,
          storage_gb_months double precision NOT NULL DEFAULT 0,
          PRIMARY KEY (organization_id, period)
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS cloud_usage_reservation (
          identity text PRIMARY KEY,
          organization_id text NOT NULL,
          project_id text NOT NULL,
          period text NOT NULL,
          deployment_id text NOT NULL,
          tenant text NOT NULL,
          actor_type text NOT NULL,
          actor_id text NOT NULL,
          command_id text NOT NULL,
          kind text NOT NULL CHECK (kind IN ('command', 'read')),
          units integer NOT NULL,
          admissions bigint NOT NULL DEFAULT 1,
          state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'committed', 'released')),
          reserved_at timestamptz NOT NULL DEFAULT now(),
          settled_at timestamptz,
          UNIQUE (deployment_id, tenant, actor_type, actor_id, command_id)
        )`
        yield* sql`ALTER TABLE cloud_usage_reservation
          ADD COLUMN IF NOT EXISTS admissions bigint NOT NULL DEFAULT 1`
        yield* sql`CREATE INDEX IF NOT EXISTS cloud_usage_reservation_open
          ON cloud_usage_reservation (organization_id, state)`
        yield* sql`CREATE TABLE IF NOT EXISTS cloud_meter_storage_sample (
          deployment_id text NOT NULL,
          tenant text NOT NULL,
          hour timestamptz NOT NULL,
          logical_bytes double precision NOT NULL CHECK (logical_bytes >= 0),
          PRIMARY KEY (deployment_id, tenant)
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS cloud_connection_lease (
          lease_id text PRIMARY KEY,
          organization_id text NOT NULL,
          deployment_id text NOT NULL,
          tenant text NOT NULL,
          kind text NOT NULL CHECK (kind IN ('socket', 'sse')),
          edge_id text NOT NULL,
          heartbeat_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL
        )`
        yield* sql`CREATE INDEX IF NOT EXISTS cloud_connection_lease_live
          ON cloud_connection_lease (organization_id, expires_at)`
        yield* sql`CREATE INDEX IF NOT EXISTS cloud_connection_lease_edge
          ON cloud_connection_lease (edge_id)`
      }),
    )
    .pipe(Effect.orDie)

  const renew = Effect.gen(function* () {
    const ids = [...held.keys()]

    if (ids.length === 0) return

    const began = yield* Clock.currentTimeMillis

    const renewed = yield* sql<{ readonly leaseId: string }>`
      UPDATE cloud_connection_lease
      SET heartbeat_at = clock_timestamp(), expires_at = clock_timestamp() + ${ttlSeconds} * interval '1 second'
      WHERE edge_id = ${edgeId} AND lease_id = ANY(${ids}) AND expires_at > clock_timestamp()
      RETURNING lease_id AS "leaseId"
    `

    const alive = new Set(renewed.map(({ leaseId }) => leaseId))

    for (const id of ids) {
      const entry = held.get(id)

      if (entry === undefined) continue

      if (alive.has(id)) entry.deadline = began + validMs
      else lose(id)
    }
  })

  yield* renew.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Connection lease renewal failed", cause)),
    Effect.repeat(Schedule.spaced(options.leaseHeartbeat)),
    Effect.forkScoped,
  )

  /**
   * Reads a tenant's organization, plan and spend limit. The account row is
   * share-locked, so inside an admission transaction a plan or limit change
   * either commits before the read or waits for the admission to commit: no
   * admission decides on a cap that a committed change already replaced. The
   * account row is always locked before usage rows and the connection lock.
   */
  const bind = Effect.fnUntraced(function* (deployment: string, tenant: string) {
    const [mapping] = yield* sql<{ readonly organizationId: string; readonly projectId: string }>`
      SELECT organization_id AS "organizationId", project_id AS "projectId"
      FROM cloud_meter_tenant
      WHERE deployment_id = ${deployment} AND tenant IN (${tenant}, '*')
      ORDER BY (tenant = '*')
      LIMIT 1
    `

    if (mapping === undefined)
      return yield* QuotaUnbound.make({ deployment, tenant, reason: "tenant" })

    const [account] = yield* sql<{
      readonly plan: string
      readonly subscribedPlan: string
      readonly spendLimitCents: number | null
    }>`
      SELECT plan, subscribed_plan AS "subscribedPlan", spend_limit_cents::float8 AS "spendLimitCents"
      FROM cloud_billing_account WHERE organization_id = ${mapping.organizationId}
      FOR SHARE
    `

    if (account === undefined)
      return yield* QuotaUnbound.make({ deployment, tenant, reason: "account" })

    const tier = yield* pricing
      .tier(account.plan)
      .pipe(Effect.mapError(() => QuotaUnbound.make({ deployment, tenant, reason: "plan" })))

    yield* pricing
      .tier(account.subscribedPlan)
      .pipe(Effect.mapError(() => QuotaUnbound.make({ deployment, tenant, reason: "plan" })))

    return {
      ...mapping,
      subscribedPlan: account.subscribedPlan,
      tier,
      spendLimitCents: account.spendLimitCents,
    }
  })

  const reserve = Effect.fnUntraced(function* (input: {
    readonly deployment: string
    readonly tenant: string
    readonly actor: string
    readonly id: string
    readonly commandId: string
    readonly kind: "command" | "read"
  }) {
    const units = input.kind === "command" ? COMMAND_UNITS : READ_UNITS

    const identity = yield* encodeIdentity([
      input.deployment,
      input.tenant,
      input.actor,
      input.id,
      input.commandId,
    ]).pipe(Effect.orDie)

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const bound = yield* bind(input.deployment, input.tenant)

        const [now] = yield* sql<{ readonly period: string }>`
          SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM') AS period
        `

        yield* sql`
          INSERT INTO cloud_usage_account (organization_id, period)
          VALUES (${bound.organizationId}, ${now?.period ?? ""})
          ON CONFLICT DO NOTHING
        `

        const [account] = yield* sql<Account & { readonly period: string }>`
          SELECT period, command_units::float8 AS "commandUnits",
            reserved_units::float8 AS "reservedUnits", storage_gb_months AS "storageGbMonths",
            (extract(epoch FROM (date_trunc('month', now() AT TIME ZONE 'utc') + interval '1 month')
              - (now() AT TIME ZONE 'utc')) * 1000)::float8 AS "resetMs"
          FROM cloud_usage_account
          WHERE organization_id = ${bound.organizationId} AND period = ${now?.period ?? ""}
          FOR UPDATE
        `

        if (account === undefined) return yield* QuotaUnavailable.make()

        const reservation = (period: string, reused: boolean): Reservation => ({
          identity,
          organizationId: bound.organizationId,
          period,
          kind: input.kind,
          units,
          usageIdentity: input.commandId,
          reused,
        })

        const [existing] = yield* sql<{ readonly state: string; readonly period: string }>`
          SELECT state, period FROM cloud_usage_reservation WHERE identity = ${identity}
        `

        if (existing !== undefined && existing.state !== "released") {
          yield* sql`UPDATE cloud_usage_reservation SET admissions = admissions + 1
            WHERE identity = ${identity}`

          return reservation(existing.period, true)
        }

        const limitBytes = storageLimitBytes(bound.tier)

        if (input.kind === "command" && limitBytes !== null) {
          const [sample] = yield* sql<{ readonly logicalBytes: number }>`
            SELECT logical_bytes AS "logicalBytes" FROM cloud_meter_storage_sample
            WHERE deployment_id = ${input.deployment} AND tenant = ${input.tenant}
            FOR SHARE
          `

          if (
            sample !== undefined &&
            refusesStorage({ tier: bound.tier, sampledBytes: sample.logicalBytes })
          )
            return yield* StorageQuotaExceeded.make({
              organizationId: bound.organizationId,
              deployment: input.deployment,
              tenant: input.tenant,
              limitBytes,
              usedBytes: sample.logicalBytes,
            })
        }

        const used = account.commandUnits + account.reservedUnits
        const limitUnits = commandLimitUnits(bound.tier)

        if (
          limitUnits !== null &&
          refusesUnits({ tier: bound.tier, usedUnits: used, requestedUnits: units })
        )
          return yield* QuotaExceeded.make({
            organizationId: bound.organizationId,
            period: account.period,
            limitUnits,
            usedUnits: used,
            requestedUnits: units,
            retryAfterMs: Math.ceil(account.resetMs),
          })

        if (bound.spendLimitCents !== null) {
          const projectedCents = yield* projectedSpendCents({
            subscribedPlan: bound.subscribedPlan,
            units: used + units,
            storageGbMonths: account.storageGbMonths,
          }).pipe(
            Effect.provideService(Pricing, pricing),
            Effect.mapError(() =>
              QuotaUnbound.make({
                deployment: input.deployment,
                tenant: input.tenant,
                reason: "plan",
              }),
            ),
          )

          if (refusesSpend({ limitCents: bound.spendLimitCents, projectedCents }))
            return yield* SpendLimitExceeded.make({
              organizationId: bound.organizationId,
              period: account.period,
              limitCents: bound.spendLimitCents,
              projectedCents,
            })
        }

        const taken = yield* sql`
          INSERT INTO cloud_usage_reservation (identity, organization_id, project_id, period,
            deployment_id, tenant, actor_type, actor_id, command_id, kind, units)
          VALUES (${identity}, ${bound.organizationId}, ${bound.projectId}, ${account.period},
            ${input.deployment}, ${input.tenant}, ${input.actor}, ${input.id}, ${input.commandId},
            ${input.kind}, ${units})
          ON CONFLICT (identity) DO UPDATE
          SET state = 'reserved', period = excluded.period, units = excluded.units,
            admissions = 1, reserved_at = now(), settled_at = NULL
          WHERE cloud_usage_reservation.state = 'released'
          RETURNING identity
        `

        if (taken.length === 0) return reservation(account.period, true)

        yield* sql`
          UPDATE cloud_usage_account SET reserved_units = reserved_units + ${units}
          WHERE organization_id = ${bound.organizationId} AND period = ${account.period}
        `

        return reservation(account.period, false)
      }),
    )
  })

  const recover = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
    effect.pipe(Effect.catchTag("SqlError", () => QuotaUnavailable.make()))

  return {
    /** The durable organization binding of a tenant, including its wildcard fallback. */
    organization: (deployment: string, tenant: string) =>
      recover(bind(deployment, tenant)).pipe(Effect.map((bound) => bound.organizationId)),

    /**
     * Reserves one command's 5 units for its whole reference, which excludes
     * the member. A retry of the same reference returns its reservation
     * without a cap check; the cap is checked against committed plus reserved
     * units, so unsettled commands count.
     */
    reserveCommand: (input: {
      readonly deployment: string
      readonly tenant: string
      readonly actor: string
      readonly id: string
      readonly commandId: string
    }) => recover(reserve({ ...input, kind: "command" })),

    /** Reserves one unit for a read under a fresh UUID. */
    reserveRead: Effect.fnUntraced(function* (input: {
      readonly deployment: string
      readonly tenant: string
      readonly actor: string
      readonly id: string
    }) {
      const commandId = yield* random.randomUUIDv4.pipe(Effect.orDie)

      return yield* recover(reserve({ ...input, commandId, kind: "read" }))
    }),

    /**
     * Releases a new reservation whose only admission provably did not
     * execute. Another admission may have committed, so any reused or
     * already settled reservation stays as it is.
     */
    release: (reservation: Reservation) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              SELECT 1 FROM cloud_usage_account
              WHERE organization_id = ${reservation.organizationId} AND period = ${reservation.period}
              FOR UPDATE
            `

            const released = yield* sql<{ readonly units: number }>`
              UPDATE cloud_usage_reservation SET state = 'released', settled_at = now()
              WHERE identity = ${reservation.identity} AND state = 'reserved' AND admissions = 1
              RETURNING units
            `

            if (released.length === 0) return

            yield* sql`
              UPDATE cloud_usage_account SET reserved_units = reserved_units - ${reservation.units}
              WHERE organization_id = ${reservation.organizationId} AND period = ${reservation.period}
            `
          }),
        )
        .pipe(Effect.catchTag("SqlError", () => QuotaUnavailable.make())),

    /**
     * Takes one connection of a deployment's tenant under its organization's
     * plan, counted across every tenant and project. The lease lives until
     * released or until its heartbeat stops for a lease lifetime.
     */
    acquireLease: Effect.fnUntraced(function* (input: {
      readonly deployment: string
      readonly tenant: string
      readonly kind: "socket" | "sse"
    }) {
      const began = yield* Clock.currentTimeMillis
      const id = yield* random.randomUUIDv4.pipe(Effect.orDie)

      const bound = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const bound = yield* bind(input.deployment, input.tenant)

            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`connections:${bound.organizationId}`}, 0))`

            yield* sql`
              DELETE FROM cloud_connection_lease
              WHERE organization_id = ${bound.organizationId}
                AND expires_at < now() - interval '1 hour'
            `

            const [live] = yield* sql<{ readonly open: number }>`
              SELECT count(*)::int AS open FROM cloud_connection_lease
              WHERE organization_id = ${bound.organizationId} AND expires_at > now()
            `

            const open = live?.open ?? 0

            if (refusesConnection({ tier: bound.tier, open }))
              return yield* ConnectionLimitExceeded.make({
                organizationId: bound.organizationId,
                kind: input.kind,
                limit: bound.tier.concurrentConnections,
                open,
              })

            yield* sql`
              INSERT INTO cloud_connection_lease
                (lease_id, organization_id, deployment_id, tenant, kind, edge_id, expires_at)
              VALUES (${id}, ${bound.organizationId}, ${input.deployment}, ${input.tenant},
                ${input.kind}, ${edgeId}, now() + ${ttlSeconds} * interval '1 second')
            `

            return bound
          }),
        )
        .pipe(recover)

      const lost = yield* Deferred.make<void>()
      const entry = {
        deadline: began + validMs,
        lost,
        guard: undefined as Fiber.Fiber<void> | undefined,
      }

      held.set(id, entry)

      entry.guard = yield* Effect.gen(function* () {
        while (held.get(id) === entry) {
          const left = entry.deadline - (yield* Clock.currentTimeMillis)

          if (left <= 0) return lose(id)

          yield* Effect.sleep(left)
        }
      }).pipe(Effect.forkIn(scope))

      return {
        id,
        organizationId: bound.organizationId,
        tenant: input.tenant,
        lost: Deferred.await(lost),
        isLost: Deferred.isDone(lost),
      } satisfies Lease
    }),

    /**
     * Frees a connection's lease. A lost lease is left to expire, so closing
     * its connection never waits on a database that could not renew it.
     */
    releaseLease: (lease: Lease) =>
      Effect.gen(function* () {
        if (yield* lease.isLost) return

        const entry = held.get(lease.id)

        held.delete(lease.id)

        if (entry?.guard !== undefined) yield* Fiber.interrupt(entry.guard)

        yield* sql`DELETE FROM cloud_connection_lease WHERE lease_id = ${lease.id}`
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Connection lease release failed", cause)),
      ),
  }
})

/** The edge's usage admission. */
export type Quotas = Effect.Success<ReturnType<typeof quotas>>
