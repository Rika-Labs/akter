import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { type AnyWorkflow, isWorkflow } from "../../members/workflow.ts"
import { manifestOf, toJson } from "./manifest.ts"

/** One reason a deployment cannot run the open executions it would inherit. */
export interface Incompatibility {
  readonly actorType: string
  readonly workflow: string
  /** What changed, e.g. `step "label" removed` or `marker "fraud" 1 outside 2..3`. */
  readonly problem: string
  /** Open executions the change strands. */
  readonly open: number
  /** When the oldest of them started, in epoch milliseconds. */
  readonly oldestStartedAtMs: number
}

/** An actor type as a deployment declares it: its name and its workflow members. */
export interface DeclaredActor {
  readonly name: string
  readonly workflows: ReadonlyArray<AnyWorkflow>
}

/** The workflow members of an `Actor.make` definition. */
export const declaredOf = (actor: {
  readonly name: string
  readonly api: object
}): DeclaredActor => ({
  name: actor.name,
  workflows: Object.values(actor.api as Record<string, { readonly kind: string }>).filter(
    isWorkflow,
  ),
})

const StoredManifest = Schema.Struct({
  input: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.String,
      result: Schema.String,
    }),
  ),
})

type StoredManifest = typeof StoredManifest.Type

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredManifest))

/** Decodes the steps of a stored manifest. */
export const decodeStoredManifest = (manifest: string) => decodeManifest(manifest)

interface Current {
  readonly member: AnyWorkflow
  readonly hash: string
  readonly input: string
  readonly steps: ReadonlyMap<string, { readonly kind: string; readonly result: string }>
}

const currentOf = Effect.fnUntraced(function* (declared: ReadonlyArray<DeclaredActor>) {
  const current = new Map<string, Map<string, Current>>()

  for (const actor of declared) {
    const workflows = new Map<string, Current>()

    for (const member of actor.workflows) {
      const { manifest, hash } = yield* manifestOf(actor.name, member)
      workflows.set(member.tag, {
        member,
        hash,
        input: manifest.input,
        steps: new Map(manifest.steps.map((step) => [step.name, step])),
      })
    }

    current.set(actor.name, workflows)
  }

  return current
})

/** The steps of `stored` this deployment no longer registers, or registers as another kind. */
export const missingSteps = ({
  stored,
  steps,
}: {
  readonly stored: StoredManifest
  readonly steps: ReadonlyMap<string, { readonly kind: string }>
}) =>
  stored.steps.flatMap((step) => {
    const kind = steps.get(step.name)?.kind

    if (kind === undefined) return [`step "${step.name}" removed`]

    return kind === step.kind ? [] : [`step "${step.name}" changed from ${step.kind} to ${kind}`]
  })

/** The steps of `stored` whose recorded results `steps` would decode under a different schema. */
export const changedSteps = ({
  stored,
  steps,
}: {
  readonly stored: Pick<StoredManifest, "steps">
  readonly steps: ReadonlyMap<string, { readonly result: string }>
}) =>
  stored.steps.flatMap((entry) => {
    const step = steps.get(entry.name)

    return step !== undefined && entry.result !== step.result ? [entry.name] : []
  })

/**
 * Compares `declared` with every open execution of its actor types (of every
 * actor type with `everyActorType`) and the manifests they started under.
 * An open execution blocks a deployment when its actor type or workflow is
 * gone, its start manifest has a step the deployment doesn't register as the
 * same kind, a step it recorded changed its result schema, a marker it
 * recorded is undeclared or outside `min..current`, or it predates a marker
 * whose `min` is above 0. Grouped by actor type, workflow and problem.
 *
 * An execution that started after the groups were read brings its manifest into
 * the comparison. A start manifest already reports a missing step for every
 * execution under it, so those executions are not reported again.
 */
export const findIncompatibilities = Effect.fnUntraced(function* (
  declared: ReadonlyArray<DeclaredActor>,
  options: { readonly everyActorType: boolean },
) {
  const sql = yield* SqlClient.SqlClient
  const current = yield* currentOf(declared)
  const types = toJson([...current.keys()])

  const scope = options.everyActorType
    ? sql`TRUE`
    : sql`x.actor_type IN (SELECT jsonb_array_elements_text(${types}::jsonb))`

  const found = new Map<string, Incompatibility>()

  const add = (
    actorType: string,
    workflow: string,
    problem: string,
    open: number,
    oldest: number,
  ) => {
    const key = toJson([actorType, workflow, problem])
    const seen = found.get(key)
    found.set(key, {
      actorType,
      workflow,
      problem,
      open: (seen?.open ?? 0) + open,
      oldestStartedAtMs: Math.min(seen?.oldestStartedAtMs ?? oldest, oldest),
    })
  }

  const groups = yield* sql<{
    actor_type: string
    workflow: string
    manifest_hash: string
    manifest: string | null
    open: number
    oldest: string
  }>`SELECT x.actor_type, x.workflow, x.manifest_hash, m.manifest::text AS manifest,
      count(*)::integer AS open, min(x.started_at_ms)::text AS oldest
    FROM actor_workflow_executions x
    LEFT JOIN actor_workflow_manifests m ON m.actor_type = x.actor_type AND m.workflow = x.workflow
      AND m.manifest_hash = x.manifest_hash
    WHERE x.status <> 'finished' AND ${scope}
    GROUP BY x.actor_type, x.workflow, x.manifest_hash, m.manifest::text`

  const manifests = new Map<string, StoredManifest | undefined>()

  for (const group of groups) {
    const oldest = Number(group.oldest)
    const workflows = current.get(group.actor_type)

    if (workflows === undefined) {
      add(group.actor_type, group.workflow, "actor type removed", group.open, oldest)
      continue
    }

    const workflow = workflows.get(group.workflow)

    if (workflow === undefined) {
      add(group.actor_type, group.workflow, "workflow removed", group.open, oldest)
      continue
    }

    const stored =
      group.manifest === null
        ? undefined
        : yield* decodeStoredManifest(group.manifest).pipe(Effect.orDie)

    manifests.set(toJson([group.actor_type, group.workflow, group.manifest_hash]), stored)

    if (group.manifest_hash === workflow.hash) continue

    if (stored === undefined) {
      add(group.actor_type, group.workflow, "start manifest missing", group.open, oldest)
      continue
    }

    for (const problem of missingSteps({ stored, steps: workflow.steps }))
      add(group.actor_type, group.workflow, problem, group.open, oldest)

    if (stored.input !== workflow.input)
      add(group.actor_type, group.workflow, "input schema changed", group.open, oldest)
  }

  const recorded = yield* sql<{
    actor_type: string
    workflow: string
    manifest_hash: string
    manifest: string | null
    step: string
    kind: string
    version: number | null
    open: number
    oldest: string
  }>`SELECT x.actor_type, x.workflow, x.manifest_hash, m.manifest::text AS manifest, s.step, s.kind,
      CASE WHEN s.kind = 'version' THEN s.version END AS version,
      count(DISTINCT x.execution_id)::integer AS open, min(x.started_at_ms)::text AS oldest
    FROM actor_workflow_executions x
    JOIN actor_workflow_step s ON s.routing_key = x.routing_key AND s.execution_id = x.execution_id
    LEFT JOIN actor_workflow_manifests m ON m.actor_type = x.actor_type AND m.workflow = x.workflow
      AND m.manifest_hash = x.manifest_hash
    WHERE x.status <> 'finished' AND ${scope} AND (s.kind = 'version' OR s.exit IS NOT NULL)
    GROUP BY x.actor_type, x.workflow, x.manifest_hash, m.manifest::text, s.step, s.kind,
      CASE WHEN s.kind = 'version' THEN s.version END`

  for (const row of recorded) {
    const workflow = current.get(row.actor_type)?.get(row.workflow)

    if (workflow === undefined) continue
    const oldest = Number(row.oldest)

    if (row.kind === "version") {
      const range = workflow.member.versions[row.step]

      if (range === undefined)
        add(row.actor_type, row.workflow, `marker "${row.step}" removed`, row.open, oldest)
      else if (row.version! < range.min || row.version! > range.current)
        add(
          row.actor_type,
          row.workflow,
          `marker "${row.step}" ${row.version} outside ${range.min}..${range.current}`,
          row.open,
          oldest,
        )

      continue
    }

    const step = workflow.steps.get(row.step)
    const key = toJson([row.actor_type, row.workflow, row.manifest_hash])

    if (!manifests.has(key))
      manifests.set(
        key,
        row.manifest === null
          ? undefined
          : yield* decodeStoredManifest(row.manifest).pipe(Effect.orDie),
      )

    const stored = manifests.get(key)

    if (step === undefined || step.kind !== row.kind) {
      if (stored === undefined)
        add(
          row.actor_type,
          row.workflow,
          step === undefined
            ? `step "${row.step}" removed`
            : `step "${row.step}" changed from ${row.kind} to ${step.kind}`,
          row.open,
          oldest,
        )

      continue
    }

    if (stored === undefined || row.manifest_hash === workflow.hash) continue
    const entry = stored.steps.find((candidate) => candidate.name === row.step)

    if (entry === undefined) continue

    if (changedSteps({ stored: { steps: [entry] }, steps: workflow.steps }).length > 0)
      add(
        row.actor_type,
        row.workflow,
        `step "${row.step}" result schema changed`,
        row.open,
        oldest,
      )
  }

  for (const [actorType, workflows] of current)
    for (const [tag, workflow] of workflows)
      for (const [name, range] of Object.entries(workflow.member.versions)) {
        if (range.min <= 0) continue

        const [predating] = yield* sql<{ open: number; oldest: string | null }>`
          SELECT count(*)::integer AS open, min(x.started_at_ms)::text AS oldest
          FROM actor_workflow_executions x
          WHERE x.actor_type = ${actorType} AND x.workflow = ${tag} AND x.status <> 'finished'
            AND NOT EXISTS (SELECT 1 FROM actor_workflow_step s WHERE s.routing_key = x.routing_key
              AND s.execution_id = x.execution_id AND s.kind = 'version' AND s.step = ${name})`

        if (predating !== undefined && predating.open > 0)
          add(
            actorType,
            tag,
            `marker "${name}" min ${range.min} > 0 for executions that predate it`,
            predating.open,
            Number(predating.oldest),
          )
      }

  return [...found.values()].sort(
    (left, right) =>
      left.actorType.localeCompare(right.actorType) ||
      left.workflow.localeCompare(right.workflow) ||
      left.problem.localeCompare(right.problem),
  )
})

/** `Order/Ship  step "label" removed  412 open executions (oldest 2026-09-20T08:14:00.000Z)` */
export const formatIncompatibility = (incompatibility: Incompatibility) =>
  `${incompatibility.actorType}/${incompatibility.workflow}  ${incompatibility.problem}  ${
    incompatibility.open
  } open execution${incompatibility.open === 1 ? "" : "s"} (oldest ${DateTime.formatIso(DateTime.makeUnsafe(incompatibility.oldestStartedAtMs))})`

/**
 * The startup check for one actor type. It skips the comparison when each
 * workflow's manifest is already the most recently accepted one, no accepted
 * workflow is gone and no open execution started under another manifest; otherwise it compares, and a passing deployment
 * becomes the most recently accepted one, so a rollback is compared again.
 * `retained`: the actor type has workflows or workflow rows retention sweeps.
 *
 * A runner of an older deployment may have started executions since the last
 * comparison, and a comparison that finds no open execution of a dropped workflow
 * lets the deployment pass.
 */
export const acceptWorkflows = Effect.fnUntraced(function* (actor: DeclaredActor) {
  const sql = yield* SqlClient.SqlClient

  if (actor.workflows.length === 0) {
    const [history] = yield* sql<{ accepted: boolean; executions: boolean }>`SELECT
      EXISTS (SELECT 1 FROM actor_workflow_manifests WHERE actor_type = ${actor.name}) AS accepted,
      EXISTS (SELECT 1 FROM actor_workflow_executions WHERE actor_type = ${actor.name}) AS executions`

    if (!history!.accepted)
      return { checked: false, incompatibilities: [], retained: history!.executions }
  }

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`durable-actors/workflows/${actor.name}`}))`

      const latest = yield* sql<{ workflow: string; manifest_hash: string }>`
        SELECT DISTINCT ON (workflow) workflow, manifest_hash FROM actor_workflow_manifests
        WHERE actor_type = ${actor.name}
        ORDER BY workflow, accepted_at_ms DESC, manifest_hash`

      const rows: Array<{
        readonly actor_type: string
        readonly workflow: string
        readonly manifest_hash: string
        readonly manifest: string
      }> = []

      for (const member of actor.workflows) {
        const { manifest, hash } = yield* manifestOf(actor.name, member)
        rows.push({
          actor_type: actor.name,
          workflow: member.tag,
          manifest_hash: hash,
          manifest: toJson(manifest),
        })
      }

      const unchanged =
        latest.length === rows.length &&
        latest.every((row) =>
          rows.some(
            (current) =>
              current.workflow === row.workflow && current.manifest_hash === row.manifest_hash,
          ),
        )

      const foreign =
        unchanged &&
        (yield* sql`SELECT 1 FROM actor_workflow_executions x
          WHERE x.actor_type = ${actor.name} AND x.status <> 'finished'
            AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${toJson(rows)}::jsonb)
              AS d (workflow text, manifest_hash text)
              WHERE d.workflow = x.workflow AND d.manifest_hash = x.manifest_hash)
          LIMIT 1`).length > 0

      if (unchanged && !foreign) return { checked: false, incompatibilities: [], retained: true }

      const incompatibilities = yield* findIncompatibilities([actor], { everyActorType: false })

      if (incompatibilities.length > 0) return { checked: true, incompatibilities, retained: true }

      if (rows.length > 0)
        yield* sql`INSERT INTO actor_workflow_manifests AS a (actor_type, workflow, manifest_hash, manifest, accepted_at_ms)
          SELECT m.actor_type, m.workflow, m.manifest_hash, m.manifest::jsonb,
            GREATEST(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
              (SELECT max(l.accepted_at_ms) + 1 FROM actor_workflow_manifests l
                WHERE l.actor_type = m.actor_type AND l.workflow = m.workflow))
          FROM jsonb_to_recordset(${toJson(rows)}::jsonb)
            AS m (actor_type text, workflow text, manifest_hash text, manifest text)
          ON CONFLICT (actor_type, workflow, manifest_hash)
            DO UPDATE SET accepted_at_ms = EXCLUDED.accepted_at_ms`

      yield* sql`DELETE FROM actor_workflow_manifests WHERE actor_type = ${actor.name}
        AND workflow NOT IN (SELECT jsonb_array_elements_text(${toJson(rows.map((row) => row.workflow))}::jsonb))`

      return { checked: true, incompatibilities: [], retained: true }
    }),
  )
})

/**
 * The deploy check `durable workflows check` runs: every actor type in the
 * database against `actors`, in one read-only snapshot.
 */
export const checkWorkflows = (
  actors: ReadonlyArray<{ readonly name: string; readonly api: object }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return yield* sql.withTransaction(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(
        Effect.andThen(findIncompatibilities(actors.map(declaredOf), { everyActorType: true })),
      ),
    )
  })
