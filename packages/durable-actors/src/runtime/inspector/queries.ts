import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { inReadOnlySnapshot } from "../database/snapshot.ts"
import { decompress } from "../storage/codec.ts"

/**
 * A stored value as the inspector shows it: the decoded JSON, or why it could
 * not be decoded, so one corrupt row never hides the rest of a page.
 */
export type Decoded = { readonly json: Schema.Json } | { readonly undecodable: string }

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** Decodes a JSON `text` column such as a payload, caller, or outcome. */
export const decodeText = (text: string | null): Decoded | null => {
  if (text === null) return null

  return Option.match(parseJson(text), {
    onNone: () => ({ undecodable: "not JSON" }),
    onSome: (json) => ({ json }),
  })
}

/** Decodes a zstd-compressed JSON `bytea` column such as state, an event, or a step exit. */
export const decodeBytes = (bytes: Uint8Array | null): Decoded | null => {
  if (bytes === null) return null

  let text: string

  try {
    text = decompress(bytes)
  } catch {
    return { undecodable: "not zstd" }
  }

  return decodeText(text)
}

/** The widest page any list returns. */
export const MAX_LIMIT = 500

/** Every read below is scoped to `tenant`, which comes from the authenticated principal only. */
interface Page {
  readonly tenant: string
  readonly limit: number
}

/** The `(actor type, actor id)` pair that names an actor within a tenant. */
interface ActorIdentity {
  readonly actorType: string
  readonly actorId: string
}

/**
 * Runs `effect` in a read-only snapshot that names `tenant`, so when
 * row-level security owns the views they return no other tenant's rows,
 * whatever a read's own filter says.
 */
export const readOnly =
  (tenant: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`SELECT set_config('durable.tenant', ${tenant}, true)`,
    ).pipe(Effect.andThen(effect), inReadOnlySnapshot)

/** The view catalog and the tenant's row counts. */
interface Overview {
  readonly tenant: string
  readonly views: ReadonlyArray<{ readonly view: string; readonly version: number }>
  readonly counts: {
    readonly actors: number
    readonly receipts: number
    readonly events: number
    readonly outbox: number
    readonly timers: number
    readonly effects: number
    readonly deadLetters: number
    readonly workflows: number
    readonly openWorkflows: number
  }
}

/** The view catalog and the tenant's row count in each view, from one snapshot. */
export const overview = ({ tenant }: { readonly tenant: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const views = yield* sql<{ view: string; version: number }>`
      SELECT view_name AS view, version::int AS version FROM durable.views
      ORDER BY view_name COLLATE "C"`

    const [counts] = yield* sql<Overview["counts"]>`
      SELECT
        (SELECT count(*)::int FROM durable.actors WHERE tenant_id = ${tenant}) AS actors,
        (SELECT count(*)::int FROM durable.receipts WHERE tenant_id = ${tenant}) AS receipts,
        (SELECT count(*)::int FROM durable.events WHERE tenant_id = ${tenant}) AS events,
        (SELECT count(*)::int FROM durable.outbox WHERE tenant_id = ${tenant}) AS outbox,
        (SELECT count(*)::int FROM durable.timers WHERE tenant_id = ${tenant}) AS timers,
        (SELECT count(*)::int FROM durable.effects WHERE tenant_id = ${tenant}) AS effects,
        (SELECT count(*)::int FROM durable.dead_letters WHERE tenant_id = ${tenant}) AS "deadLetters",
        (SELECT count(*)::int FROM durable.workflows WHERE tenant_id = ${tenant}) AS workflows,
        (SELECT count(*)::int FROM durable.workflows
          WHERE tenant_id = ${tenant} AND status <> 'finished') AS "openWorkflows"`

    return { tenant, views, counts: counts! } satisfies Overview
  })

/** One actor in a listing, with its placement and current generation. */
interface ActorRow extends ActorIdentity {
  readonly placement: string | null
  readonly generation: number
  readonly created: boolean
  readonly lastEventSequence: number
}

interface StoredActor extends ActorRow {
  readonly routingKey: string
}

/** One keyset page of actors, optionally of a single type. */
interface ActorsPage extends Page {
  readonly actorType?: string | undefined
  /** Keyset cursor: the last actor of the previous page. */
  readonly after?: ActorIdentity | undefined
}

/**
 * The tenant's actors in `(actor_type, actor_id)` order, one page after `after`. The cursor
 * comparison uses the same `C` collation as the ORDER BY, or a cursor could skip or repeat actors.
 */
export const actors = (page: ActorsPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const byType = page.actorType === undefined ? sql`TRUE` : sql`actor_type = ${page.actorType}`

    const after =
      page.after === undefined
        ? sql`TRUE`
        : sql`(actor_type COLLATE "C", actor_id COLLATE "C") > (${page.after.actorType}, ${page.after.actorId})`

    const rows = yield* sql<ActorRow>`
      SELECT actor_type AS "actorType", actor_id AS "actorId", placement,
        generation::float8 AS generation, created,
        last_event_sequence::float8 AS "lastEventSequence"
      FROM durable.actors
      WHERE tenant_id = ${page.tenant} AND ${byType} AND ${after}
      ORDER BY actor_type COLLATE "C", actor_id COLLATE "C"
      LIMIT ${page.limit + 1}`

    const more = rows.length > page.limit
    const items = more ? rows.slice(0, page.limit) : rows
    const last = items.at(-1)

    return {
      actors: items,
      next:
        more && last !== undefined ? { actorType: last.actorType, actorId: last.actorId } : null,
    }
  })

const findActor = ({ tenant, actorType, actorId }: ActorPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const [row] = yield* sql<StoredActor>`
      SELECT actor_type AS "actorType", actor_id AS "actorId", routing_key::text AS "routingKey",
        placement, generation::float8 AS generation, created,
        last_event_sequence::float8 AS "lastEventSequence"
      FROM durable.actors
      WHERE tenant_id = ${tenant} AND actor_type = ${actorType} AND actor_id = ${actorId}`

    return Option.fromNullishOr(row)
  })

interface ReceiptRow {
  readonly commandId: string
  readonly command: string
  readonly callerKey: string
  readonly outcomeTag: string | null
  readonly outcome: string
  readonly expiresAtMs: number
  readonly events: string | null
}

interface EventRow {
  readonly sequence: number
  readonly event: string
  readonly commandId: string | null
  readonly value: Uint8Array
  readonly bytes: number
  readonly emittedAtMs: number
}

interface OutboxRow extends ActorIdentity {
  readonly intentId: string
  readonly timerKey: string | null
  readonly targetType: string
  readonly targetId: string
  readonly command: string
  readonly payload: string
  readonly caller: string
  readonly attempts: number
  readonly lastError: string | null
  readonly dueAtMs: number
}

interface EffectRow extends ActorIdentity {
  readonly effectId: string
  readonly effect: string
  readonly payload: string
  readonly caller: string
  readonly attempts: number
  readonly lastError: string | null
  readonly ambiguous: boolean
  readonly dueAtMs: number
}

interface DeadLetterRow extends ActorIdentity {
  readonly effectId: string
  readonly effect: string
  readonly payload: string
  readonly attempts: number
  readonly cause: string
  readonly ambiguous: boolean
  readonly deadAtMs: number
}

interface WorkflowRow extends ActorIdentity {
  readonly executionId: string
  readonly workflow: string
  readonly workflowKey: string
  readonly manifestHash: string
  readonly status: string
  readonly interrupt: boolean
  readonly caller: string
  readonly payload: Uint8Array
  readonly payloadBytes: number
  readonly result: Uint8Array | null
  readonly resultBytes: number | null
  readonly startedAtMs: number
  readonly finishedAtMs: number | null
}

interface StepRow {
  readonly executionId: string
  readonly step: string
  readonly attempt: number
  readonly kind: string
  readonly exit: Uint8Array | null
  readonly waitEvent: string | null
  readonly version: number | null
  readonly dueAtMs: number | null
  readonly startedAtMs: number
  readonly settledAtMs: number | null
}

const outboxOf = (row: OutboxRow) => ({
  ...row,
  payload: decodeText(row.payload),
  caller: decodeText(row.caller),
})

const effectOf = (row: EffectRow) => ({
  ...row,
  payload: decodeText(row.payload),
  caller: decodeText(row.caller),
})

const deadLetterOf = (row: DeadLetterRow) => ({ ...row, payload: decodeText(row.payload) })

const stepOf = (row: StepRow) => ({
  step: row.step,
  attempt: row.attempt,
  kind: row.kind,
  exit: decodeBytes(row.exit),
  waitEvent: row.waitEvent,
  version: row.version,
  dueAtMs: row.dueAtMs,
  startedAtMs: row.startedAtMs,
  settledAtMs: row.settledAtMs,
})

const workflowOf = (row: WorkflowRow, steps: ReadonlyArray<StepRow>) => ({
  ...row,
  caller: decodeText(row.caller),
  payload: decodeBytes(row.payload),
  result: decodeBytes(row.result),
  steps: steps.flatMap((step) => (step.executionId === row.executionId ? [stepOf(step)] : [])),
})

/** Columns shared by every per-row select: the actor the row belongs to. */
const IDENTITY = `actor_type AS "actorType", actor_id AS "actorId"`

const OUTBOX_COLUMNS = `${IDENTITY}, intent_id AS "intentId", timer_key AS "timerKey",
  target_type AS "targetType", target_id AS "targetId", command, payload, caller,
  attempts::int AS attempts, last_error AS "lastError", due_at_ms::float8 AS "dueAtMs"`

const EFFECT_COLUMNS = `${IDENTITY}, effect_id AS "effectId", effect, payload, caller,
  attempts::int AS attempts, last_error AS "lastError", ambiguous, due_at_ms::float8 AS "dueAtMs"`

const DEAD_LETTER_COLUMNS = `${IDENTITY}, effect_id AS "effectId", effect, payload,
  attempts::int AS attempts, cause, ambiguous, dead_at_ms::float8 AS "deadAtMs"`

const WORKFLOW_COLUMNS = `${IDENTITY}, execution_id AS "executionId", workflow,
  workflow_key AS "workflowKey", manifest_hash AS "manifestHash", status, interrupt, caller,
  payload, payload_bytes::int AS "payloadBytes", result, result_bytes::int AS "resultBytes",
  started_at_ms::float8 AS "startedAtMs", finished_at_ms::float8 AS "finishedAtMs"`

const STEP_COLUMNS = `execution_id AS "executionId", step, attempt::int AS attempt, kind, exit,
  wait_event AS "waitEvent", version::int AS version, due_at_ms::float8 AS "dueAtMs",
  started_at_ms::float8 AS "startedAtMs", settled_at_ms::float8 AS "settledAtMs"`

/** The actor whose detail to read, with the row limit for each list in it. */
interface ActorPage extends Page, ActorIdentity {}

/**
 * One actor as the inspector shows it, read through the actor's routing key:
 * its generation, decoded state, newest receipts with the events each
 * committed, newest events, pending outbox rows and effects, dead letters, and
 * workflow executions with their recorded steps. `None` when the tenant has
 * no such actor. Every runtime index leads with `routing_key`, so each read is
 * a key lookup, and the steps read for the same page of executions give each
 * listed execution all its steps.
 */
export const actor = (page: ActorPage) =>
  Effect.gen(function* () {
    const found = yield* findActor(page)

    if (Option.isNone(found)) return Option.none()

    const sql = yield* SqlClient.SqlClient
    const { routingKey, ...row } = found.value

    const owned = sql`routing_key = ${routingKey}::int8 AND tenant_id = ${page.tenant}
      AND actor_type = ${page.actorType} AND actor_id = ${page.actorId}`

    const state = yield* sql<{ key: string; value: Uint8Array; bytes: number }>`
      SELECT key, value, value_bytes::int AS bytes FROM durable.state
      WHERE ${owned} ORDER BY key COLLATE "C"`

    const receipts = yield* sql<ReceiptRow>`
      SELECT r.command_id AS "commandId", r.command, r.caller_key AS "callerKey",
        r.outcome_tag AS "outcomeTag", r.outcome, r.expires_at_ms::float8 AS "expiresAtMs",
        (SELECT string_agg(e.sequence::text, ',' ORDER BY e.sequence) FROM durable.events e
          WHERE e.routing_key = r.routing_key AND e.tenant_id = r.tenant_id
            AND e.actor_type = r.actor_type AND e.actor_id = r.actor_id
            AND e.command_id = r.command_id) AS events
      FROM durable.receipts r
      WHERE ${owned}
      ORDER BY r.expires_at_ms DESC, r.command_id COLLATE "C"
      LIMIT ${page.limit}`

    const events = yield* sql<EventRow>`
      SELECT sequence::float8 AS sequence, event, command_id AS "commandId", value,
        value_bytes::int AS bytes, emitted_at_ms::float8 AS "emittedAtMs"
      FROM durable.events
      WHERE ${owned} ORDER BY sequence DESC LIMIT ${page.limit}`

    const outbox = yield* sql.unsafe<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM durable.outbox
        WHERE routing_key = $1::int8 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4
        ORDER BY due_at_ms, intent_id COLLATE "C" LIMIT $5`,
      [routingKey, page.tenant, page.actorType, page.actorId, page.limit],
    )

    const effects = yield* sql.unsafe<EffectRow>(
      `SELECT ${EFFECT_COLUMNS} FROM durable.effects
        WHERE routing_key = $1::int8 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4
        ORDER BY due_at_ms, effect_id COLLATE "C" LIMIT $5`,
      [routingKey, page.tenant, page.actorType, page.actorId, page.limit],
    )

    const deadLetters = yield* sql.unsafe<DeadLetterRow>(
      `SELECT ${DEAD_LETTER_COLUMNS} FROM durable.dead_letters
        WHERE routing_key = $1::int8 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4
        ORDER BY dead_at_ms DESC, effect_id COLLATE "C" LIMIT $5`,
      [routingKey, page.tenant, page.actorType, page.actorId, page.limit],
    )

    const workflows = yield* sql.unsafe<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM durable.workflows
        WHERE routing_key = $1::int8 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4
        ORDER BY started_at_ms DESC, execution_id COLLATE "C" LIMIT $5`,
      [routingKey, page.tenant, page.actorType, page.actorId, page.limit],
    )

    const steps = yield* sql.unsafe<StepRow>(
      `SELECT ${STEP_COLUMNS} FROM durable.workflow_steps
        WHERE routing_key = $1::int8 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4
          AND execution_id IN (SELECT execution_id FROM durable.workflows
            WHERE routing_key = $1::int8 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4
            ORDER BY started_at_ms DESC, execution_id COLLATE "C" LIMIT $5)
        ORDER BY started_at_ms, step COLLATE "C", attempt`,
      [routingKey, page.tenant, page.actorType, page.actorId, page.limit],
    )

    const [totals] = yield* sql<{
      receipts: number
      events: number
      outbox: number
      effects: number
      deadLetters: number
      workflows: number
    }>`
      SELECT
        (SELECT count(*)::int FROM durable.receipts WHERE ${owned}) AS receipts,
        (SELECT count(*)::int FROM durable.events WHERE ${owned}) AS events,
        (SELECT count(*)::int FROM durable.outbox WHERE ${owned}) AS outbox,
        (SELECT count(*)::int FROM durable.effects WHERE ${owned}) AS effects,
        (SELECT count(*)::int FROM durable.dead_letters WHERE ${owned}) AS "deadLetters",
        (SELECT count(*)::int FROM durable.workflows WHERE ${owned}) AS workflows`

    return Option.some({
      actor: row,
      state: state.map(({ key, value, bytes }) => ({ key, bytes, value: decodeBytes(value) })),
      receipts: receipts.map(({ events: committed, callerKey, outcome, ...receipt }) => ({
        ...receipt,
        callerKey: decodeText(callerKey),
        outcome: decodeText(outcome),
        events: committed === null ? [] : committed.split(",").map(Number),
      })),
      events: events.map(({ value, ...event }) => ({ ...event, value: decodeBytes(value) })),
      outbox: outbox.map(outboxOf),
      effects: effects.map(effectOf),
      deadLetters: deadLetters.map(deadLetterOf),
      workflows: workflows.map((workflow) => workflowOf(workflow, steps)),
      totals: totals!,
    })
  })

/** The tenant's pending intents and timers, soonest first. */
export const outbox = ({ tenant, limit }: Page) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql.unsafe<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM durable.outbox WHERE tenant_id = $1
        ORDER BY due_at_ms, intent_id COLLATE "C" LIMIT $2`,
      [tenant, limit],
    )

    return { outbox: rows.map(outboxOf) }
  })

/** The tenant's performed effects not yet settled, soonest first. */
export const effects = ({ tenant, limit }: Page) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql.unsafe<EffectRow>(
      `SELECT ${EFFECT_COLUMNS} FROM durable.effects WHERE tenant_id = $1
        ORDER BY due_at_ms, effect_id COLLATE "C" LIMIT $2`,
      [tenant, limit],
    )

    return { effects: rows.map(effectOf) }
  })

/** The tenant's dead letters, newest first. */
export const deadLetters = ({ tenant, limit }: Page) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql.unsafe<DeadLetterRow>(
      `SELECT ${DEAD_LETTER_COLUMNS} FROM durable.dead_letters WHERE tenant_id = $1
        ORDER BY dead_at_ms DESC, effect_id COLLATE "C" LIMIT $2`,
      [tenant, limit],
    )

    return { deadLetters: rows.map(deadLetterOf) }
  })

/** A tenant-wide page of workflow executions. */
interface WorkflowsPage extends Page {
  /** `open` is every execution not yet finished. */
  readonly status: "open" | "all"
}

/** The tenant's workflow executions, newest first, each with its recorded steps. */
export const workflows = ({ tenant, limit, status }: WorkflowsPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql.unsafe<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM durable.workflows
        WHERE tenant_id = $1 AND ($2 = 'all' OR status <> 'finished')
        ORDER BY started_at_ms DESC, execution_id COLLATE "C" LIMIT $3`,
      [tenant, status, limit],
    )

    const steps = yield* sql.unsafe<StepRow>(
      `SELECT ${STEP_COLUMNS} FROM durable.workflow_steps
        WHERE tenant_id = $1 AND execution_id IN (SELECT execution_id FROM durable.workflows
          WHERE tenant_id = $1 AND ($2 = 'all' OR status <> 'finished')
          ORDER BY started_at_ms DESC, execution_id COLLATE "C" LIMIT $3)
        ORDER BY started_at_ms, step COLLATE "C", attempt`,
      [tenant, status, limit],
    )

    return { workflows: rows.map((row) => workflowOf(row, steps)) }
  })
