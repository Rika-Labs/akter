import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { VERSION_KEY } from "../../state/migration.ts"
import { decodeBytes, decodeText } from "../inspector/queries.ts"
import { inReadOnlySnapshot } from "../database/snapshot.ts"
import { TenantScope, tenantSettings } from "../database/tenancy.ts"
import { databaseTime } from "../turn/admission.ts"
import { SEED_FORMAT, type Seed } from "./seed.ts"

/** The most pending intents, and the most pending effects, one export carries. */
export const MAX_EXPORT_ROWS = 10_000

/**
 * The actor cannot be exported faithfully: a stored value does not decode, or
 * it holds more pending work than one export carries. `detail` names the row,
 * never its contents.
 */
export class ExportRefused extends Schema.TaggedError<ExportRefused>()("ExportRefused", {
  reason: Schema.Literals(["undecodable", "too_large"]),
  detail: Schema.String,
}) {}

interface IntentRow {
  readonly targetType: string
  readonly targetId: string
  readonly command: string
  readonly payload: string
  readonly timerKey: string | null
  readonly dueAtMs: number
}

interface EffectRow {
  readonly effect: string
  readonly payload: string
  readonly payloadVersion: number
  readonly timerKey: string | null
  readonly dueAtMs: number
}

const EFFECT_KEY_PREFIX = "$effect:"

const decodeVersion = Schema.decodeUnknownOption(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))

/**
 * Runs `effect` in a read-only snapshot bound to `tenant`: as the runtime's
 * tenant role when row-level security is on, so the policies confine every
 * table read to the tenant, and by the `durable.tenant` setting otherwise.
 */
const tenantSnapshot =
  (tenant: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { role } = yield* TenantScope

      yield* role === undefined
        ? sql`SELECT set_config('durable.tenant', ${tenant}, true)`
        : sql`SELECT ${tenantSettings({ sql, role, tenant })}`

      return yield* effect
    }).pipe(inReadOnlySnapshot)

/**
 * Reads one actor's seed in a tenant-bound read-only snapshot: current
 * state, the pending intents and timers, and the effects not yet settled.
 * Callers, credentials, receipts, event history, workflow executions, dead
 * letters, owned-table rows, and blob entries are not carried; the seed counts
 * them in `omitted`. Subscription cursors and connections are neither carried
 * nor counted. An effect whose attempt has been cancelled or has finally failed
 * is not pending and is left out. It reads the runtime tables, not the
 * inspection views, because the views do not show a cancelled effect. `None`
 * when the tenant has no such actor.
 */
export const exportActor = (page: {
  readonly tenant: string
  readonly actorType: string
  readonly actorId: string
}) =>
  tenantSnapshot(page.tenant)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const [found] = yield* sql<{ routingKey: string; created: boolean }>`
        SELECT routing_key::text AS "routingKey", created FROM actor_generations
        WHERE tenant_id = ${page.tenant} AND actor_type = ${page.actorType}
          AND actor_id = ${page.actorId}`

      if (found === undefined) return Option.none<Seed>()

      const { routingKey, created } = found

      const owned = sql`routing_key = ${routingKey}::int8 AND tenant_id = ${page.tenant}
        AND actor_type = ${page.actorType} AND actor_id = ${page.actorId}`

      const exportedAtMs = yield* databaseTime

      const stored = yield* sql<{ key: string; value: Uint8Array }>`
        SELECT key, value FROM actor_state WHERE ${owned} ORDER BY key COLLATE "C"`

      const intents = yield* sql<IntentRow>`
        SELECT target_type AS "targetType", target_id AS "targetId", command, payload,
          timer_key AS "timerKey", due_at_ms::float8 AS "dueAtMs"
        FROM actor_outbox
        WHERE ${owned} AND kind = 'intent'
        ORDER BY due_at_ms, intent_id COLLATE "C" LIMIT ${MAX_EXPORT_ROWS + 1}`

      const effects = yield* sql<EffectRow>`
        SELECT command AS effect, payload, payload_version AS "payloadVersion",
          timer_key AS "timerKey", due_at_ms::float8 AS "dueAtMs"
        FROM actor_outbox
        WHERE ${owned} AND kind = 'effect' AND cancelled_at_ms IS NULL AND NOT final_failure
        ORDER BY due_at_ms, intent_id COLLATE "C" LIMIT ${MAX_EXPORT_ROWS + 1}`

      if (intents.length > MAX_EXPORT_ROWS)
        return yield* ExportRefused.make({ reason: "too_large", detail: "pending intents" })

      if (effects.length > MAX_EXPORT_ROWS)
        return yield* ExportRefused.make({ reason: "too_large", detail: "pending effects" })

      const [counted] = yield* sql<Omit<Seed["omitted"], "tableRows">>`
        SELECT
          (SELECT count(*)::int FROM actor_receipts WHERE ${owned}) AS receipts,
          (SELECT count(*)::int FROM actor_events WHERE ${owned}) AS events,
          (SELECT count(*)::int FROM actor_workflow_executions WHERE ${owned}) AS workflows,
          (SELECT count(*)::int FROM actor_dead_letters WHERE ${owned}) AS "deadLetters",
          (SELECT count(DISTINCT (blob, name))::int FROM actor_blobs WHERE ${owned})
            + (SELECT count(DISTINCT (blob, name))::int FROM actor_content_refs WHERE ${owned}) AS blobs`

      const tables = yield* sql<{ schema: string; table: string }>`
        SELECT table_schema AS schema, table_name AS "table" FROM actor_tables
        WHERE actor_type = ${page.actorType}`

      let tableRows = 0

      for (const { schema, table } of tables) {
        const [rows] = yield* sql<{ count: number }>`
          SELECT count(*)::int AS count FROM ${sql(schema)}.${sql(table)}
          WHERE routing_key = ${routingKey}::int8 AND tenant_id = ${page.tenant}
            AND actor_id = ${page.actorId}`

        tableRows += rows!.count
      }

      const state: Record<string, Schema.Json> = {}
      let stateVersion = 0

      for (const row of stored) {
        const decoded = decodeBytes(row.value)

        if (decoded === null || "undecodable" in decoded)
          return yield* ExportRefused.make({ reason: "undecodable", detail: `state ${row.key}` })

        if (row.key !== VERSION_KEY) state[row.key] = decoded.json
        else stateVersion = Option.getOrElse(decodeVersion(decoded.json), () => 0)
      }

      const payloadOf = Effect.fnUntraced(function* (text: string, detail: string) {
        const decoded = decodeText(text)

        if (decoded === null || "undecodable" in decoded)
          return yield* ExportRefused.make({ reason: "undecodable", detail })

        return decoded.json
      })

      const dueIn = (dueAtMs: number) => Math.max(0, Math.round(dueAtMs - exportedAtMs))

      const seed: Seed = {
        format: SEED_FORMAT,
        actor: { type: page.actorType, id: page.actorId },
        created,
        stateVersion,
        state,
        intents: yield* Effect.forEach(intents, (row) =>
          Effect.map(payloadOf(row.payload, `intent ${row.command}`), (payload) => ({
            target: { actor: row.targetType, id: row.targetId },
            command: row.command,
            payload,
            key: row.timerKey ?? undefined,
            dueInMs: dueIn(row.dueAtMs),
          })),
        ),
        effects: yield* Effect.forEach(effects, (row) =>
          Effect.map(payloadOf(row.payload, `effect ${row.effect}`), (payload) => ({
            effect: row.effect,
            payload,
            payloadVersion: row.payloadVersion,
            key: row.timerKey?.replace(EFFECT_KEY_PREFIX, "") ?? undefined,
            dueInMs: dueIn(row.dueAtMs),
          })),
        ),
        omitted: { ...counted!, tableRows },
      }

      return Option.some(seed)
    }),
  )
