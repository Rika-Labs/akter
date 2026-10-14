/**
 * @license MIT
 * Copyright (c) 2023 Effectful Technologies Inc
 * Adapted workflow runtime behavior; the permission notice is retained in NOTICE.
 */
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Latch,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  Scope,
} from "effect"
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow"
import type { Decoded } from "./layout.ts"
import type { MemberSchema } from "../contract/members.ts"

const { WorkflowInstance } = WorkflowEngine
type Instance = WorkflowEngine.WorkflowInstance["Service"]
type Output<Discard extends boolean> = Discard extends true
  ? void
  : Workflow.Result<unknown, unknown>

/** Validates persisted encoded records before they enter Effect's workflow boundary. */
export const WorkflowRecord = Schema.Union([
  Schema.TaggedStruct("JobStarted", {
    workflow: Schema.String,
    executionId: Schema.String,
    payload: Schema.Json,
    parent: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("ActivityCompleted", {
    executionId: Schema.String,
    key: Schema.String,
    exit: Schema.Json,
  }),
  Schema.TaggedStruct("DeferredCompleted", {
    workflow: Schema.String,
    executionId: Schema.String,
    name: Schema.String,
    exit: Schema.Json,
  }),
  Schema.TaggedStruct("ClockScheduled", {
    workflow: Schema.String,
    executionId: Schema.String,
    name: Schema.String,
    deferredName: Schema.String,
    wakeAt: Schema.Finite,
  }),
  Schema.TaggedStruct("JobCompleted", { executionId: Schema.String, result: Schema.Json }),
  Schema.TaggedStruct("JobInterrupted", { executionId: Schema.String, unsafe: Schema.Boolean }),
]).pipe(Schema.toTaggedUnion("_tag"))

/** A JSON-encoded record at Effect's workflow engine boundary. */
export type JobEntry = typeof WorkflowRecord.Type

/** Normalizes optional values in Effect's encoded exits before they enter a JSON-only log. */
export const workflowJson = (value: Decoded): Schema.Json =>
  Result.getOrThrow(
    Schema.decodeResult(Schema.fromJsonString(Schema.Json))(
      Result.getOrThrow(Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(value)),
    ),
  )

/** The stored deadlines a stopped shard must report, excluding clocks already completed. */
export const pendingClocks = (entries: ReadonlyArray<Schema.Json>): ReadonlyArray<number> => {
  const decoded = entries.map((entry) =>
    Result.getOrThrow(Schema.decodeUnknownResult(WorkflowRecord)(entry)),
  )
  const completed = new Set(
    decoded.flatMap((entry) =>
      WorkflowRecord.guards.DeferredCompleted(entry) ? [entry.name] : [],
    ),
  )
  return decoded.flatMap((entry) =>
    WorkflowRecord.guards.ClockScheduled(entry) && !completed.has(entry.deferredName)
      ? [entry.wakeAt]
      : [],
  )
}

/** The owning shard's fenced journal, supplied afresh on every owner generation. */
export class WorkflowJournal extends Context.Service<
  WorkflowJournal,
  {
    readonly entries: () => ReadonlyArray<JobEntry>
    readonly append: (entry: JobEntry) => Effect.Effect<void>
  }
>()("@rikalabs/akter/execution/workflow/WorkflowJournal") {}

/** Abandons runs before the shard scope closes, without executing workflow finalizers. */
export class WorkflowControl extends Context.Service<
  WorkflowControl,
  {
    readonly crash: Effect.Effect<void>
  }
>()("@rikalabs/akter/execution/workflow/WorkflowControl") {}

const ActivityExitJson = Schema.toCodecJson(Schema.Exit(Schema.Any, Schema.Any, Schema.Defect()))
const DeferredExitJson = Schema.toCodecJson(Schema.Exit(Schema.Any, Schema.Any, Schema.Any))

const resultCodec = (workflow: Workflow.Any) =>
  Schema.toCodecJson(
    Workflow.Result({
      success: workflow.successSchema as MemberSchema,
      error: workflow.errorSchema as MemberSchema,
    }),
  )

const payloadCodec = (workflow: Workflow.Any) =>
  Schema.toCodecJson(workflow.payloadSchema as Workflow.AnyStructSchema & MemberSchema)

type Registration = {
  readonly workflow: Workflow.Any
  readonly execute: Parameters<WorkflowEngine.Encoded["register"]>[1]
  readonly scope: Scope.Scope
}

type ExecutionState = {
  readonly workflowTag: string
  readonly payloadEncoded: Schema.Json
  readonly parent: string | undefined
  payload: object | undefined
  instance: Instance | undefined
  scope: Scope.Closeable
  interrupted: boolean
  resumeRequested: boolean
  fiber: Fiber.Fiber<Workflow.Result<unknown, unknown>> | undefined
  completed: Schema.Json | undefined
}

/**
 * Builds a `WorkflowEngine` whose executions, activity results, durable clocks
 * and deferred completions are entries on a shard log, and rebuilds them by
 * replaying that log when it starts. Run semantics follow
 * `WorkflowEngine.layerMemory` so Effect's own engine tests apply unchanged.
 */
export const make = Effect.gen(function* () {
  const scope = yield* Effect.scope
  const log = yield* WorkflowJournal
  let crashed = false

  const workflows = new Map<string, Registration>()
  const registered = new Map<string, Latch.Latch>()
  const registeredLatch = (tag: string) => {
    let latch = registered.get(tag)
    if (latch === undefined) {
      latch = Latch.makeUnsafe(false)
      registered.set(tag, latch)
    }
    return latch
  }
  const executions = new Map<string, ExecutionState>()
  const activities = new Map<
    string,
    { exit: Exit.Exit<Workflow.Result<unknown, unknown>> | undefined }
  >()
  const durableActivities = new Map<string, Schema.Json>()
  const deferredResults = new Map<string, Schema.Json>()
  const scheduledClocks = new Map<string, Extract<JobEntry, { _tag: "ClockScheduled" }>>()
  const deferredState = WorkflowEngine.makeDeferredState()
  const clocks = yield* FiberMap.make<string>()
  const executionFibers = yield* FiberMap.make<string, Workflow.Result<unknown, unknown>>()

  const newExecution = (entry: Extract<JobEntry, { _tag: "JobStarted" }>): ExecutionState => ({
    workflowTag: entry.workflow,
    payloadEncoded: entry.payload,
    parent: entry.parent,
    payload: undefined,
    instance: undefined,
    scope: Scope.makeUnsafe(),
    interrupted: false,
    resumeRequested: false,
    fiber: undefined,
    completed: undefined,
  })

  for (const entry of log.entries())
    WorkflowRecord.match(entry, {
      JobStarted: (entry) => {
        executions.set(entry.executionId, newExecution(entry))
      },
      ActivityCompleted: (entry) => {
        durableActivities.set(entry.key, entry.exit)
      },
      DeferredCompleted: (entry) => {
        deferredResults.set(`${entry.executionId}/${entry.name}`, entry.exit)
      },
      ClockScheduled: (entry) => {
        scheduledClocks.set(`${entry.executionId}/${entry.name}`, entry)
      },
      JobCompleted: (entry) => {
        const state = executions.get(entry.executionId)
        if (state !== undefined) state.completed = entry.result
      },
      JobInterrupted: (entry) => {
        const state = executions.get(entry.executionId)
        if (state !== undefined) state.interrupted = true
      },
    })

  const decodeCompleted = (workflow: Workflow.Any, encoded: Schema.Json) =>
    Effect.orDie(Schema.decodeEffect(resultCodec(workflow))(encoded)) as Effect.Effect<
      Workflow.Result<unknown, unknown>
    >

  const resume = Effect.fnUntraced(function* (executionId: string): Effect.fn.Return<void> {
    const state = executions.get(executionId)
    if (state === undefined || crashed || state.completed !== undefined) return
    const entry = workflows.get(state.workflowTag)
    if (entry === undefined) return
    const exit = state.fiber?.pollUnsafe()
    if (
      exit !== undefined &&
      Predicate.isTagged(exit, "Success") &&
      Predicate.isTagged(exit.value, "Complete")
    ) {
      return
    } else if (state.fiber !== undefined && exit === undefined) {
      if (!state.resumeRequested) {
        state.resumeRequested = true
        yield* Fiber.await(state.fiber).pipe(
          Effect.flatMap(() => {
            state.resumeRequested = false
            return resume(executionId)
          }),
          Effect.forkIn(scope),
        )
      }
      return
    }
    if (state.payload === undefined) {
      state.payload = (yield* Effect.orDie(
        Schema.decodeEffect(payloadCodec(entry.workflow))(state.payloadEncoded),
      )) as object
    }
    const instance = WorkflowInstance.initial(entry.workflow, executionId, state.scope)
    state.instance = instance
    state.fiber = yield* entry.execute(state.payload, executionId).pipe(
      Effect.onExit(() => {
        if (!state.interrupted) {
          return Effect.void
        }
        instance.interrupted = true
        instance.suspended = false
        return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
      }),
      Workflow.intoResult,
      Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      (effect) => deferredState.trackRun(instance, effect),
      Effect.tap((result) => {
        if (!Predicate.isTagged(result, "Complete")) return Effect.void
        return Effect.gen(function* () {
          const encoded = yield* Effect.orDie(
            Schema.encodeUnknownEffect(resultCodec(entry.workflow))(result),
          )
          yield* log.append(
            WorkflowRecord.cases.JobCompleted.make({ executionId, result: workflowJson(encoded) }),
          )
          state.completed = encoded
        })
      }),
      Effect.tap((result) => {
        if (state.parent === undefined || !Predicate.isTagged(result, "Complete")) {
          return Effect.void
        }
        return Effect.forkIn(resume(state.parent), scope)
      }),
      Effect.forkIn(entry.scope),
    )
    FiberMap.setUnsafe(executionFibers, executionId, state.fiber)
  })

  const deferredDoneEncoded = (options: {
    readonly workflowName: string
    readonly executionId: string
    readonly deferredName: string
    readonly exit: Exit.Exit<unknown, unknown>
  }) =>
    Effect.gen(function* () {
      const id = `${options.executionId}/${options.deferredName}`
      if (deferredResults.has(id)) return
      const encoded = yield* Effect.orDie(
        Schema.encodeUnknownEffect(DeferredExitJson)(options.exit),
      )
      if (deferredResults.has(id)) return
      yield* log.append(
        WorkflowRecord.cases.DeferredCompleted.make({
          workflow: options.workflowName,
          executionId: options.executionId,
          name: options.deferredName,
          exit: workflowJson(encoded),
        }),
      )
      deferredResults.set(id, workflowJson(encoded))
      const wake = Effect.andThen(
        deferredState.deferredDone(options.executionId, options.deferredName),
        resume(options.executionId),
      )
      const current = yield* Effect.serviceOption(WorkflowInstance)
      if (Option.isSome(current) && current.value.executionId === options.executionId) {
        yield* Effect.forkIn(wake, scope)
        return
      }
      yield* wake
    })

  const startClock = (clock: Extract<JobEntry, { _tag: "ClockScheduled" }>) =>
    Effect.gen(function* () {
      if (deferredResults.has(`${clock.executionId}/${clock.deferredName}`)) return
      const now = yield* Clock.currentTimeMillis
      const deferred = DurableDeferred.make(clock.deferredName)
      yield* engine
        .deferredDone(deferred, {
          workflowName: clock.workflow,
          executionId: clock.executionId,
          deferredName: clock.deferredName,
          exit: Exit.void,
        })
        .pipe(
          Effect.delay(Duration.millis(Math.max(0, clock.wakeAt - now))),
          FiberMap.run(clocks, `${clock.executionId}/${clock.name}`, { onlyIfMissing: true }),
          Effect.asVoid,
        )
    })

  const engine: WorkflowEngine.WorkflowEngine["Service"] = WorkflowEngine.makeUnsafe({
    register: Effect.fnUntraced(function* (workflow, execute) {
      workflows.set(workflow._tag, { workflow, execute, scope: yield* Effect.scope })
      registeredLatch(workflow._tag).openUnsafe()
      for (const [executionId, state] of executions) {
        if (
          state.workflowTag === workflow._tag &&
          state.completed === undefined &&
          state.fiber === undefined
        ) {
          yield* resume(executionId)
        }
      }
    }),
    execute: Effect.fnUntraced(function* (workflow, options) {
      let state = executions.get(options.executionId)
      if (!workflows.has(workflow._tag)) {
        if (state === undefined) {
          return yield* Effect.orDie(Effect.fail(`Workflow ${workflow._tag} is not registered`))
        }
        yield* registeredLatch(workflow._tag).await
      }
      if (state === undefined) {
        const started = WorkflowRecord.cases.JobStarted.make({
          workflow: workflow._tag,
          executionId: options.executionId,
          payload: workflowJson(
            yield* Effect.orDie(
              Schema.encodeUnknownEffect(payloadCodec(workflow))(options.payload),
            ),
          ),
          parent: options.parent?.executionId,
        })
        if (!executions.has(options.executionId)) {
          state = newExecution(started)
          state.payload = options.payload
          executions.set(options.executionId, state)
          yield* log.append(started)
          yield* resume(options.executionId)
        } else {
          state = executions.get(options.executionId)!
        }
      } else if (state.completed === undefined && state.fiber === undefined) {
        yield* resume(options.executionId)
      }
      if (options.discard) return undefined as Output<typeof options.discard>
      if (state.completed !== undefined && state.fiber === undefined) {
        return (yield* decodeCompleted(workflow, state.completed)) as Output<typeof options.discard>
      }
      const instance = state.instance!
      const exit = yield* Fiber.await(state.fiber!)
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) && instance.suspended) {
        return Workflow.Suspended.make({}) as Output<typeof options.discard>
      }
      return (yield* exit) as Output<typeof options.discard>
    }),
    interrupt: Effect.fnUntraced(function* (_workflow, executionId) {
      const state = executions.get(executionId)
      if (state === undefined) return
      if (!state.interrupted)
        yield* log.append(WorkflowRecord.cases.JobInterrupted.make({ executionId, unsafe: false }))
      state.interrupted = true
      yield* resume(executionId)
    }),
    interruptUnsafe: Effect.fnUntraced(function* (_workflow, executionId) {
      const state = executions.get(executionId)
      if (state === undefined) return
      if (!state.interrupted)
        yield* log.append(WorkflowRecord.cases.JobInterrupted.make({ executionId, unsafe: true }))
      state.interrupted = true
      if (state.fiber !== undefined) {
        yield* Fiber.interrupt(state.fiber)
      }
    }),
    resume(_workflow, executionId) {
      return resume(executionId)
    },
    activityExecute: Effect.fnUntraced(function* (activity, attempt) {
      const instance = yield* WorkflowInstance
      const activityId = `${instance.executionId}/${activity.name}/${attempt}`
      const durable = durableActivities.get(activityId)
      if (durable !== undefined) {
        const exit = yield* Effect.orDie(Schema.decodeEffect(ActivityExitJson)(durable))
        return new Workflow.Complete({ exit })
      }
      let state = activities.get(activityId)
      if (state !== undefined) {
        const exit = state.exit
        if (
          exit !== undefined &&
          Predicate.isTagged(exit, "Success") &&
          Predicate.isTagged(exit.value, "Suspended")
        ) {
          state.exit = undefined
        } else if (exit !== undefined) {
          return yield* exit
        }
      } else {
        state = { exit: undefined }
        activities.set(activityId, state)
      }
      const activityState = state
      const activityInstance = WorkflowInstance.initial(instance.workflow, instance.executionId)
      activityInstance.interrupted = instance.interrupted
      return yield* activity.executeEncoded.pipe(
        Workflow.intoResult,
        Effect.provideService(WorkflowInstance, activityInstance),
        Effect.tap((result) => {
          if (!Predicate.isTagged(result, "Complete")) return Effect.void
          return Effect.gen(function* () {
            const encoded = yield* Effect.orDie(
              Schema.encodeUnknownEffect(ActivityExitJson)(result.exit),
            )
            yield* log.append(
              WorkflowRecord.cases.ActivityCompleted.make({
                executionId: instance.executionId,
                key: activityId,
                exit: workflowJson(encoded),
              }),
            )
            durableActivities.set(activityId, workflowJson(encoded))
          })
        }),
        Effect.onExit((exit) => {
          activityState.exit =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? undefined : exit
          return Effect.void
        }),
      )
    }),
    poll: (workflow, executionId) =>
      Effect.suspend(() => {
        const state = executions.get(executionId)
        if (state === undefined) {
          return Effect.succeedNone
        }
        if (state.completed !== undefined && state.fiber === undefined) {
          return Effect.asSome(decodeCompleted(workflow, state.completed))
        }
        const exit = state.fiber?.pollUnsafe()
        if (exit === undefined) {
          return Effect.succeedNone
        }
        return Predicate.isTagged(exit, "Success")
          ? Effect.succeedSome(exit.value)
          : Effect.die(exit.cause)
      }),
    deferredResult: Effect.fnUntraced(function* (deferred) {
      const instance = yield* WorkflowInstance
      const encoded = deferredResults.get(`${instance.executionId}/${deferred.name}`)
      if (encoded === undefined) return Option.none()
      return Option.some(yield* Effect.orDie(Schema.decodeEffect(DeferredExitJson)(encoded)))
    }),
    deferredDone: deferredDoneEncoded,
    scheduleClock: (workflow, options) =>
      Effect.gen(function* () {
        const key = `${options.executionId}/${options.clock.name}`
        let scheduled = scheduledClocks.get(key)
        if (scheduled === undefined) {
          const now = yield* Clock.currentTimeMillis
          scheduled = WorkflowRecord.cases.ClockScheduled.make({
            workflow: workflow._tag,
            executionId: options.executionId,
            name: options.clock.name,
            deferredName: options.clock.deferred.name,
            wakeAt: now + Duration.toMillis(options.clock.duration),
          })
          scheduledClocks.set(key, scheduled)
          yield* log.append(scheduled)
        }
        yield* startClock(scheduled)
      }),
  })

  for (const clock of scheduledClocks.values()) {
    yield* startClock(clock)
  }

  const control = WorkflowControl.of({
    crash: Effect.sync(() => {
      crashed = true
      for (const state of executions.values()) {
        if (state.instance !== undefined) state.instance.abandoned = true
      }
    }),
  })

  return Context.make(WorkflowEngine.WorkflowEngine, engine).pipe(
    Context.add(WorkflowControl, control),
  )
})

/** A workflow adapter over a shard journal; all writes share the shard's create-once fence. */
export const layer = Layer.effectContext(make)
