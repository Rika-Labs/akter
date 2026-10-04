import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type * as Inspection from "../../protocol/inspection.ts"
import { inReadOnlySnapshot } from "../database/snapshot.ts"
import { decompress } from "../storage/codec.ts"

export type { Decoded } from "../../protocol/inspection.ts"

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** Decodes a JSON `text` column such as a payload, caller, or outcome. */
export const decodeText = (text: string | null): Inspection.Decoded | null => {
  if (text === null) return null

  return Option.match(parseJson(text), {
    onNone: () => ({ undecodable: "not JSON" }),
    onSome: (json) => ({ json }),
  })
}

/** Decodes a zstd-compressed JSON `bytea` column such as state, an event, or a step exit. */
export const decodeBytes = (bytes: Uint8Array | null): Inspection.Decoded | null => {
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
type ActorIdentity = Pick<Inspection.ActorRow, "actorType" | "actorId">

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

/** The view catalog and the tenant's row count in each view, from one snapshot. */
export const overview = ({ tenant }: { readonly tenant: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const views = yield* sql<{ view: string; version: number }>`
      SELECT view_name AS view, version::int AS version FROM durable.views
      ORDER BY view_name COLLATE "C"`

    const [counts] = yield* sql<Inspection.Overview["counts"]>`
      SELECT
        (SELECT count(*)::int FROM durable.actors WHERE tenant_id = ${tenant}) AS actors,
        (SELECT count(*)::int FROM durable.receipts WHERE tenant_id = ${tenant}) AS receipts,
        (SELECT count(*)::int FROM durable.events WHERE tenant_id = ${tenant}) AS events,
        (SELECT count(*)::int FROM durable.outbox WHERE tenant_id = ${tenant}) AS outbox,
        (SELECT count(*)::int FROM durable.timers WHERE tenant_id = ${tenant}) AS timers,
        (SELECT count(*)::int FROM durable.jobs WHERE tenant_id = ${tenant}) AS jobs,
        (SELECT count(*)::int FROM durable.dead_letters WHERE tenant_id = ${tenant}) AS "deadLetters",
        (SELECT count(*)::int FROM durable.workflows WHERE tenant_id = ${tenant}) AS workflows,
        (SELECT count(*)::int FROM durable.workflows
          WHERE tenant_id = ${tenant} AND status <> 'finished') AS "openWorkflows"`

    const [timer] = yield* sql<{ dueAtMs: number | null }>`
      SELECT min(due_at_ms)::float8 AS "dueAtMs" FROM durable.timers WHERE tenant_id = ${tenant}`

    return {
      tenant,
      views,
      counts: counts!,
      nextTimerDueAtMs: timer?.dueAtMs ?? null,
    } satisfies Inspection.Overview
  })

interface StoredActor extends Inspection.ActorRow {
  readonly routingKey: string
}

/** One keyset page of actors, optionally of a single type or under an address prefix. */
interface ActorsPage extends Page {
  readonly actorType?: string | undefined
  /** Keeps only actors whose address, `type/id`, starts with it. */
  readonly prefix?: string | undefined
  /** Keyset cursor: the last actor of the previous page. */
  readonly after?: ActorIdentity | undefined
}

/**
 * The tenant's actors in `(actor_type, actor_id)` order, one page after `after`. The cursor
 * comparison uses the same `C` collation as the ORDER BY, or a cursor could skip or repeat actors.
 * A prefix that names a whole type, `type/` and more, matches that type's ids by their own prefix,
 * so it reads one type rather than every actor of the tenant.
 */
export const actors = (page: ActorsPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const byType = page.actorType === undefined ? sql`TRUE` : sql`actor_type = ${page.actorType}`
    const slash = page.prefix?.indexOf("/") ?? -1

    const byPrefix =
      page.prefix === undefined
        ? sql`TRUE`
        : slash === -1
          ? sql`starts_with(actor_type, ${page.prefix})`
          : sql`actor_type = ${page.prefix.slice(0, slash)}
              AND starts_with(actor_id, ${page.prefix.slice(slash + 1)})`

    const after =
      page.after === undefined
        ? sql`TRUE`
        : sql`(actor_type COLLATE "C", actor_id COLLATE "C") > (${page.after.actorType}, ${page.after.actorId})`

    const rows = yield* sql<Inspection.ActorRow>`
      SELECT actor_type AS "actorType", actor_id AS "actorId", placement,
        generation::float8 AS generation, created,
        last_event_sequence::float8 AS "lastEventSequence"
      FROM durable.actors
      WHERE tenant_id = ${page.tenant} AND ${byType} AND ${byPrefix} AND ${after}
      ORDER BY actor_type COLLATE "C", actor_id COLLATE "C"
      LIMIT ${page.limit + 1}`

    const more = rows.length > page.limit
    const items = more ? rows.slice(0, page.limit) : rows
    const last = items.at(-1)

    return {
      actors: items,
      next:
        more && last !== undefined ? { actorType: last.actorType, actorId: last.actorId } : null,
    } satisfies typeof Inspection.ActorsPage.Type
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

type ReceiptRow = Omit<Inspection.ReceiptRow, "callerKey" | "outcome" | "events"> & {
  readonly callerKey: string
  readonly outcome: string
  readonly events: string | null
}

type EventRow = Omit<Inspection.EventRow, "value"> & {
  readonly value: Uint8Array
}

type OutboxRow = Omit<Inspection.OutboxRow, "payload" | "caller"> & {
  readonly payload: string
  readonly caller: string
}

type JobRow = Omit<Inspection.JobRow, "payload" | "caller"> & {
  readonly payload: string
  readonly caller: string
}

type DeadLetterRow = Omit<Inspection.DeadLetterRow, "payload"> & {
  readonly payload: string
}

type WorkflowRow = Omit<Inspection.WorkflowRow, "caller" | "payload" | "result" | "steps"> & {
  readonly caller: string
  readonly payload: Uint8Array
  readonly result: Uint8Array | null
}

type StepRow = Omit<Inspection.StepRow, "exit"> & {
  readonly executionId: string
  readonly exit: Uint8Array | null
}

const outboxOf = (row: OutboxRow) => ({
  ...row,
  payload: decodeText(row.payload),
  caller: decodeText(row.caller),
})

const jobOf = (row: JobRow) => ({
  ...row,
  payload: decodeText(row.payload),
  caller: decodeText(row.caller),
})

const deadLetterOf = (row: DeadLetterRow) => ({ ...row, payload: decodeText(row.payload) })

const receiptOf = <Row extends ReceiptRow>({ events, callerKey, outcome, ...receipt }: Row) => ({
  ...receipt,
  callerKey: decodeText(callerKey),
  outcome: decodeText(outcome),
  events: events === null ? [] : events.split(",").map(Number),
})

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

const JOB_COLUMNS = `${IDENTITY}, job_id AS "jobId", job, payload, caller,
  attempts::int AS attempts, last_error AS "lastError", ambiguous, due_at_ms::float8 AS "dueAtMs"`

const DEAD_LETTER_COLUMNS = `${IDENTITY}, job_id AS "jobId", job, payload,
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
 * committed, newest events, pending outbox rows and jobs, dead letters, and
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

    const jobs = yield* sql.unsafe<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM durable.jobs
        WHERE routing_key = $1::int8 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4
        ORDER BY due_at_ms, job_id COLLATE "C" LIMIT $5`,
      [routingKey, page.tenant, page.actorType, page.actorId, page.limit],
    )

    const deadLetters = yield* sql.unsafe<DeadLetterRow>(
      `SELECT ${DEAD_LETTER_COLUMNS} FROM durable.dead_letters
        WHERE routing_key = $1::int8 AND tenant_id = $2 AND actor_type = $3 AND actor_id = $4
        ORDER BY dead_at_ms DESC, job_id COLLATE "C" LIMIT $5`,
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

    const [totals] = yield* sql<Inspection.ActorDetail["totals"]>`
      SELECT
        (SELECT count(*)::int FROM durable.receipts WHERE ${owned}) AS receipts,
        (SELECT count(*)::int FROM durable.events WHERE ${owned}) AS events,
        (SELECT count(*)::int FROM durable.outbox WHERE ${owned}) AS outbox,
        (SELECT count(*)::int FROM durable.jobs WHERE ${owned}) AS jobs,
        (SELECT count(*)::int FROM durable.dead_letters WHERE ${owned}) AS "deadLetters",
        (SELECT count(*)::int FROM durable.workflows WHERE ${owned}) AS workflows`

    return Option.some({
      actor: row,
      state: state.map(({ key, value, bytes }) => ({ key, bytes, value: decodeBytes(value) })),
      receipts: receipts.map(receiptOf),
      events: events.map(({ value, ...event }) => ({ ...event, value: decodeBytes(value) })),
      outbox: outbox.map(outboxOf),
      jobs: jobs.map(jobOf),
      deadLetters: deadLetters.map(deadLetterOf),
      workflows: workflows.map((workflow) => workflowOf(workflow, steps)),
      totals: totals!,
    } satisfies Inspection.ActorDetail)
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

    return { outbox: rows.map(outboxOf) } satisfies typeof Inspection.OutboxPage.Type
  })

/** The tenant's enqueued jobs not yet settled, soonest first. */
export const jobs = ({ tenant, limit }: Page) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql.unsafe<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM durable.jobs WHERE tenant_id = $1
        ORDER BY due_at_ms, job_id COLLATE "C" LIMIT $2`,
      [tenant, limit],
    )

    return { jobs: rows.map(jobOf) } satisfies typeof Inspection.JobsPage.Type
  })

/** A tenant-wide keyset page of dead letters. */
interface DeadLettersPage extends Page {
  /** Keyset cursor: the last dead letter of the previous page. */
  readonly after?: { readonly deadAtMs: number; readonly jobId: string } | undefined
}

/** The tenant's dead letters, newest first, one page after `after`. */
export const deadLetters = ({ tenant, limit, after }: DeadLettersPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql.unsafe<DeadLetterRow>(
      `SELECT ${DEAD_LETTER_COLUMNS} FROM durable.dead_letters WHERE tenant_id = $1
        AND ($2::int8 IS NULL OR dead_at_ms < $2::int8
          OR (dead_at_ms = $2::int8 AND job_id COLLATE "C" > $3))
        ORDER BY dead_at_ms DESC, job_id COLLATE "C" LIMIT $4`,
      [tenant, after?.deadAtMs ?? null, after?.jobId ?? "", limit + 1],
    )

    const items = rows.slice(0, limit)
    const last = items.at(-1)

    return {
      deadLetters: items.map(deadLetterOf),
      next:
        rows.length > limit && last !== undefined
          ? { deadAtMs: last.deadAtMs, jobId: last.jobId }
          : null,
    } satisfies typeof Inspection.DeadLettersPage.Type
  })

/** A tenant-wide keyset page of workflow executions. */
interface WorkflowsPage extends Page {
  /** `open` is every execution not yet finished; the others name one stored status. */
  readonly status: "open" | "all" | "running" | "suspended" | "finished"
  /** Keyset cursor: the last execution of the previous page. */
  readonly after?: { readonly startedAtMs: number; readonly executionId: string } | undefined
}

/**
 * The tenant's workflow executions, newest first, one page after `after`, each
 * with its recorded steps. The steps are read for the same page of executions,
 * so each listed execution has all its steps.
 */
export const workflows = ({ tenant, limit, status, after }: WorkflowsPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const page = `tenant_id = $1
      AND ($2 = 'all' OR ($2 = 'open' AND status <> 'finished') OR status = $2)
      AND ($3::int8 IS NULL OR started_at_ms < $3::int8
        OR (started_at_ms = $3::int8 AND execution_id COLLATE "C" > $4))`

    const params = [tenant, status, after?.startedAtMs ?? null, after?.executionId ?? "", limit + 1]

    const rows = yield* sql.unsafe<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM durable.workflows WHERE ${page}
        ORDER BY started_at_ms DESC, execution_id COLLATE "C" LIMIT $5`,
      params,
    )

    const steps = yield* sql.unsafe<StepRow>(
      `SELECT ${STEP_COLUMNS} FROM durable.workflow_steps
        WHERE tenant_id = $1 AND execution_id IN (SELECT execution_id FROM durable.workflows
          WHERE ${page} ORDER BY started_at_ms DESC, execution_id COLLATE "C" LIMIT $5)
        ORDER BY started_at_ms, step COLLATE "C", attempt`,
      params,
    )

    const items = rows.slice(0, limit)
    const last = items.at(-1)

    return {
      workflows: items.map((row) => workflowOf(row, steps)),
      next:
        rows.length > limit && last !== undefined
          ? { startedAtMs: last.startedAtMs, executionId: last.executionId }
          : null,
    } satisfies typeof Inspection.WorkflowsPage.Type
  })

/** A keyset page of names, optionally one name only. */
interface NamesPage extends Page {
  /** Reads only this name. */
  readonly name?: string | undefined
  /** Keyset cursor: the last name of the previous page. */
  readonly after?: string | undefined
}

/** The tenant's actor types by name, each with how many actors it has, one page after `after`. */
export const actorTypes = ({ tenant, limit, name, after }: NamesPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql<Inspection.ActorTypeRow>`
      SELECT actor_type AS "actorType", count(*)::int AS actors
      FROM durable.actors
      WHERE tenant_id = ${tenant}
        AND ${name === undefined ? sql`TRUE` : sql`actor_type = ${name}`}
        AND ${after === undefined ? sql`TRUE` : sql`actor_type COLLATE "C" > ${after}`}
      GROUP BY actor_type
      ORDER BY actor_type COLLATE "C"
      LIMIT ${limit + 1}`

    const items = rows.slice(0, limit)

    return {
      actorTypes: items,
      next: rows.length > limit ? (items.at(-1)?.actorType ?? null) : null,
    } satisfies typeof Inspection.ActorTypesPage.Type
  })

/**
 * The tenant's job names, each with its pending jobs split by whether an
 * attempt has failed, and its dead letters, one page after `after`.
 */
export const jobTypes = ({ tenant, limit, after }: NamesPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql<Inspection.JobTypeRow>`
      SELECT job, sum(queued)::int AS queued, sum(retrying)::int AS retrying,
        sum(dead)::int AS "deadLetters"
      FROM (
        SELECT job, count(*) FILTER (WHERE attempts = 0) AS queued,
          count(*) FILTER (WHERE attempts > 0) AS retrying, 0 AS dead
        FROM durable.jobs WHERE tenant_id = ${tenant} GROUP BY job
        UNION ALL
        SELECT job, 0, 0, count(*) FROM durable.dead_letters WHERE tenant_id = ${tenant} GROUP BY job
      ) named
      WHERE ${after === undefined ? sql`TRUE` : sql`job COLLATE "C" > ${after}`}
      GROUP BY job
      ORDER BY job COLLATE "C"
      LIMIT ${limit + 1}`

    const items = rows.slice(0, limit)

    return {
      jobTypes: items,
      next: rows.length > limit ? (items.at(-1)?.job ?? null) : null,
    } satisfies typeof Inspection.JobTypesPage.Type
  })

/** A keyset page of receipts: one actor's, one type's or the whole tenant's. */
interface ReceiptsPage extends Page {
  readonly actorType?: string | undefined
  /** Reads one actor, of `actorType`. */
  readonly actorId?: string | undefined
  readonly outcomeTag?: "Success" | "Failure" | undefined
  /** Keyset cursor: the last receipt of the previous page. */
  readonly after?:
    | (ActorIdentity & { readonly expiresAtMs: number; readonly commandId: string })
    | undefined
}

type TenantReceiptRow = ReceiptRow & ActorIdentity

/**
 * Receipts, the latest expiry first, one page after `after`, each with the
 * events it committed. A receipt's expiry is the one its command id carries,
 * so this is the order the command ids were issued in, not the order the
 * turns committed. `None` when the page names one actor the tenant does not
 * have.
 */
export const receipts = (page: ReceiptsPage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    let scope = sql`TRUE`

    if (page.actorType !== undefined && page.actorId !== undefined) {
      const found = yield* findActor({ ...page, actorType: page.actorType, actorId: page.actorId })

      if (Option.isNone(found)) return Option.none()

      scope = sql`r.routing_key = ${found.value.routingKey}::int8
        AND r.actor_type = ${page.actorType} AND r.actor_id = ${page.actorId}`
    } else if (page.actorType !== undefined) scope = sql`r.actor_type = ${page.actorType}`

    const after =
      page.after === undefined
        ? sql`TRUE`
        : sql`(r.expires_at_ms < ${page.after.expiresAtMs}::int8
            OR (r.expires_at_ms = ${page.after.expiresAtMs}::int8
              AND (r.actor_type COLLATE "C", r.actor_id COLLATE "C", r.command_id COLLATE "C")
                > (${page.after.actorType}, ${page.after.actorId}, ${page.after.commandId})))`

    const rows = yield* sql<TenantReceiptRow>`
      SELECT r.actor_type AS "actorType", r.actor_id AS "actorId",
        r.command_id AS "commandId", r.command, r.caller_key AS "callerKey",
        r.outcome_tag AS "outcomeTag", r.outcome, r.expires_at_ms::float8 AS "expiresAtMs",
        (SELECT string_agg(e.sequence::text, ',' ORDER BY e.sequence) FROM durable.events e
          WHERE e.routing_key = r.routing_key AND e.tenant_id = r.tenant_id
            AND e.actor_type = r.actor_type AND e.actor_id = r.actor_id
            AND e.command_id = r.command_id) AS events
      FROM durable.receipts r
      WHERE r.tenant_id = ${page.tenant} AND ${scope} AND ${after}
        AND ${page.outcomeTag === undefined ? sql`TRUE` : sql`r.outcome_tag = ${page.outcomeTag}`}
      ORDER BY r.expires_at_ms DESC, r.actor_type COLLATE "C", r.actor_id COLLATE "C",
        r.command_id COLLATE "C"
      LIMIT ${page.limit + 1}`

    const items = rows.slice(0, page.limit)
    const last = items.at(-1)

    return Option.some({
      receipts: items.map(receiptOf),
      next:
        rows.length > page.limit && last !== undefined
          ? {
              actorType: last.actorType,
              actorId: last.actorId,
              expiresAtMs: last.expiresAtMs,
              commandId: last.commandId,
            }
          : null,
    } satisfies typeof Inspection.ReceiptsPage.Type)
  })

/** A keyset page of one actor's event names. */
interface LatestEventsPage extends ActorPage {
  /** Keyset cursor: the last event name of the previous page. */
  readonly after?: string | undefined
}

/**
 * The newest retained event of each name one actor emitted, by name, one page
 * after `after`. `None` when the tenant has no such actor.
 */
export const latestEvents = (page: LatestEventsPage) =>
  Effect.gen(function* () {
    const found = yield* findActor(page)

    if (Option.isNone(found)) return Option.none()

    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql<Inspection.LatestEventRow>`
      SELECT event, sequence, "emittedAtMs" FROM (
        SELECT DISTINCT ON (event) event, sequence::float8 AS sequence,
          emitted_at_ms::float8 AS "emittedAtMs"
        FROM durable.events
        WHERE routing_key = ${found.value.routingKey}::int8 AND tenant_id = ${page.tenant}
          AND actor_type = ${page.actorType} AND actor_id = ${page.actorId}
          AND ${page.after === undefined ? sql`TRUE` : sql`event COLLATE "C" > ${page.after}`}
        ORDER BY event, sequence DESC
      ) latest
      ORDER BY event COLLATE "C"
      LIMIT ${page.limit + 1}`

    const items = rows.slice(0, page.limit)

    return Option.some({
      events: items,
      next: rows.length > page.limit ? (items.at(-1)?.event ?? null) : null,
    } satisfies typeof Inspection.LatestEventsPage.Type)
  })

/** A keyset page of one actor's timeline. */
interface TimelinePage extends ActorPage {
  /** Keyset cursor: the last entry of the previous page. */
  readonly before?: { readonly sequence: number; readonly kind: "command" | "event" } | undefined
}

type StoredTimelineRow = Omit<Inspection.TimelineRow, "callerKey"> & {
  readonly callerKey: string | null
}

/**
 * One actor's timeline, newest first, one page after `before`: every retained
 * event at its emission time, and every retained receipt whose turn emitted
 * events, at that turn's emission time and placed after its own events. A
 * receipt whose turn emitted nothing has no recorded time, so it is not on the
 * timeline. Event sequences only grow, so they order the timeline exactly.
 * `None` when the tenant has no such actor.
 */
export const timeline = (page: TimelinePage) =>
  Effect.gen(function* () {
    const found = yield* findActor(page)

    if (Option.isNone(found)) return Option.none()

    const sql = yield* SqlClient.SqlClient

    const owned = (alias: string) =>
      sql`${sql(alias)}.routing_key = ${found.value.routingKey}::int8
        AND ${sql(alias)}.tenant_id = ${page.tenant}
        AND ${sql(alias)}.actor_type = ${page.actorType} AND ${sql(alias)}.actor_id = ${page.actorId}`

    const before =
      page.before === undefined
        ? sql`TRUE`
        : sql`(sequence, rank) < (${page.before.sequence}::float8, ${page.before.kind === "event" ? 1 : 0})`

    const rows = yield* sql<StoredTimelineRow>`
      SELECT kind, sequence, name, "commandId", "callerKey", "atMs" FROM (
        SELECT 'event' AS kind, 1 AS rank, e.sequence::float8 AS sequence, e.event AS name,
          e.command_id AS "commandId", r.caller_key AS "callerKey",
          e.emitted_at_ms::float8 AS "atMs"
        FROM durable.events e
        LEFT JOIN durable.receipts r ON r.routing_key = e.routing_key
          AND r.tenant_id = e.tenant_id AND r.actor_type = e.actor_type
          AND r.actor_id = e.actor_id AND r.command_id = e.command_id
        WHERE ${owned("e")}
        UNION ALL
        SELECT 'command', 0, min(e.sequence)::float8, r.command, r.command_id, r.caller_key,
          min(e.emitted_at_ms)::float8
        FROM durable.receipts r
        JOIN durable.events e ON e.routing_key = r.routing_key
          AND e.tenant_id = r.tenant_id AND e.actor_type = r.actor_type
          AND e.actor_id = r.actor_id AND e.command_id = r.command_id
        WHERE ${owned("r")}
        GROUP BY r.command_id, r.command, r.caller_key
      ) entries
      WHERE ${before}
      ORDER BY sequence DESC, rank DESC
      LIMIT ${page.limit + 1}`

    const items = rows.slice(0, page.limit)
    const last = items.at(-1)

    return Option.some({
      entries: items.map(({ callerKey, ...entry }) => ({
        ...entry,
        callerKey: decodeText(callerKey),
      })),
      next:
        rows.length > page.limit && last !== undefined
          ? { sequence: last.sequence, kind: last.kind }
          : null,
    } satisfies typeof Inspection.TimelinePage.Type)
  })
