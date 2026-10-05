import { Context, type Crypto, Effect, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import type { RegisteredJob } from "../members.ts"
import { emptyOutbox } from "../../handles/intents.ts"
import { ActorRef, System } from "../../identity/caller.ts"
import * as Queries from "../inspector/queries.ts"
import { TenantScope, withTenant } from "../database/tenancy.ts"
import { type Placement, routingKey } from "../storage/codec.ts"
import { forEachRange, onShard, withinRange } from "../database/shards.ts"
import { recordedPlacement } from "../storage/placements.ts"
import { databaseTime, FrameworkClock } from "../turn/admission.ts"
import { OutboxRuntime, outboxStatements } from "../turn/outbox.ts"
import { exportActor, type ExportRefused } from "./export.ts"
import type { Seed } from "./seed.ts"
import {
  type AuditEntry,
  type AuditRecord,
  auditRoutingKey,
  listAudit,
  writeAudit,
} from "./audit.ts"

/** The dead letter, receipt, or actor the request names does not exist. */
export class OperatorNotFound extends Schema.TaggedError<OperatorNotFound>()(
  "OperatorNotFound",
  {},
) {}

/**
 * The dead letter's last attempt may have applied the call. Retrying runs
 * the provider call again under a new idempotency key, so the operator must
 * state that they checked the provider first.
 */
export class ProviderOutcomeUnknown extends Schema.TaggedError<ProviderOutcomeUnknown>()(
  "ProviderOutcomeUnknown",
  { jobId: Schema.String },
) {}

/** This runner has no executor for the job, so it can't know how to queue a retry. */
export class JobNotServed extends Schema.TaggedError<JobNotServed>()("JobNotServed", {
  job: Schema.String,
}) {}

/** Why a repair or operator read was refused. */
export type RepairError = OperatorNotFound | ProviderOutcomeUnknown | JobNotServed

/** What an actor-scoped operator request names. */
export interface ActorTarget {
  readonly tenant: string
  readonly actorType: string
  readonly actorId: string
}

/** A stored outcome as an operator reads it: never re-executed. */
export interface ReceiptView {
  readonly commandId: string
  readonly command: string
  readonly outcomeTag: string
  readonly outcome: Queries.Decoded | null
  readonly expiresAtMs: number
}

/**
 * Operator reads and repairs that need the runtime's outbox and executors.
 * Every repair writes its audit row in its own transaction.
 */
export class OperatorRuntime extends Context.Service<
  OperatorRuntime,
  {
    /** The actor type's recorded placement, or none when no runner registered it. */
    readonly placement: (actorType: string) => Effect.Effect<Option.Option<Placement>>
    readonly inspect: (
      target: ActorTarget & { readonly limit: number; readonly outcomes: boolean },
    ) => Effect.Effect<Option.Option<unknown>>
    readonly receipt: (
      target: ActorTarget & { readonly commandId: string },
    ) => Effect.Effect<Option.Option<ReceiptView>>
    /**
     * One actor's seed, read in a single read-only snapshot; `None` when the
     * tenant has no such actor.
     */
    readonly exportSeed: (target: ActorTarget) => Effect.Effect<Option.Option<Seed>, ExportRefused>
    readonly retry: (request: {
      readonly target: ActorTarget
      readonly jobId: string
      readonly providerChecked: boolean
      readonly audit: AuditEntry
    }) => Effect.Effect<{ readonly jobId: string }, RepairError>
    readonly discard: (request: {
      readonly target: ActorTarget
      readonly jobId: string
      readonly audit: AuditEntry
    }) => Effect.Effect<void, RepairError>
    /**
     * Skips a stuck subscription row's events through `through`: the row
     * moves past them, and its subscriber is sent a marker for the range.
     */
    readonly skip: (request: {
      readonly target: ActorTarget
      readonly subscriberType: string
      readonly subscription: string
      readonly subscriberId: string
      readonly through: string
      readonly audit: AuditEntry
    }) => Effect.Effect<{ readonly through: string }, RepairError>
    /**
     * A tenant's active subscription rows that have failed at least
     * `minAttempts` deliveries in a row, most attempts first.
     */
    readonly lagging: (page: {
      readonly tenant: string
      readonly minAttempts: number
      readonly limit: number
    }) => Effect.Effect<ReadonlyArray<LaggingSubscription>>
    /** A tenant's newest audit rows, or every tenant's for `"*"`. */
    readonly audit: (page: {
      readonly tenant: string
      readonly limit: number
    }) => Effect.Effect<ReadonlyArray<AuditRecord>>
    /** Writes one audit row on its own; a read's row goes in before its answer. */
    readonly record: (entry: AuditEntry, outcome: Schema.Json) => Effect.Effect<void>
  }
>()("@rikalabs/akter/runtime/operators/repair/OperatorRuntime") {}

/** A subscription row whose deliveries keep failing, and how far behind its source it is. */
export interface LaggingSubscription {
  readonly sourceType: string
  readonly sourceId: string
  readonly subscriberType: string
  readonly subscription: string
  readonly subscriberId: string
  readonly delivered: string
  readonly head: string
  readonly lag: string
  readonly attempts: number
  readonly lastError: string
  readonly dueAtMs: number | null
}

/** What the runtime's clock and outbox references hold on this runner. */
type ReferenceOf<T> = T extends Context.Reference<infer S> ? S : never

interface DeadLetterRow {
  readonly job: string
  readonly payload: string
  readonly attempts: number
  readonly cause: string
  readonly ambiguous: boolean
  readonly payloadVersion: number
}

/**
 * Builds the service over the runtime's SQL, crypto, clock, and outbox, and
 * its job registrations, which say whether a retried job is capped.
 *
 * Repairs lock the dead letter they act on, so two repairs of it serialize and the
 * second finds nothing. Without `receipts.read` an operator sees that a command
 * ran, not what it returned. A retry is the operator's act and carries no end
 * user's principal. The payload may hold customer data, so a discard's record
 * keeps what failed, not what was sent.
 */
const encoder = new TextEncoder()

/** Compares two strings by their UTF-8 bytes, as Postgres orders them under `COLLATE "C"`. */
const byteOrder = (left: string, right: string) => {
  const a = encoder.encode(left)
  const b = encoder.encode(right)

  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return a[index]! - b[index]!

  return a.length - b.length
}

export const operatorRuntime = (deps: {
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto>
  readonly clock: ReferenceOf<typeof FrameworkClock>
  readonly outbox: ReferenceOf<typeof OutboxRuntime>
  readonly jobOf: (actorType: string, job: string) => RegisteredJob | undefined
  readonly wake: Effect.Effect<void>
  /** The tenant and adoption writer roles the operator's turns take, as the runtime's own turns do. */
  readonly tenantScope: ReferenceOf<typeof TenantScope>
}) => {
  const placement = (actorType: string) =>
    recordedPlacement(actorType).pipe(
      Effect.map(Option.fromUndefinedOr),
      Effect.orDie,
      Effect.provideContext(deps.services),
    )

  const keyOf = (target: ActorTarget) =>
    Effect.flatMap(placement(target.actorType), (found) =>
      Option.match(found, {
        onNone: () => Effect.fail(OperatorNotFound.make({})),
        onSome: (kind) =>
          Effect.succeed(
            routingKey({
              ref: { tenant: target.tenant, actor: target.actorType, id: target.actorId },
              placement: kind,
            }),
          ),
      }),
    )

  const provided = <A, E>(
    effect: Effect.Effect<A, E | SqlError.SqlError, SqlClient.SqlClient | Crypto.Crypto>,
  ) =>
    effect.pipe(
      Effect.catchIf(SqlError.isSqlError, Effect.die),
      Effect.provideService(FrameworkClock, deps.clock),
      Effect.provideService(OutboxRuntime, deps.outbox),
      Effect.provideService(TenantScope, deps.tenantScope),
      Effect.provideContext(deps.services),
    )

  /**
   * Runs one repair of `target` in its own tenant transaction, and writes the
   * repair's audit row, with the outcome it reports, in that same transaction.
   */
  const auditedRepair = <A, E, R>(
    target: ActorTarget,
    audit: AuditEntry,
    repair: (
      key: bigint,
    ) => Effect.Effect<{ readonly result: A; readonly outcome: Schema.Json }, E, R>,
  ) =>
    Effect.gen(function* () {
      const key = yield* keyOf(target)
      const sql = yield* SqlClient.SqlClient

      const { result } = yield* withTenant(target.tenant)(
        sql.withTransaction(
          Effect.tap(repair(key), ({ outcome }) => writeAudit({ entry: audit, key, outcome })),
        ),
      ).pipe(onShard(key))

      return result
    })

  const lockLetter = (key: bigint, target: ActorTarget, jobId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const [letter] = yield* sql<DeadLetterRow>`
        SELECT job, payload, payload_version AS "payloadVersion", attempts::int AS attempts, cause, ambiguous
        FROM actor_dead_letters
        WHERE routing_key = ${key} AND job_id = ${jobId} AND tenant_id = ${target.tenant}
          AND actor_type = ${target.actorType} AND actor_id = ${target.actorId}
        FOR UPDATE`

      if (letter === undefined) return yield* OperatorNotFound.make({})

      yield* sql`DELETE FROM actor_dead_letters WHERE routing_key = ${key} AND job_id = ${jobId}`

      return letter
    })

  return OperatorRuntime.of({
    placement,
    inspect: ({ limit, outcomes, ...target }) =>
      Queries.readOnly(target.tenant)(Queries.actor({ ...target, limit })).pipe(
        Effect.map(
          Option.map((page) =>
            outcomes
              ? page
              : {
                  ...page,
                  receipts: page.receipts.map(({ outcome: _outcome, ...receipt }) => receipt),
                },
          ),
        ),
        Effect.orDie,
        provided,
      ),
    receipt: ({ commandId, ...target }) =>
      Effect.gen(function* () {
        const key = yield* keyOf(target)
        const sql = yield* SqlClient.SqlClient

        const [row] = yield* Queries.readOnly(target.tenant)(sql<{
          command: string
          outcome_tag: string
          outcome: string
          expires_at_ms: number
        }>`SELECT command, outcome_tag, outcome, expires_at_ms::float8 AS expires_at_ms
          FROM durable.receipts
          WHERE routing_key = ${key} AND tenant_id = ${target.tenant}
            AND actor_type = ${target.actorType} AND actor_id = ${target.actorId}
            AND command_id = ${commandId}`).pipe(onShard(key))

        return Option.map(Option.fromUndefinedOr(row), (found) => ({
          commandId,
          command: found.command,
          outcomeTag: found.outcome_tag,
          outcome: Queries.decodeText(found.outcome),
          expiresAtMs: found.expires_at_ms,
        }))
      }).pipe(
        Effect.catchTag("OperatorNotFound", () => Effect.succeedNone),
        provided,
      ),
    exportSeed: (target) =>
      keyOf(target).pipe(
        Effect.flatMap((key) => exportActor(target).pipe(onShard(key))),
        Effect.catchTag("OperatorNotFound", () => Effect.succeedNone),
        Effect.catchIf(SqlError.isSqlError, Effect.die),
        provided,
      ),
    retry: ({ target, jobId, providerChecked, audit }) =>
      Effect.gen(function* () {
        const ref = ActorRef.make({
          tenant: target.tenant,
          actor: target.actorType,
          id: target.actorId,
        })

        const retried = yield* auditedRepair(target, audit, (key) =>
          Effect.gen(function* () {
            const letter = yield* lockLetter(key, target, jobId)

            if (letter.ambiguous && !providerChecked)
              return yield* ProviderOutcomeUnknown.make({ jobId })

            const registered = deps.jobOf(target.actorType, letter.job)

            if (registered === undefined) return yield* JobNotServed.make({ job: letter.job })

            const staged = yield* outboxStatements(
              key,
              ref,
              {
                ...emptyOutbox,
                jobs: [
                  {
                    job: letter.job,
                    payload: letter.payload,
                    version: letter.payloadVersion,
                    caller: System.make({ source: "actor", ref }),
                    due: undefined,
                    key: undefined,
                    capped: registered.perActor !== undefined,
                  },
                ],
              },
              databaseTime,
            )

            for (const statement of staged.statements) yield* statement

            const retriedId = staged.jobIds[0]!

            return {
              result: { jobId: retriedId },
              outcome: {
                retried: jobId,
                jobId: retriedId,
                job: letter.job,
                attempts: letter.attempts,
                ambiguous: letter.ambiguous,
                providerChecked,
              },
            }
          }),
        )

        yield* deps.wake

        return retried
      }).pipe(provided),
    discard: ({ target, jobId, audit }) =>
      auditedRepair(target, audit, (key) =>
        Effect.map(lockLetter(key, target, jobId), (letter) => ({
          result: undefined,
          outcome: {
            discarded: jobId,
            job: letter.job,
            attempts: letter.attempts,
            ambiguous: letter.ambiguous,
            cause: letter.cause,
          },
        })),
      ).pipe(provided),
    skip: ({ target, subscriberType, subscription, subscriberId, through, audit }) =>
      Effect.gen(function* () {
        yield* auditedRepair(target, audit, (key) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const now = yield* databaseTime

            const [skipped] = yield* sql<{ delivered: string; lastError: string }>`
              UPDATE actor_subscriptions s
              SET gap_at_ms = ${now}, gap_through = ${BigInt(through)}, attempts = 0,
                last_error = NULL, due_at_ms = ${now}
              FROM (SELECT delivered, last_error FROM actor_subscriptions
                WHERE routing_key = ${key} AND tenant_id = ${target.tenant}
                  AND source_type = ${target.actorType} AND source_id = ${target.actorId}
                  AND subscriber_type = ${subscriberType} AND subscription = ${subscription}
                  AND subscriber_id = ${subscriberId}
                  AND active AND last_error IS NOT NULL AND delivered < ${BigInt(through)}
                FOR UPDATE) old
              WHERE s.routing_key = ${key} AND s.tenant_id = ${target.tenant}
                AND s.source_type = ${target.actorType} AND s.source_id = ${target.actorId}
                AND s.subscriber_type = ${subscriberType} AND s.subscription = ${subscription}
                AND s.subscriber_id = ${subscriberId}
                AND ${BigInt(through)} <= (SELECT g.event_sequence FROM actor_generations g
                  WHERE g.routing_key = ${key} AND g.tenant_id = ${target.tenant}
                    AND g.actor_type = ${target.actorType} AND g.actor_id = ${target.actorId})
              RETURNING old.delivered::text AS delivered, old.last_error AS "lastError"`

            if (skipped === undefined) return yield* OperatorNotFound.make({})

            return {
              result: undefined,
              outcome: {
                subscriber: `${subscriberType}.${subscription}/${subscriberId}`,
                after: skipped.delivered,
                through,
                lastError: skipped.lastError,
              },
            }
          }),
        )

        yield* deps.wake

        return { through }
      }).pipe(provided),
    lagging: ({ tenant, minAttempts, limit }) =>
      forEachRange((range) =>
        Queries.readOnly(tenant)(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            return yield* sql<LaggingSubscription>`
            SELECT s.source_type AS "sourceType", s.source_id AS "sourceId",
              s.subscriber_type AS "subscriberType", s.subscription,
              s.subscriber_id AS "subscriberId", s.delivered::text AS delivered,
              g.event_sequence::text AS head, (g.event_sequence - s.delivered)::text AS lag,
              s.attempts::int AS attempts, s.last_error AS "lastError",
              s.due_at_ms::float8 AS "dueAtMs"
            FROM actor_subscriptions s
            JOIN actor_generations g ON g.routing_key = s.routing_key
              AND g.tenant_id = s.tenant_id AND g.actor_type = s.source_type
              AND g.actor_id = s.source_id
            WHERE s.tenant_id = ${tenant} AND s.active AND s.last_error IS NOT NULL
              AND s.attempts >= ${minAttempts} ${withinRange({ sql, range, column: "s.routing_key" })}
            ORDER BY s.attempts DESC, g.event_sequence - s.delivered DESC,
              s.source_type COLLATE "C", s.source_id COLLATE "C",
              s.subscriber_type COLLATE "C", s.subscription COLLATE "C",
              s.subscriber_id COLLATE "C"
            LIMIT ${limit}`
          }),
        ),
      ).pipe(
        Effect.map((shards) =>
          shards
            .flat()
            .sort(
              (a, b) =>
                b.attempts - a.attempts ||
                Number(BigInt(b.lag) - BigInt(a.lag)) ||
                byteOrder(a.sourceType, b.sourceType) ||
                byteOrder(a.sourceId, b.sourceId) ||
                byteOrder(a.subscriberType, b.subscriberType) ||
                byteOrder(a.subscription, b.subscription) ||
                byteOrder(a.subscriberId, b.subscriberId),
            )
            .slice(0, limit),
        ),
        provided,
        Effect.orDie,
      ),
    audit: (page) =>
      forEachRange((range) => Queries.readOnly(page.tenant)(listAudit({ ...page, range }))).pipe(
        Effect.map((shards) =>
          shards
            .flat()
            .sort((a, b) => b.atMs - a.atMs || byteOrder(a.auditId, b.auditId))
            .slice(0, page.limit),
        ),
        provided,
        Effect.orDie,
      ),
    record: (entry, outcome) =>
      Effect.gen(function* () {
        const found =
          entry.actorType === undefined ? Option.none() : yield* placement(entry.actorType)

        const key = auditRoutingKey({ entry, placement: Option.getOrUndefined(found) })

        yield* writeAudit({ entry, key, outcome }).pipe(onShard(key))
      }).pipe(provided, Effect.orDie),
  })
}
