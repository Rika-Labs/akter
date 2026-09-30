import {
  Cause,
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  Fiber,
  Latch,
  Option,
  Schema,
  Scope,
} from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { Activity, Workflow as EffectWorkflow, WorkflowEngine } from "effect/unstable/workflow"
import {
  CallPhase,
  CurrentCallPhase,
  CurrentWorkflow,
  RecordedExit,
  StoredResult,
  type StepIdentity,
  type WorkflowSteps,
} from "../../contexts/workflow.ts"
import { ActivityOutcomeUnknown } from "../../errors/workflow.ts"
import {
  type BusinessResult,
  type RegisteredCommand,
  type RegisteredWorkflow,
  type Registration,
} from "../members.ts"
import { Outcome, Request } from "../request.ts"
import { Due, emptyOutbox } from "../../handles/intents.ts"
import {
  ExecutionIdOutput,
  INTERRUPT,
  RESUME,
  START,
  StartPayload,
  ExecutionTarget,
} from "../../handles/workflow.ts"
import { type ActorRef, Caller, type Principal, principal, System } from "../../identity/caller.ts"
import { decodeExecutionId, encodeExecutionId } from "../../identity/execution.ts"
import { bucketOf, OutboxRuntime, writeOutbox } from "../turn/outbox.ts"
import { databaseTime } from "../turn/admission.ts"
import { TurnHooks } from "../turn/hooks.ts"
import { compress, decompress } from "../storage/codec.ts"
import type { ActivationCache } from "../storage/generation.ts"
import { changedSteps, decodeStoredManifest, missingSteps } from "./compatibility.ts"
import { manifestOf, toJson } from "./manifest.ts"

/** A running activity re-arms its execution's timer this far ahead, so a lost runner's work resumes. */
export const RECOVERY_MS = 30_000

/** The outbox timer key of an execution's recovery timer. */
export const timerKey = (executionId: string) => `wf:${executionId}`

const CallerJson = Schema.fromJsonString(Caller)

const encodeCaller = Schema.encodeEffect(CallerJson)

const decodeCaller = Schema.decodeEffect(CallerJson)

const encodeExecutionOutput = Schema.encodeEffect(ExecutionIdOutput)

const encodeTarget = Schema.encodeEffect(ExecutionTarget)

const decodeTarget = Schema.decodeEffect(ExecutionTarget)

const decodeStart = Schema.decodeEffect(StartPayload)

/** Dies a run whose activation no longer holds the owner's generation; nothing it wrote commits. */
class StaleRun extends Data.TaggedError("StaleRun")<{}> {}

/** Ends a replay that reached a step it must wait for; its rows and timer are committed. */
class Suspend extends Data.TaggedError("Suspend")<{}> {}

const isSignal = (signal: typeof StaleRun | typeof Suspend) => (cause: Cause.Cause<unknown>) =>
  cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof signal)

const suspended = isSignal(Suspend)

const stale = isSignal(StaleRun)

const owner = (sql: SqlClient.SqlClient, routingKey: bigint, ref: ActorRef) =>
  sql`routing_key = ${routingKey} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

const success = (value: string): BusinessResult => ({
  outcome: Outcome.cases.Success.make({ value }),
  state: [],
  complete: false,
  events: [],
  outbox: emptyOutbox,
})

/** Writes the execution's one keyed resume timer, replacing any pending one. */
const armTimer = Effect.fnUntraced(function* (
  routingKey: bigint,
  ref: ActorRef,
  executionId: string,
  dueAt: number | undefined,
  onBehalfOf: Option.Option<Principal>,
) {
  const key = timerKey(executionId)

  return yield* writeOutbox(routingKey, ref, {
    intents: [
      {
        target: ref,
        command: RESUME,
        payload: yield* encodeTarget({ executionId }).pipe(Effect.orDie),
        caller: System.make({
          source: "workflow",
          ref,
          onBehalfOf: Option.getOrUndefined(onBehalfOf),
        }),
        due: dueAt === undefined ? undefined : Due.cases.At.make({ epochMillis: dueAt }),
        key,
      },
    ],
    replaced: [key],
    effects: [],
    subscriptions: [],
    cancelledEffects: [],
  })
})

const deleteTimer = (
  sql: SqlClient.SqlClient,
  routingKey: bigint,
  ref: ActorRef,
  executionId: string,
) =>
  sql`DELETE FROM actor_outbox WHERE ${owner(sql, routingKey, ref)} AND timer_key = ${timerKey(executionId)}`

/**
 * Inserts an execution with its version markers inside the starting owner
 * turn. A repeated start attaches: nothing is rewritten.
 *
 * An owner-staged start's cursor sits before the staging turn's events, so a wait
 * sees them and every later owner event, including ones committed before the
 * start is delivered. The run starts at once on this activation and the recovery
 * timer resumes it if this runner dies first. The start manifest is restored if
 * retention pruned it while a runner of an older deployment still starts
 * executions under it.
 */
const insertExecution = Effect.fnUntraced(function* (options: {
  readonly routingKey: bigint
  readonly ref: ActorRef
  readonly workflow: RegisteredWorkflow
  readonly executionId: string
  readonly key: string
  readonly input: string
  readonly caller: Caller
  readonly after: string | null
}) {
  const sql = yield* SqlClient.SqlClient
  const { routingKey, ref, workflow, executionId } = options
  const now = yield* databaseTime
  const manifest = yield* manifestOf(ref.actor, workflow.member)

  const inserted = yield* sql`
    WITH x AS (INSERT INTO actor_workflow_executions (routing_key, execution_id, bucket, tenant_id, actor_type, actor_id,
      workflow, workflow_key, manifest_hash, payload, caller, event_cursor, status, started_at_ms)
    SELECT ${routingKey}, ${executionId}, ${bucketOf(routingKey)}, ${ref.tenant}, ${ref.actor}, ${ref.id},
      ${workflow.member.tag}, ${options.key}, ${manifest.hash}, ${compress(options.input)},
      ${yield* encodeCaller(options.caller).pipe(Effect.orDie)},
      COALESCE(${options.after}::bigint, g.event_sequence),
      'running', ${now}
    FROM actor_generations g WHERE ${owner(sql, routingKey, ref)}
    ON CONFLICT DO NOTHING RETURNING 1),
    m AS (INSERT INTO actor_workflow_manifests (actor_type, workflow, manifest_hash, manifest, accepted_at_ms)
      SELECT ${ref.actor}, ${workflow.member.tag}, ${manifest.hash}, ${toJson(manifest.manifest)}::jsonb, 0
      WHERE EXISTS (SELECT 1 FROM x)
      ON CONFLICT DO NOTHING)
    SELECT 1 FROM x`

  if (inserted.length === 0) return false

  const markers = Object.entries(workflow.member.versions)

  if (markers.length > 0)
    yield* sql`INSERT INTO actor_workflow_step ${sql.insert(
      markers.map(([name, range]) => ({
        routing_key: routingKey,
        execution_id: executionId,
        tenant_id: ref.tenant,
        actor_type: ref.actor,
        actor_id: ref.id,
        step: name,
        attempt: 0,
        kind: "version",
        version: range.current,
        started_at_ms: now,
      })),
    )}`

  yield* armTimer(routingKey, ref, executionId, now + RECOVERY_MS, principal(options.caller))

  return true
})

/**
 * The reserved commands a workflow member adds to its owner: the member's own
 * start, a start staged as an intent, the relay's resume, and interrupt.
 *
 * Interrupting a finished or unknown execution changes nothing.
 */
export const workflowCommands = ({
  registration,
  routingKeyOf,
  services,
}: {
  readonly registration: Pick<Registration, "workflows" | "placement">
  readonly routingKeyOf: (ref: ActorRef) => bigint
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto>
}): ReadonlyMap<string, RegisteredCommand> => {
  const commands = new Map<string, RegisteredCommand>()

  const start = (
    request: Request,
    workflow: RegisteredWorkflow,
    input: string,
    key: string,
    after: string | null,
  ) =>
    Effect.gen(function* () {
      const executionId = yield* encodeExecutionId({
        tenant: request.ref.tenant,
        actor: request.ref.actor,
        id: request.ref.id,
        workflow: workflow.member.tag,
        key,
      }).pipe(Effect.orDie)

      yield* insertExecution({
        routingKey: routingKeyOf(request.ref),
        ref: request.ref,
        workflow,
        executionId,
        key,
        input,
        caller: request.caller,
        after,
      })

      return success(yield* encodeExecutionOutput({ value: executionId }).pipe(Effect.orDie))
    }).pipe(Effect.catchIf(SqlError.isSqlError, Effect.die), Effect.provideContext(services))

  for (const workflow of registration.workflows.values())
    commands.set(workflow.member.tag, {
      internal: false,
      handler: false,
      run: (request) =>
        Effect.gen(function* () {
          const key = yield* workflow.key(request.payload, request.commandId)

          return yield* start(request, workflow, request.payload, key, null)
        }),
    })

  if (registration.workflows.size === 0) return commands

  commands.set(START, {
    internal: true,
    handler: false,
    run: (request) =>
      Effect.gen(function* () {
        const payload = yield* decodeStart(request.payload).pipe(Effect.orDie)
        const workflow = registration.workflows.get(payload.workflow)

        if (workflow === undefined)
          return yield* Effect.die(new Error(`Unregistered workflow ${payload.workflow}`))

        return yield* start(request, workflow, payload.input, payload.key, payload.after)
      }),
  })

  commands.set(RESUME, {
    internal: true,
    handler: false,
    run: (request) =>
      decodeTarget(request.payload).pipe(
        Effect.orDie,
        Effect.map(() => success('{"value":null}')),
      ),
  })

  commands.set(INTERRUPT, {
    internal: false,
    handler: false,
    run: (request) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { executionId } = yield* decodeTarget(request.payload).pipe(Effect.orDie)
        const execution = yield* decodeExecutionId(executionId).pipe(Effect.orDie)
        const routingKey = routingKeyOf(request.ref)

        if (
          execution.tenant !== request.ref.tenant ||
          execution.actor !== request.ref.actor ||
          execution.id !== request.ref.id
        )
          return yield* Effect.die(new Error("Execution id names another owner"))

        const [row] = yield* sql<{ caller: string }>`
          UPDATE actor_workflow_executions SET interrupt = true
          WHERE routing_key = ${routingKey} AND execution_id = ${executionId} AND status <> 'finished'
          RETURNING caller`

        if (row !== undefined) {
          const caller = yield* decodeCaller(row.caller).pipe(Effect.orDie)
          yield* armTimer(routingKey, request.ref, executionId, undefined, principal(caller))
        }

        return success('{"value":null}')
      }).pipe(Effect.catchIf(SqlError.isSqlError, Effect.die), Effect.provideContext(services)),
  })

  return commands
}

/** The execution a successful workflow command names, if it names one. */
export const kickedExecution = ({
  request,
  outcome,
}: {
  readonly request: Request
  readonly outcome: Outcome
}) =>
  Effect.gen(function* () {
    if (!Outcome.guards.Success(outcome)) return undefined

    if (request.command === RESUME || request.command === INTERRUPT)
      return {
        executionId: (yield* decodeTarget(request.payload)).executionId,
        interrupt: request.command === INTERRUPT,
      }

    const started = yield* Schema.decodeEffect(ExecutionIdOutput)(outcome.value)

    return { executionId: started.value, interrupt: false }
  }).pipe(Effect.orDie)

interface StepRow {
  readonly step: string
  readonly attempt: number
  readonly kind: string
  readonly exit: Uint8Array | null
  readonly due_at_ms: string | null
  readonly wait_after: string | null
  readonly scanned: string | null
  readonly version: number | null
  readonly started_at_ms: string
}

/** Columns a step row may set when it is first written. */
interface StepFields {
  readonly exit?: Uint8Array
  readonly due_at_ms?: number | null
  readonly wait_event?: string
  readonly wait_after?: bigint
  readonly scanned?: bigint
  readonly version?: number
  readonly settled_at_ms?: number
}

interface ExecutionRow {
  readonly workflow: string
  readonly workflow_key: string
  readonly payload: Uint8Array
  readonly caller: string
  readonly event_cursor: string
  readonly status: string
  readonly interrupt: boolean
  readonly manifest_hash: string
}

const RecordedJson = Schema.fromJsonString(RecordedExit)

const ResultJson = Schema.fromJsonString(StoredResult)

const decodeRecorded = (bytes: Uint8Array) =>
  Schema.decodeEffect(RecordedJson)(decompress(bytes)).pipe(Effect.orDie)

const encodeRecorded = (exit: RecordedExit) => compress(JSON.stringify(exit))

const encodeResult = (result: StoredResult) => compress(JSON.stringify(result))

/** A step row's key in a run's replay map; only activities have attempts past 1. */
const slot = (step: string, attempt: number) => `${attempt}/${step}`

const callIdentity = (executionId: string, step: string, attempt: number, ordinal: number) =>
  JSON.stringify([executionId, step, attempt, ordinal])

/** Decodes a finished execution's stored result. */
export const decodeResult = (bytes: Uint8Array) =>
  Schema.decodeEffect(ResultJson)(decompress(bytes)).pipe(Effect.orDie)

/** Stable 128 bits as a version-4 UUID string, so a derived id passes command-id validation. */
const derivedUuid = (bytes: Uint8Array) => {
  const hex = Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  )

  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * One replay of a live run. It ends when its body records a result, parks, or
 * leaves the execution for another runner, or when the engine interrupts it.
 */
interface Pass {
  /** The body's fiber, a child of the run's loop; absent only until it is forked. */
  body: Fiber.Fiber<unknown, unknown> | undefined
  /** Clocks and waits this pass parked on while another branch still works. */
  readonly parked: Set<string>
  /** Activity, clock, and wait steps of the pass still working, not parked. */
  working: number
  /** Open exactly while no step works, so a parking step waits for the signal instead of polling. */
  readonly idle: Latch.Latch
}

/**
 * An execution this activation is running now: its current pass, if one runs,
 * and what the run does once that pass ends. `end` stops the run; `wake`
 * replays it unless the pass left the execution for another runner; `preempt`
 * replays it because the engine stopped the pass itself.
 */
interface LiveRun {
  pass: Pass | undefined
  next: "end" | "wake" | "preempt"
}

/**
 * Runs one activation's workflow executions. Postgres holds every step; the
 * live fibers here only save a replay. Each write is a short transaction that
 * first checks the activation still holds the owner's generation.
 *
 * Compatibility: a runner leaves an execution for a compatible one when it lacks
 * the workflow, its markers exclude the execution's, it lacks a recorded step or a
 * step of the start manifest, or it would decode a recorded result or the input
 * differently. Once this runner's result schemas apply to the steps still to
 * settle, its manifest becomes the execution's start manifest; a `newer` manifest
 * is one accepted after this runner's own, as when a newer deployment starts
 * executions while this runner still serves.
 *
 * Replay: an interrupted execution replays to its first unsettled step and stops
 * there, so the compensation finalizers of completed steps run before the
 * interrupt is recorded. A replay of a parked execution counts as running until it parks or
 * finishes, so inspection never reports a working run as suspended. A wake that
 * arrived during a pass replays the run once more unless the pass left the
 * execution for another runner or lost its generation, and a pass the engine
 * stopped to replay always replays. A parking step waits, on the pass's idle
 * signal, until every other step of the pass has parked or finished: a parked branch would
 * otherwise interrupt concurrent branches mid-step, losing a sibling's clock, wait
 * or activity work and possibly replaying forever. A race branch parked on a clock
 * or wait that can now settle stops the run so its replay settles it, and a
 * running sibling activity reruns under the same attempt. The relay consumed the
 * recovery timer, so a still-running activity needs another.
 *
 * Steps: only the caller and tenant are inherited from the activation, because
 * steps run inside the body's fiber whose caller and tenant are the execution's
 * recorded ones. Effect's workflow instance names a workflow, and compensation
 * never reads more of it. Rows are keyed by step and attempt, so each
 * `Activity.retry` attempt is its own row with its own exit. The pending row is
 * committed before an activity runs, so a rerun after a crash reuses its attempt
 * and derived ids. A clock's due time is recorded once, so a replay never moves it.
 * Step writes run inside the body's fiber, where a failed statement is a defect
 * and the timer resumes. A wait's `where` runs outside any lock, and the fenced
 * conditional settle makes a racing timeout or second run settle once. Holding the
 * generation lock, a suspend finds any event committed after a wait's scan, so its
 * wake survives.
 *
 * Compensation: `Workflow.withCompensation` and `Workflow.addFinalizer` register
 * on the run's instance scope. Only a run that records a result closes it, and a
 * replay registers them again, so they run once per execution.
 */
export const activationEngine = (options: {
  readonly registration: Registration
  readonly ref: ActorRef
  readonly routingKey: bigint
  readonly cache: ActivationCache
  readonly scope: Scope.Scope
  readonly deliveryMs: number
}) =>
  Effect.gen(function* () {
    const { registration, ref, routingKey, cache, scope } = options
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto
    const { retryWindowMs } = yield* OutboxRuntime

    const services = Context.pick(
      SqlClient.SqlClient,
      Crypto.Crypto,
    )(yield* Effect.context<SqlClient.SqlClient | Crypto.Crypto>())

    const ownerRow = owner(sql, routingKey, ref)

    const instanceWorkflows = new Map<string, EffectWorkflow.Any>()

    const instanceWorkflow = (tag: string) => {
      let found = instanceWorkflows.get(tag)

      if (found === undefined) {
        found = EffectWorkflow.make(tag, { payload: {}, idempotencyKey: () => tag })
        instanceWorkflows.set(tag, found)
      }

      return found
    }

    const live = new Map<string, LiveRun>()

    const fenced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ generation: string }>`
            SELECT generation::text AS generation FROM actor_generations WHERE ${ownerRow} FOR UPDATE`

          if (row === undefined || row.generation !== cache.generation)
            return yield* Effect.die(new StaleRun())

          return yield* effect
        }),
      )

    const now = databaseTime

    const startManifests = new Map<
      string,
      { readonly covered: boolean; readonly changed: ReadonlyArray<string> }
    >()

    const coversStartManifest = (
      workflow: RegisteredWorkflow,
      hash: string,
      settled: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        const own = yield* manifestOf(ref.actor, workflow.member)

        if (hash === own.hash) return true
        let known = startManifests.get(hash)

        if (known === undefined) {
          const [row] = yield* sql<{ manifest: string; newer: boolean }>`
            SELECT m.manifest::text AS manifest, m.accepted_at_ms > COALESCE((SELECT o.accepted_at_ms
              FROM actor_workflow_manifests o WHERE o.actor_type = m.actor_type AND o.workflow = m.workflow
                AND o.manifest_hash = ${own.hash}), -1) AS newer
            FROM actor_workflow_manifests m
            WHERE m.actor_type = ${ref.actor} AND m.workflow = ${workflow.member.tag}
              AND m.manifest_hash = ${hash}`

          if (row === undefined) known = { covered: false, changed: [] }
          else {
            const stored = yield* decodeStoredManifest(row.manifest).pipe(Effect.orDie)

            const changed = changedSteps({
              stored,
              steps: new Map(own.manifest.steps.map((step) => [step.name, step])),
            })

            known = {
              covered:
                missingSteps({ stored, steps: workflow.steps }).length === 0 &&
                stored.input === own.manifest.input &&
                (!row.newer || changed.length === 0),
              changed,
            }
          }

          startManifests.set(hash, known)
        }

        return known.covered && known.changed.every((name) => !settled.has(name))
      })

    /** An execution's recorded steps by slot, its version markers, and the steps that settled. */
    const readSteps = (executionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<StepRow>`
          SELECT step, attempt, kind, exit, due_at_ms::text AS due_at_ms, wait_after::text AS wait_after,
            scanned::text AS scanned, version, started_at_ms::text AS started_at_ms
          FROM actor_workflow_step
          WHERE routing_key = ${routingKey} AND execution_id = ${executionId}
          ORDER BY step, attempt`

        const steps = new Map<string, StepRow>()
        const markers = new Map<string, number>()
        const settledSteps = new Set<string>()

        for (const row of rows)
          if (row.kind === "version") markers.set(row.step, row.version!)
          else {
            steps.set(slot(row.step, row.attempt), row)

            if (row.exit !== null) settledSteps.add(row.step)
          }

        return { steps, markers, settledSteps }
      })

    /**
     * Whether this runner can replay an execution: its start manifest is
     * covered, its markers are within range and all known, and every recorded
     * step is registered with the same kind.
     */
    const replayable = (
      workflow: RegisteredWorkflow,
      execution: ExecutionRow,
      recorded: Effect.Success<ReturnType<typeof readSteps>>,
    ) =>
      Effect.map(
        coversStartManifest(workflow, execution.manifest_hash, recorded.settledSteps),
        (covered) =>
          covered &&
          Object.entries(workflow.member.versions).every(([name, range]) => {
            const value = recorded.markers.get(name) ?? 0

            return value >= range.min && value <= range.current
          }) &&
          [...recorded.markers.keys()].every(
            (name) => workflow.member.versions[name] !== undefined,
          ) &&
          [...recorded.steps.values()].every(
            (row) => workflow.steps.get(row.step)?.kind === row.kind,
          ),
      )

    /**
     * Moves an execution started under an older manifest whose steps changed
     * onto this runner's manifest, recording that manifest if it is new.
     */
    const adoptManifest = (
      workflow: RegisteredWorkflow,
      execution: ExecutionRow,
      executionId: string,
    ) =>
      Effect.gen(function* () {
        const own = yield* manifestOf(ref.actor, workflow.member)

        if (
          execution.manifest_hash !== own.hash &&
          (startManifests.get(execution.manifest_hash)?.changed.length ?? 0) > 0
        ) {
          yield* fenced(sql`
            WITH m AS (INSERT INTO actor_workflow_manifests
                (actor_type, workflow, manifest_hash, manifest, accepted_at_ms)
              VALUES (${ref.actor}, ${workflow.member.tag}, ${own.hash}, ${toJson(own.manifest)}::jsonb, 0)
              ON CONFLICT DO NOTHING)
            UPDATE actor_workflow_executions SET manifest_hash = ${own.hash}
            WHERE routing_key = ${routingKey} AND execution_id = ${executionId}
              AND manifest_hash = ${execution.manifest_hash}`)
        }
      })

    /** Records an execution's result, then drops its steps and its timer. */
    const finish = (executionId: string, result: StoredResult) =>
      fenced(
        Effect.gen(function* () {
          const at = yield* now

          const done = yield* sql`
            UPDATE actor_workflow_executions SET status = 'finished', result = ${encodeResult(result)},
              finished_at_ms = ${at}
            WHERE routing_key = ${routingKey} AND execution_id = ${executionId} AND status <> 'finished'
            RETURNING 1`

          if (done.length === 0) return
          yield* sql`DELETE FROM actor_workflow_step
            WHERE routing_key = ${routingKey} AND execution_id = ${executionId}`
          yield* deleteTimer(sql, routingKey, ref, executionId)
        }),
      ).pipe(Effect.as("finished" as const))

    /**
     * The step primitives one run of an execution records through: each step
     * replays its recorded exit, or records a new one in a fenced write.
     */
    const executionSteps = ({
      executionId,
      workflow,
      steps,
      pass,
      interrupting,
      eventCursor,
      onBehalfOf,
    }: {
      readonly executionId: string
      readonly workflow: RegisteredWorkflow
      readonly steps: Map<string, StepRow>
      readonly pass: Pass
      readonly interrupting: boolean
      readonly eventCursor: { value: bigint }
      readonly onBehalfOf: ReturnType<typeof principal>
    }): WorkflowSteps => {
      const registered = (step: StepIdentity) =>
        step.workflow === workflow.member.tag && workflow.steps.get(step.name)?.kind === step.kind
          ? Effect.void
          : Effect.die(new Error(`Unregistered workflow step ${step.name}`))

      const recordedOf = (step: StepIdentity, attempt = 1) => {
        const row = steps.get(slot(step.name, attempt))

        if (row !== undefined && row.kind !== step.kind)
          return Effect.die(new Error(`Step ${step.name} was recorded as a ${row.kind}`))

        return Effect.succeed(row)
      }

      const insertStep = (step: StepIdentity, fields: StepFields, at: number, attempt = 1) =>
        sql`INSERT INTO actor_workflow_step ${sql.insert({
          routing_key: routingKey,
          execution_id: executionId,
          tenant_id: ref.tenant,
          actor_type: ref.actor,
          actor_id: ref.id,
          step: step.name,
          attempt,
          kind: step.kind,
          started_at_ms: at,
          ...fields,
        })}`

      const settle = (
        step: StepIdentity,
        exit: RecordedExit,
        at: number,
        extra?: { readonly matched?: bigint; readonly attempt?: number },
      ) =>
        sql<{ exit: Uint8Array }>`
          UPDATE actor_workflow_step SET exit = ${encodeRecorded(exit)}, settled_at_ms = ${at},
            matched = ${extra?.matched ?? null}
          WHERE routing_key = ${routingKey} AND execution_id = ${executionId} AND step = ${step.name}
            AND attempt = ${extra?.attempt ?? 1} AND exit IS NULL
          RETURNING exit`

      const readExit = (step: StepIdentity, attempt = 1) =>
        sql<{ exit: Uint8Array | null }>`
          SELECT exit FROM actor_workflow_step WHERE routing_key = ${routingKey}
            AND execution_id = ${executionId} AND step = ${step.name} AND attempt = ${attempt}`.pipe(
          Effect.map((found) => found[0]?.exit ?? null),
        )

      const remember = (step: StepIdentity, row: Partial<StepRow>, attempt = 1) =>
        steps.set(slot(step.name, attempt), {
          step: step.name,
          attempt,
          kind: step.kind,
          exit: null,
          due_at_ms: null,
          wait_after: null,
          scanned: null,
          version: null,
          started_at_ms: "0",
          ...steps.get(slot(step.name, attempt)),
          ...row,
        })

      const shift = (delta: 1 | -1) =>
        Effect.sync(() => {
          pass.working += delta

          if (pass.working === 0) pass.idle.openUnsafe()
          else pass.idle.closeUnsafe()
        })

      const working = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          shift(1),
          () => effect,
          () => shift(-1),
        )

      /**
       * Waits until no other step of the pass works. A step that just ended gets
       * one scheduling turn to start its branch's next step before the pass
       * counts as quiet.
       */
      const quiet: Effect.Effect<void> = Effect.gen(function* () {
        for (;;) {
          yield* pass.idle.await
          yield* Effect.yieldNow

          if (pass.working === 0) return
        }
      })

      const suspend = Effect.acquireUseRelease(
        shift(-1),
        () => quiet,
        () => shift(1),
      ).pipe(Effect.andThen(Effect.die(new Suspend())))

      const guarded = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
        effect.pipe(Effect.orDie, Effect.provideContext(services))

      return {
        activity: (step, run) =>
          Effect.gen(function* () {
            yield* registered(step)
            const attempt = yield* Activity.CurrentAttempt
            let row = yield* recordedOf(step, attempt)

            if (row?.exit !== null && row?.exit !== undefined)
              return yield* decodeRecorded(row.exit)

            if (interrupting) return yield* Effect.interrupt

            if (row === undefined) {
              const at = yield* now
              yield* fenced(
                Effect.gen(function* () {
                  yield* insertStep(step, {}, at, attempt)
                  yield* armTimer(routingKey, ref, executionId, at + RECOVERY_MS, onBehalfOf)
                }),
              )
              remember(step, { started_at_ms: String(at) }, attempt)
              row = steps.get(slot(step.name, attempt))!
            }

            const issuedAt = Number(row.started_at_ms)
            const expiresAt = issuedAt + retryWindowMs
            let ordinal = 0

            const nextCommandId = Effect.gen(function* () {
              ordinal += 1

              if ((yield* now) + options.deliveryMs >= expiresAt)
                return yield* Effect.die(
                  ActivityOutcomeUnknown.make({ executionId, step: step.name }),
                )

              const digest = yield* crypto
                .digest(
                  "SHA-256",
                  new TextEncoder().encode(
                    callIdentity(executionId, step.name, row!.attempt, ordinal),
                  ),
                )
                .pipe(Effect.orDie)

              return `v1.${issuedAt}.${expiresAt}.${derivedUuid(digest)}`
            }).pipe(
              Effect.catchIf(SqlError.isSqlError, Effect.die),
              Effect.provideContext(services),
            )

            const exit = yield* run.pipe(
              Effect.provideService(CurrentCallPhase, CallPhase.Activity({ nextCommandId })),
            )

            const at = yield* now
            const settled = yield* fenced(settle(step, exit, at, { attempt }))
            const recorded = settled[0]?.exit ?? (yield* readExit(step, attempt))

            if (recorded === null) return yield* Effect.die(new Error("Activity exit missing"))
            remember(step, { exit: recorded }, attempt)

            return yield* decodeRecorded(recorded)
          }).pipe(working, guarded),

        sleep: (step, millis) =>
          Effect.gen(function* () {
            yield* registered(step)
            const row = yield* recordedOf(step)

            if (row?.exit !== null && row?.exit !== undefined) return

            if (interrupting) return yield* Effect.interrupt

            const at = yield* now
            let dueAt: number

            if (row === undefined) {
              dueAt = at + millis
              yield* fenced(insertStep(step, { due_at_ms: dueAt }, at))
              remember(step, { due_at_ms: String(dueAt), started_at_ms: String(at) })
            } else dueAt = Number(row.due_at_ms)

            if (at < dueAt) {
              pass.parked.add(step.name)

              return yield* suspend
            }

            yield* fenced(settle(step, RecordedExit.cases.Success.make({ value: null }), at))
            remember(step, {
              exit: encodeRecorded(RecordedExit.cases.Success.make({ value: null })),
            })
          }).pipe(working, guarded),

        wait: (step, event, matches, timeoutMs) =>
          Effect.gen(function* () {
            yield* registered(step)
            let row = yield* recordedOf(step)

            const settledValue = (exit: Uint8Array) =>
              decodeRecorded(exit).pipe(
                Effect.flatMap((recorded) =>
                  Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))(
                    RecordedExit.guards.Success(recorded) ? recorded.value : null,
                  ).pipe(Effect.orDie),
                ),
                Effect.map(Option.fromNullOr),
              )

            if (row?.exit !== null && row?.exit !== undefined) return yield* settledValue(row.exit)

            if (interrupting) return yield* Effect.interrupt

            if (row === undefined) {
              const at = yield* now
              const dueAt = timeoutMs === undefined ? null : at + timeoutMs
              const after = eventCursor.value
              yield* fenced(
                insertStep(
                  step,
                  { wait_event: event, wait_after: after, scanned: after, due_at_ms: dueAt },
                  at,
                ),
              )
              remember(step, {
                wait_after: String(after),
                scanned: String(after),
                due_at_ms: dueAt === null ? null : String(dueAt),
                started_at_ms: String(at),
              })
              row = steps.get(slot(step.name, 1))!
            }

            let scanned = BigInt(row.scanned!)

            for (;;) {
              const page = yield* sql<{
                sequence: string
                value: Uint8Array
                payload_version: number
              }>`
            SELECT sequence::text AS sequence, value, payload_version FROM actor_events
            WHERE ${ownerRow} AND event = ${event} AND sequence > ${scanned}
            ORDER BY sequence LIMIT 256`

              for (const found of page) {
                const matched = yield* matches(decompress(found.value), found.payload_version)

                if (Option.isNone(matched)) continue
                const value = matched.value
                const at = yield* now
                const sequence = BigInt(found.sequence)
                const exit = RecordedExit.cases.Success.make({ value })

                const settled = yield* fenced(
                  Effect.gen(function* () {
                    const done = yield* settle(step, exit, at, { matched: sequence })

                    if (done.length > 0)
                      yield* sql`UPDATE actor_workflow_executions SET event_cursor = GREATEST(event_cursor, ${sequence})
                    WHERE routing_key = ${routingKey} AND execution_id = ${executionId}`

                    return done
                  }),
                )

                if (settled.length > 0 && sequence > eventCursor.value) eventCursor.value = sequence
                const recorded = settled[0]?.exit ?? (yield* readExit(step))
                remember(step, { exit: recorded })

                return yield* settledValue(recorded!)
              }

              if (page.length < 256) {
                if (page.length > 0) scanned = BigInt(page[page.length - 1]!.sequence)

                break
              }

              scanned = BigInt(page[page.length - 1]!.sequence)
            }

            const at = yield* now

            if (row.due_at_ms !== null && at >= Number(row.due_at_ms)) {
              const settled = yield* fenced(
                settle(step, RecordedExit.cases.Success.make({ value: null }), at),
              )

              const recorded = settled[0]?.exit ?? (yield* readExit(step))
              remember(step, { exit: recorded })

              return yield* settledValue(recorded!)
            }

            if (scanned > BigInt(row.scanned!)) {
              yield* fenced(sql`UPDATE actor_workflow_step SET scanned = ${scanned}
            WHERE routing_key = ${routingKey} AND execution_id = ${executionId}
              AND step = ${step.name} AND attempt = 1 AND exit IS NULL AND scanned < ${scanned}`)
              remember(step, { scanned: String(scanned) })
            }

            pass.parked.add(step.name)

            return yield* suspend
          }).pipe(working, guarded),

        race: (step, run) =>
          guarded(
            Effect.gen(function* () {
              yield* registered(step)
              const row = yield* recordedOf(step)

              if (row?.exit !== null && row?.exit !== undefined)
                return yield* decodeRecorded(row.exit)

              if (interrupting) return yield* Effect.interrupt

              const exit = yield* run
              const at = yield* now
              yield* fenced(
                insertStep(step, { exit: encodeRecorded(exit), settled_at_ms: at }, at).pipe(
                  Effect.catchIf(SqlError.isSqlError, Effect.die),
                ),
              )
              remember(step, { exit: encodeRecorded(exit) })

              return exit
            }),
          ),
      }
    }

    /**
     * Marks a run that suspended as suspended, and re-arms its timer: at once
     * when an event it waits on arrived after its scan, at its earliest due
     * step otherwise, or not at all when nothing is due.
     */
    const park = (executionId: string, onBehalfOf: ReturnType<typeof principal>) =>
      Effect.gen(function* () {
        yield* (yield* TurnHooks).at(
          "beforeWorkflowSuspend",
          Request.make({
            ref,
            caller: System.make({ source: "workflow", ref }),
            command: RESUME,
            commandId: "",
            payload: executionId,
          }),
        )
        yield* fenced(
          Effect.gen(function* () {
            const [due] = yield* sql<{ due: string | null }>`
              SELECT min(due_at_ms)::text AS due FROM actor_workflow_step
              WHERE routing_key = ${routingKey} AND execution_id = ${executionId}
                AND exit IS NULL AND due_at_ms IS NOT NULL`

            yield* sql`UPDATE actor_workflow_executions SET status = 'suspended'
              WHERE routing_key = ${routingKey} AND execution_id = ${executionId} AND status = 'running'`

            const [unseen] = yield* sql<{ found: boolean }>`
              SELECT EXISTS (
                SELECT 1 FROM actor_workflow_step s
                JOIN actor_events e ON e.routing_key = s.routing_key AND e.tenant_id = s.tenant_id
                  AND e.actor_type = s.actor_type AND e.actor_id = s.actor_id
                  AND e.event = s.wait_event AND e.sequence > s.scanned
                WHERE s.routing_key = ${routingKey} AND s.execution_id = ${executionId}
                  AND s.kind = 'wait' AND s.exit IS NULL
              ) AS found`

            if (unseen?.found === true)
              yield* armTimer(routingKey, ref, executionId, undefined, onBehalfOf)
            else if (due?.due === null || due === undefined)
              yield* deleteTimer(sql, routingKey, ref, executionId)
            else yield* armTimer(routingKey, ref, executionId, Number(due.due), onBehalfOf)
          }),
        )
      })

    /**
     * Runs one pass of an execution: replays it against this runner's workflow,
     * then records its result, parks it, or leaves it for a compatible runner.
     */
    const runOnce = (executionId: string, pass: Pass) =>
      Effect.gen(function* () {
        const [execution] = yield* sql<ExecutionRow>`
          SELECT workflow, workflow_key, payload, caller, event_cursor::text AS event_cursor, status, interrupt,
            manifest_hash
          FROM actor_workflow_executions
          WHERE routing_key = ${routingKey} AND execution_id = ${executionId}`

        if (execution === undefined || execution.status === "finished") return "finished" as const

        const caller = yield* decodeCaller(execution.caller).pipe(Effect.orDie)
        const onBehalfOf = principal(caller)

        const interrupting = execution.interrupt
        const workflow = registration.workflows.get(execution.workflow)

        const recorded = yield* readSteps(executionId)

        if (workflow === undefined || !(yield* replayable(workflow, execution, recorded))) {
          yield* Effect.logWarning(
            "Workflow execution incompatible with this runner; suspended",
          ).pipe(Effect.annotateLogs({ executionId }))
          yield* fenced(
            armTimer(routingKey, ref, executionId, (yield* now) + RECOVERY_MS, onBehalfOf),
          )

          return "abandoned" as const
        }

        yield* adoptManifest(workflow, execution, executionId)

        if (execution.status === "suspended")
          yield* fenced(sql`UPDATE actor_workflow_executions SET status = 'running'
            WHERE routing_key = ${routingKey} AND execution_id = ${executionId}
              AND status = 'suspended'`)

        const engine = executionSteps({
          executionId,
          workflow,
          steps: recorded.steps,
          pass,
          interrupting,
          eventCursor: { value: BigInt(execution.event_cursor) },
          onBehalfOf,
        })

        const instance = WorkflowEngine.WorkflowInstance.initial(
          instanceWorkflow(workflow.member.tag),
          executionId,
        )

        const exit = yield* workflow
          .run(decompress(execution.payload), {
            id: ref.id,
            ref,
            principal: onBehalfOf,
            executionId,
            key: execution.workflow_key,
            version: (name) => Effect.succeed(recorded.markers.get(name) ?? 0),
          })
          .pipe(
            Effect.provideService(CurrentWorkflow, engine),
            Effect.provideService(CurrentCallPhase, CallPhase.Body()),
            Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
            Effect.scoped,
          )

        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)

        if (Exit.isFailure(exit)) {
          if (stale(exit.cause) || (interrupted && !interrupting)) return "abandoned" as const

          if (suspended(exit.cause)) {
            yield* park(executionId, onBehalfOf)

            return "suspended" as const
          }
        }

        if (interrupted) {
          yield* Scope.close(instance.scope, Exit.interrupt())

          return yield* finish(executionId, StoredResult.cases.Interrupt.make({}))
        }

        yield* Scope.close(instance.scope, exit)

        return yield* finish(executionId, yield* workflow.encodeExit(exit))
      }).pipe(
        Effect.catchCause((cause) =>
          stale(cause) || Cause.hasInterruptsOnly(cause)
            ? Effect.succeed("abandoned" as const)
            : Effect.logWarning("Workflow run failed; its timer resumes it", cause).pipe(
                Effect.as("abandoned" as const),
              ),
        ),
        Effect.annotateLogs({ actor: ref.actor, tenant: ref.tenant, id: ref.id, executionId }),
      )

    /**
     * Replays the run pass by pass until a pass ends with nothing asking for
     * another. The decision to stop and the run's removal happen in one step, so
     * a kick either reaches this run or starts a new one.
     */
    const loop = (executionId: string, run: LiveRun) =>
      Effect.gen(function* () {
        for (;;) {
          const pass: Pass = {
            body: undefined,
            parked: new Set(),
            working: 0,
            idle: Latch.makeUnsafe(true),
          }

          run.pass = pass
          const body = yield* Effect.forkChild(runOnce(executionId, pass))
          pass.body = body
          const outcome = yield* Fiber.join(body).pipe(Effect.exit)

          const again = yield* Effect.sync(() => {
            const left = Exit.isSuccess(outcome) && outcome.value === "abandoned"
            const replay = run.next === "preempt" || (run.next === "wake" && !left)
            run.pass = undefined
            run.next = "end"

            if (!replay) live.delete(executionId)

            return replay
          })

          if (!again) return
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (live.get(executionId) === run) live.delete(executionId)
          }),
        ),
      )

    const settleable = (executionId: string, parked: ReadonlySet<string>) =>
      parked.size === 0
        ? Effect.succeed(false)
        : Effect.gen(function* () {
            const at = yield* now

            const [found] = yield* sql<{ found: boolean }>`
              SELECT EXISTS (
                SELECT 1 FROM actor_workflow_step s
                WHERE s.routing_key = ${routingKey} AND s.execution_id = ${executionId}
                  AND s.step IN ${sql.in([...parked])} AND s.exit IS NULL
                  AND (s.due_at_ms <= ${at}
                    OR (s.kind = 'wait' AND EXISTS (
                      SELECT 1 FROM actor_events e
                      WHERE e.routing_key = s.routing_key AND e.tenant_id = s.tenant_id
                        AND e.actor_type = s.actor_type AND e.actor_id = s.actor_id
                        AND e.event = s.wait_event AND e.sequence > s.scanned)))
              ) AS found`

            return found?.found === true
          }).pipe(Effect.orElseSucceed(() => false))

    /**
     * Runs or replays an execution after a committed workflow command. A live
     * run replays once more after it suspends; an interrupt stops it first.
     */
    const kick = (executionId: string, interrupt: boolean) =>
      Effect.gen(function* () {
        const current = live.get(executionId)

        if (current === undefined) {
          const run: LiveRun = { pass: undefined, next: "end" }
          live.set(executionId, run)
          yield* loop(executionId, run).pipe(Effect.forkIn(scope))

          return
        }

        const pass = current.pass

        if (current.next === "end") current.next = "wake"

        if (pass?.body === undefined) return

        if (interrupt || (yield* settleable(executionId, pass.parked))) {
          if (current.pass !== pass) return
          current.next = "preempt"
          yield* Fiber.interrupt(pass.body).pipe(Effect.forkIn(scope))
        }

        if (pass.working > 0)
          yield* fenced(
            Effect.gen(function* () {
              const [row] = yield* sql<{
                caller: string
              }>`SELECT caller FROM actor_workflow_executions
                WHERE routing_key = ${routingKey} AND execution_id = ${executionId}`

              if (row === undefined) return
              const caller = yield* decodeCaller(row.caller).pipe(Effect.orDie)
              yield* armTimer(
                routingKey,
                ref,
                executionId,
                (yield* now) + RECOVERY_MS,
                principal(caller),
              )
            }),
          ).pipe(Effect.ignoreCause)
      }).pipe(Effect.provideContext(services))

    return { kick, live: () => live.size }
  })

/**
 * Re-arms the resume timer of every execution with a pending wait for one of
 * `tags`, inside the emitting turn. The turn holds the owner's generation
 * lock, which a wait's registration also takes, so no event is missed.
 */
export const notifyWaits = Effect.fnUntraced(function* (
  routingKey: bigint,
  ref: ActorRef,
  tags: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient

  const waiting = yield* sql<{ execution_id: string; caller: string }>`
    SELECT DISTINCT s.execution_id, x.caller FROM actor_workflow_step s
    JOIN actor_workflow_executions x ON x.routing_key = s.routing_key AND x.execution_id = s.execution_id
    WHERE s.routing_key = ${routingKey} AND s.tenant_id = ${ref.tenant} AND s.actor_type = ${ref.actor}
      AND s.actor_id = ${ref.id} AND s.kind = 'wait' AND s.exit IS NULL AND s.wait_event IN ${sql.in(tags)}`

  for (const row of waiting) {
    const caller = yield* decodeCaller(row.caller).pipe(Effect.orDie)
    yield* armTimer(routingKey, ref, row.execution_id, undefined, principal(caller))
  }

  return waiting.length > 0
})
