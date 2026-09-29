import { Crypto, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { routingKey } from "../storage/codec.ts"
import { databaseTime } from "../turn/admission.ts"
import { Capability, type OperatorAction } from "./grants.ts"

/** One operator action as the audit log records it. */
export interface AuditEntry {
  readonly operator: string
  readonly action: OperatorAction
  readonly tenant: string
  readonly actorType?: string | undefined
  readonly actorId?: string | undefined
  /** The effect id or command id the action named. */
  readonly target?: string | undefined
  /** The capability that allowed it; none when it was refused. */
  readonly capability: Option.Option<Capability>
  readonly reason?: string | undefined
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const encodeCapability = Schema.encodeEffect(Schema.fromJsonString(Capability))

/**
 * The routing key an entry is stored under: its actor's, so a repair and its
 * record share a shard, or the tenant's for a tenant-wide action.
 */
export const auditRoutingKey = ({
  entry,
  placement,
}: {
  readonly entry: Pick<AuditEntry, "tenant" | "actorType" | "actorId">
  readonly placement: "tenant" | "actor" | undefined
}) =>
  entry.actorType === undefined || entry.actorId === undefined || placement === undefined
    ? routingKey({ ref: { tenant: entry.tenant, actor: "", id: "" }, placement: "tenant" })
    : routingKey({
        ref: { tenant: entry.tenant, actor: entry.actorType, id: entry.actorId },
        placement,
      })

/** Writes one audit row in the caller's transaction; `outcome` is stored as JSON. */
export const writeAudit = Effect.fnUntraced(function* ({
  entry,
  key,
  outcome,
}: {
  readonly entry: AuditEntry
  readonly key: bigint
  readonly outcome: Schema.Json
}) {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const auditId = yield* crypto.randomUUIDv4.pipe(Effect.orDie)

  const capability = Option.isNone(entry.capability)
    ? null
    : yield* encodeCapability(entry.capability.value).pipe(Effect.orDie)

  yield* sql`INSERT INTO actor_operator_audit (routing_key, audit_id, at_ms, operator, action,
      tenant_id, actor_type, actor_id, target, capability, reason, outcome)
    VALUES (${key}, ${auditId}, ${yield* databaseTime}, ${entry.operator}, ${entry.action},
      ${entry.tenant}, ${entry.actorType ?? null}, ${entry.actorId ?? null}, ${entry.target ?? null},
      ${capability}, ${entry.reason ?? null}, ${yield* encodeJson(outcome).pipe(Effect.orDie)})`

  return auditId
})

export const AuditRecord = Schema.Struct({
  auditId: Schema.String,
  atMs: Schema.Finite,
  operator: Schema.String,
  action: Schema.String,
  tenant: Schema.String,
  actorType: Schema.NullOr(Schema.String),
  actorId: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
  capability: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  outcome: Schema.String,
})

export type AuditRecord = typeof AuditRecord.Type

/** A tenant's newest audit rows, or every tenant's for `"*"`, newest first. */
export const listAudit = Effect.fnUntraced(function* ({
  tenant,
  limit,
}: {
  readonly tenant: string
  readonly limit: number
}) {
  const sql = yield* SqlClient.SqlClient

  const filter = tenant === "*" ? sql`` : sql`WHERE tenant_id = ${tenant}`

  return yield* sql<AuditRecord>`SELECT audit_id AS "auditId", at_ms::float8 AS "atMs", operator,
      action, tenant_id AS tenant, actor_type AS "actorType", actor_id AS "actorId", target,
      capability, reason, outcome
    FROM actor_operator_audit ${filter}
    ORDER BY at_ms DESC, audit_id COLLATE "C" LIMIT ${limit}`
})
