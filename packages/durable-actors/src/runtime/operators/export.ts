import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { VERSION_KEY } from "../../state/migration.ts"
import { type ActorPage, decodeBytes, decodeText, findActor } from "../inspector/queries.ts"
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
 * Reads one actor's seed in the caller's transaction, which must be read-only
 * so every table is read at one snapshot and nothing can be written: current
 * state, the pending intents and timers, and the effects not yet settled.
 * Callers, credentials, receipts, event history, workflow executions, and
 * dead letters are not carried; the seed counts the last four in `omitted`.
 * An effect whose attempt has been cancelled or has finally failed is not
 * pending and is left out. `None` when the tenant has no such actor.
 */
export const exportActor = (page: Pick<ActorPage, "tenant" | "actorType" | "actorId">) =>
  Effect.gen(function* () {
    const found = yield* findActor(page)

    if (Option.isNone(found)) return Option.none<Seed>()

    const sql = yield* SqlClient.SqlClient
    const { routingKey, created } = found.value

    const owned = sql`routing_key = ${routingKey}::int8 AND tenant_id = ${page.tenant}
      AND actor_type = ${page.actorType} AND actor_id = ${page.actorId}`

    const exportedAtMs = yield* databaseTime

    const stored = yield* sql<{ key: string; value: Uint8Array }>`
      SELECT key, value FROM durable.state WHERE ${owned} ORDER BY key COLLATE "C"`

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

    const [omitted] = yield* sql<Seed["omitted"]>`
      SELECT
        (SELECT count(*)::int FROM durable.receipts WHERE ${owned}) AS receipts,
        (SELECT count(*)::int FROM durable.events WHERE ${owned}) AS events,
        (SELECT count(*)::int FROM durable.workflows WHERE ${owned}) AS workflows,
        (SELECT count(*)::int FROM durable.dead_letters WHERE ${owned}) AS "deadLetters"`

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
      omitted: omitted!,
    }

    return Option.some(seed)
  })
