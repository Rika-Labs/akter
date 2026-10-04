import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { coordinated } from "../database/coordination.ts"
import { type AnyWorkflow, isWorkflow, type VersionRange } from "../../members/workflow.ts"
import { inReadOnlySnapshot } from "../database/snapshot.ts"
import { type Declared, manifestOf, toJson } from "./manifest.ts"

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
interface DeclaredActor {
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
  payload: Schema.String,
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

/** Why `declared` cannot continue the executions a start manifest covers, and which of its steps it would decode under another result schema. */
export interface StartVerdict {
  readonly problems: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
}

const sameManifest: StartVerdict = { problems: [], changed: [] }

/**
 * The verdict on executions that started under `hash`, whose stored manifest is
 * `start` (undefined when its row is missing). A start manifest has to list
 * only steps `declared` registers as the same kind and share its payload schema.
 * `newer` means it was accepted after `declared`: a runner then also refuses it
 * when a shared step's result schema differs, because the newer deployment may
 * record such results at any time.
 */
export const startVerdict = ({
  declared,
  hash,
  start,
  newer,
}: {
  readonly declared: Declared
  readonly hash: string
  readonly start: StoredManifest | undefined
  readonly newer: boolean
}): StartVerdict => {
  if (hash === declared.hash) return sameManifest

  if (start === undefined) return { problems: ["start manifest missing"], changed: [] }

  const changed = start.steps.flatMap((entry) => {
    const step = declared.steps.get(entry.name)

    return step !== undefined && entry.result !== step.result ? [entry.name] : []
  })

  const problems = start.steps.flatMap((entry) => {
    const kind = declared.steps.get(entry.name)?.kind

    if (kind === undefined) return [`step "${entry.name}" removed`]

    return kind === entry.kind ? [] : [`step "${entry.name}" changed from ${entry.kind} to ${kind}`]
  })

  if (start.payload !== declared.manifest.payload) problems.push("payload schema changed")

  if (newer)
    for (const name of changed)
      problems.push(`step "${name}" result schema changed by a newer deployment`)

  return { problems, changed }
}

/**
 * Why an execution's value for marker `name` is unsupported: `recorded` is
 * undefined when the execution predates the marker, and reads as 0.
 */
export const markerProblem = ({
  versions,
  name,
  recorded,
}: {
  readonly versions: Readonly<Record<string, VersionRange>>
  readonly name: string
  readonly recorded: number | undefined
}) => {
  const range = versions[name]

  if (range === undefined) return recorded === undefined ? [] : [`marker "${name}" removed`]

  if (recorded === undefined)
    return range.min > 0
      ? [`marker "${name}" min ${range.min} > 0 for executions that predate it`]
      : []

  return recorded < range.min || recorded > range.current
    ? [`marker "${name}" ${recorded} outside ${range.min}..${range.current}`]
    : []
}

/**
 * Why `declared` cannot replay a recorded step: it no longer registers the
 * step as that kind, or the step settled under a result schema in `changed`.
 */
export const recordedStepProblem = ({
  declared,
  step,
  kind,
  settled,
  changed,
}: {
  readonly declared: Declared
  readonly step: string
  readonly kind: string
  readonly settled: boolean
  readonly changed: ReadonlyArray<string>
}) => {
  const registered = declared.steps.get(step)?.kind

  if (registered === undefined) return [`step "${step}" removed`]

  if (registered !== kind) return [`step "${step}" changed from ${kind} to ${registered}`]

  return settled && changed.includes(step) ? [`step "${step}" result schema changed`] : []
}

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
  const current = new Map<string, Map<string, { member: AnyWorkflow; declared: Declared }>>()

  for (const actor of declared) {
    const workflows = new Map<string, { member: AnyWorkflow; declared: Declared }>()

    for (const member of actor.workflows)
      workflows.set(member.tag, { member, declared: yield* manifestOf(actor.name, member) })

    current.set(actor.name, workflows)
  }

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

  const verdicts = new Map<string, StartVerdict>()

  const verdictOf = Effect.fnUntraced(function* (
    actorType: string,
    workflow: { readonly member: AnyWorkflow; readonly declared: Declared },
    hash: string,
    manifest: string | null,
  ) {
    const key = toJson([actorType, workflow.member.tag, hash])
    const known = verdicts.get(key)

    if (known !== undefined) return known

    const verdict = startVerdict({
      declared: workflow.declared,
      hash,
      start:
        manifest === null ? undefined : yield* decodeStoredManifest(manifest).pipe(Effect.orDie),
      newer: false,
    })

    verdicts.set(key, verdict)

    return verdict
  })

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

    const verdict = yield* verdictOf(
      group.actor_type,
      workflow,
      group.manifest_hash,
      group.manifest,
    )

    for (const problem of verdict.problems)
      add(group.actor_type, group.workflow, problem, group.open, oldest)
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

    const problems =
      row.kind === "version"
        ? markerProblem({
            versions: workflow.member.versions,
            name: row.step,
            recorded: row.version!,
          })
        : workflow.declared.steps.get(row.step)?.kind !== row.kind && row.manifest !== null
          ? []
          : recordedStepProblem({
              declared: workflow.declared,
              step: row.step,
              kind: row.kind,
              settled: true,
              changed: (yield* verdictOf(row.actor_type, workflow, row.manifest_hash, row.manifest))
                .changed,
            })

    for (const problem of problems) add(row.actor_type, row.workflow, problem, row.open, oldest)
  }

  for (const [actorType, workflows] of current)
    for (const [tag, { member }] of workflows)
      for (const name of Object.keys(member.versions)) {
        const problems = markerProblem({ versions: member.versions, name, recorded: undefined })

        if (problems.length === 0) continue

        const [predating] = yield* sql<{ open: number; oldest: string | null }>`
          SELECT count(*)::integer AS open, min(x.started_at_ms)::text AS oldest
          FROM actor_workflow_executions x
          WHERE x.actor_type = ${actorType} AND x.workflow = ${tag} AND x.status <> 'finished'
            AND NOT EXISTS (SELECT 1 FROM actor_workflow_step s WHERE s.routing_key = x.routing_key
              AND s.execution_id = x.execution_id AND s.kind = 'version' AND s.step = ${name})`

        if (predating !== undefined && predating.open > 0)
          for (const problem of problems)
            add(actorType, tag, problem, predating.open, Number(predating.oldest))
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

  return yield* coordinated({
    resource: `akter/workflows/${actor.name}`,
    work: Effect.gen(function* () {
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
  })
})

/**
 * The deploy check `akter workflows check` runs: every actor type in the
 * database against `actors`, in one read-only snapshot.
 */
export const checkWorkflows = (
  actors: ReadonlyArray<{ readonly name: string; readonly api: object }>,
) =>
  Effect.suspend(() =>
    inReadOnlySnapshot(findIncompatibilities(actors.map(declaredOf), { everyActorType: true })),
  )
