import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { descriptorOf } from "../../actor/descriptor.ts"
import { type DefinitionPayloads, type PayloadDeclaration } from "../../members/payload.ts"
import { inReadOnlySnapshot } from "../database/snapshot.ts"
import { databaseTime } from "../turn/admission.ts"
import { textArray } from "../turn/outbox.ts"

/** How long a runtime's writer rows stay live without a refresh, by default. */
export const DEFAULT_WRITER_WINDOW_MS = 120_000

/** A stored version the deployment could not read, or a removal that would strand one. */
export interface PayloadProblem {
  readonly actorType: string
  readonly kind: "event" | "job"
  readonly tag: string
  /** What would be stranded, e.g. `version 2 recorded above this chain's current version 1`. */
  readonly problem: string
}

/** A one-line operator-facing description of a payload problem. */
export const formatPayloadProblem = (problem: PayloadProblem) =>
  `${problem.actorType}/${problem.tag} (${problem.kind})  ${problem.problem}`

const keyOf = (declared: Pick<PayloadDeclaration, "actorType" | "kind" | "tag">) =>
  `${declared.actorType}\u0000${declared.kind}\u0000${declared.tag}`

interface RecordedVersion {
  readonly actor_type: string
  readonly kind: "event" | "job"
  readonly tag: string
  readonly version: number
  readonly cleared: boolean
}

/**
 * Compares declared chains with the versions the database may hold. A
 * version recorded above a chain's current version is a rollback past a
 * schema change. A chain that starts above version `v` can't read values of
 * `v`: an event version counts as stored until `durable payloads clear` marks
 * it cleared. Every stored event has a recorded version, because a runtime
 * records what it writes before it takes a shard and the migration refused
 * databases that held rows before it. Job versions are read from the
 * outbox and dead letters directly. `writers` names the actor types whose
 * turns this deployment runs: an event tag one of them no longer declares is
 * refused while a subscription still has undelivered events of it.
 */
export const findPayloadProblems = Effect.fnUntraced(function* (
  declarations: ReadonlyArray<PayloadDeclaration>,
  writers: ReadonlyArray<{
    readonly actorType: string
    readonly events: ReadonlyArray<string>
  }> = [],
) {
  const sql = yield* SqlClient.SqlClient
  const problems: Array<PayloadProblem> = []

  const actorTypes = [
    ...new Set([...declarations.map((d) => d.actorType), ...writers.map((w) => w.actorType)]),
  ]

  if (actorTypes.length === 0) return problems

  const recorded = yield* sql<RecordedVersion>`SELECT actor_type, kind, tag, version,
      cleared_at_ms IS NOT NULL AS cleared
    FROM actor_payload_versions WHERE actor_type IN ${sql.in(actorTypes)}`

  const byTag = new Map<string, Array<RecordedVersion>>()

  for (const row of recorded) {
    const key = keyOf({ actorType: row.actor_type, kind: row.kind, tag: row.tag })
    byTag.set(key, [...(byTag.get(key) ?? []), row])
  }

  const seen = new Set<string>()

  for (const declared of declarations) {
    const key = `${keyOf(declared)}\u0000${declared.chain.first}\u0000${declared.chain.current}`

    if (seen.has(key)) continue
    seen.add(key)
    const { first, current } = declared.chain
    const versions = byTag.get(keyOf(declared)) ?? []

    const problem = (text: string) =>
      problems.push({
        actorType: declared.actorType,
        kind: declared.kind,
        tag: declared.tag,
        problem: text,
      })

    const newest = Math.max(-1, ...versions.map((row) => row.version))

    if (newest > current)
      problem(
        `version ${newest} recorded above this chain's current version ${current}: a rollback past a payload schema change`,
      )

    if (first === 0) continue

    if (declared.kind === "event") {
      for (const row of versions)
        if (row.version < first && !row.cleared)
          problem(
            `version ${row.version} may still be stored below this chain's first version ${first}; run durable payloads clear once its events are gone`,
          )
    } else {
      const [stored] = yield* sql<{ version: number | null; rows: number }>`
        SELECT min(v)::int AS version, count(*)::int AS rows FROM (
          SELECT payload_version AS v FROM actor_outbox
          WHERE kind = 'job' AND actor_type = ${declared.actorType} AND command = ${declared.tag}
            AND payload_version < ${first}
          UNION ALL
          SELECT payload_version FROM actor_dead_letters
          WHERE actor_type = ${declared.actorType} AND job = ${declared.tag}
            AND payload_version < ${first}) stored`

      if (stored !== undefined && stored.version !== null)
        problem(
          `version ${stored.version} stored in ${stored.rows} pending job or dead letter row${stored.rows === 1 ? "" : "s"} below this chain's first version ${first}`,
        )
    }
  }

  for (const writer of writers) {
    const removed = [
      ...new Set(
        recorded
          .filter(
            (row) =>
              row.actor_type === writer.actorType &&
              row.kind === "event" &&
              !writer.events.includes(row.tag),
          )
          .map((row) => row.tag),
      ),
    ]

    for (const tag of removed) {
      const [pending] = yield* sql<{ subscriber_type: string; subscription: string }>`
        SELECT s.subscriber_type, s.subscription FROM actor_subscriptions s
        WHERE s.source_type = ${writer.actorType} AND ${tag} = ANY(s.events)
          AND EXISTS (SELECT 1 FROM actor_events e
            WHERE e.routing_key = s.routing_key AND e.tenant_id = s.tenant_id
              AND e.actor_type = s.source_type AND e.actor_id = s.source_id
              AND e.event = ${tag} AND e.sequence > s.delivered)
        LIMIT 1`

      if (pending !== undefined)
        problems.push({
          actorType: writer.actorType,
          kind: "event",
          tag,
          problem: `event class removed while subscription ${pending.subscriber_type}.${pending.subscription} has undelivered events of it`,
        })
    }
  }

  return problems
})

/**
 * Records the version each written class is written at, and marks every
 * lower recorded version superseded. Writing a version again clears its
 * `superseded` and `cleared` marks, since values of it are being stored anew.
 */
export const recordPayloadVersions = Effect.fnUntraced(function* (
  declarations: ReadonlyArray<PayloadDeclaration>,
) {
  const written = declarations.filter((declared) => declared.writes)

  if (written.length === 0) return
  const sql = yield* SqlClient.SqlClient
  const now = yield* databaseTime

  yield* sql`WITH declared (actor_type, kind, tag, version) AS (
      SELECT * FROM unnest(${textArray({ sql, values: written.map((d) => d.actorType) })},
        ${textArray({ sql, values: written.map((d) => d.kind) })},
        ${textArray({ sql, values: written.map((d) => d.tag) })},
        ${textArray({ sql, values: written.map((d) => String(d.chain.writeVersion)) })}::int[])),
    recorded AS (
      INSERT INTO actor_payload_versions (actor_type, kind, tag, version, first_written_at_ms)
      SELECT actor_type, kind, tag, version, ${now} FROM declared
      ON CONFLICT (actor_type, kind, tag, version) DO UPDATE
        SET superseded_at_ms = NULL, cleared_at_ms = NULL
        WHERE actor_payload_versions.superseded_at_ms IS NOT NULL
      RETURNING 1)
    UPDATE actor_payload_versions v SET superseded_at_ms = ${now}
    FROM declared d
    WHERE v.actor_type = d.actor_type AND v.kind = d.kind AND v.tag = d.tag
      AND v.version < d.version AND v.superseded_at_ms IS NULL`
})

/** Upserts this runtime's writer row for each class it writes, stamped now, in one statement. */
export const refreshWriters = Effect.fnUntraced(function* (
  runtimeId: string,
  windowMs: number,
  declarations: ReadonlyArray<PayloadDeclaration>,
) {
  const written = declarations.filter((declared) => declared.writes)

  if (written.length === 0) return
  const sql = yield* SqlClient.SqlClient
  const now = yield* databaseTime

  yield* sql`INSERT INTO actor_payload_writers (runtime_id, actor_type, kind, tag, version,
      window_ms, refreshed_at_ms)
    SELECT DISTINCT ${runtimeId}, actor_type, kind, tag, version, ${windowMs}::bigint, ${now}::bigint
    FROM unnest(${textArray({ sql, values: written.map((d) => d.actorType) })},
      ${textArray({ sql, values: written.map((d) => d.kind) })},
      ${textArray({ sql, values: written.map((d) => d.tag) })},
      ${textArray({ sql, values: written.map((d) => String(d.chain.writeVersion)) })}::int[])
      AS declared (actor_type, kind, tag, version)
    ON CONFLICT (runtime_id, actor_type, kind, tag, version)
    DO UPDATE SET refreshed_at_ms = EXCLUDED.refreshed_at_ms, window_ms = EXCLUDED.window_ms`
})

/** Drops a stopping runtime's writer rows, so a clear need not wait out its window. */
export const dropWriters = (runtimeId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM actor_payload_writers WHERE runtime_id = ${runtimeId}`
  })

const definitionsOf = (actors: ReadonlyArray<object>) =>
  actors.flatMap((actor): ReadonlyArray<DefinitionPayloads> => {
    const payloads = descriptorOf(actor)?.definitionPayloads

    return payloads === undefined ? [] : [payloads]
  })

/** `durable payloads check`: the startup check for `actors`, read-only. */
export const checkPayloads = (actors: ReadonlyArray<object>) =>
  Effect.suspend(() => {
    const definitions = definitionsOf(actors)

    return inReadOnlySnapshot(
      findPayloadProblems(
        definitions.flatMap((d) => d.declarations),
        definitions.flatMap((d) => {
          const actorType = d.declarations[0]?.actorType

          return actorType === undefined
            ? []
            : [
                {
                  actorType,
                  events: d.declarations
                    .filter((declared) => declared.kind === "event")
                    .map((declared) => declared.tag),
                },
              ]
        }),
      ),
    )
  })

/** What `durable payloads clear` found for one superseded event version. */
export interface ClearResult {
  readonly actorType: string
  readonly tag: string
  readonly version: number
  /**
   * `cleared`, or why not: a runtime refreshed a writer row for the version
   * within its window plus the longest command timeout, or an event of the
   * version is still stored.
   */
  readonly outcome: "cleared" | "writer" | "stored"
}

/**
 * `durable payloads clear`: marks each superseded event version of `actors`
 * cleared once its retention horizon has passed, no runtime can still write
 * it, and no event of it remains. The version row is locked first, the
 * writer rows are read again after the scan, and each statement of the
 * transaction reads a fresh snapshot, so a writer that registers during the
 * scan fails the clear instead of racing it. A writer counts as live until
 * its window and then the longest command timeout have passed.
 */
export const clearPayloads = (actors: ReadonlyArray<object>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const definitions = definitionsOf(actors)
    const commandTimeoutMs = Math.max(0, ...definitions.map((d) => d.commandTimeoutMs))
    const results: Array<ClearResult> = []

    for (const definition of definitions)
      for (const declared of definition.declarations) {
        if (declared.kind !== "event") continue
        const now = yield* databaseTime

        const due = yield* sql<{ version: number }>`SELECT version FROM actor_payload_versions
          WHERE actor_type = ${declared.actorType} AND kind = 'event' AND tag = ${declared.tag}
            AND cleared_at_ms IS NULL AND superseded_at_ms IS NOT NULL
            AND superseded_at_ms + ${definition.keepEventsMs}::bigint <= ${now}
          ORDER BY version`

        for (const { version } of due) {
          const writing = Effect.gen(function* () {
            const at = yield* databaseTime

            return yield* sql`SELECT 1 FROM actor_payload_writers
              WHERE actor_type = ${declared.actorType} AND kind = 'event' AND tag = ${declared.tag}
                AND version = ${version}
                AND refreshed_at_ms + window_ms + ${commandTimeoutMs}::bigint > ${at}
              LIMIT 1`
          })

          const outcome = yield* sql.withTransaction(
            Effect.gen(function* () {
              const locked = yield* sql`SELECT 1 FROM actor_payload_versions
                WHERE actor_type = ${declared.actorType} AND kind = 'event' AND tag = ${declared.tag}
                  AND version = ${version} AND cleared_at_ms IS NULL
                  AND superseded_at_ms IS NOT NULL
                FOR UPDATE`

              if (locked.length === 0) return undefined

              if ((yield* writing).length > 0) return "writer" as const

              const stored = yield* sql`SELECT 1 FROM actor_events
                WHERE actor_type = ${declared.actorType} AND event = ${declared.tag}
                  AND payload_version = ${version}
                LIMIT 1`

              if (stored.length > 0) return "stored" as const

              if ((yield* writing).length > 0) return "writer" as const

              yield* sql`UPDATE actor_payload_versions SET cleared_at_ms = ${yield* databaseTime}
                WHERE actor_type = ${declared.actorType} AND kind = 'event' AND tag = ${declared.tag}
                  AND version = ${version}`

              return "cleared" as const
            }),
          )

          if (outcome !== undefined)
            results.push({ actorType: declared.actorType, tag: declared.tag, version, outcome })
        }
      }

    return results
  })
