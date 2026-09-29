import { Context, Data, type Effect, type Option, Schema } from "effect"
import type { ActorRef, Principal } from "../identity/caller.ts"

/** The context of one workflow run, obtained with `yield* X.Workflow`. */
export interface WorkflowContext {
  /** The owner actor's id. */
  readonly id: string
  readonly ref: ActorRef
  /** The principal recorded when the execution started. */
  readonly principal: Option.Option<Principal>
  readonly executionId: string
  readonly key: string
  /** The marker value recorded at start; 0 for an execution older than the marker. */
  readonly version: (name: string) => Effect.Effect<number>
}

/** A step exit as the engine records it: the step's own codecs encode the value. */
export const RecordedExit = Schema.TaggedUnion({
  Success: { value: Schema.Json },
  Failure: { error: Schema.Json },
  Die: { message: Schema.String },
})

export type RecordedExit = typeof RecordedExit.Type

/** A finished execution's result: its body's exit, or an interrupt. */
export const StoredResult = Schema.TaggedUnion({
  Success: { value: Schema.Json },
  Failure: { error: Schema.Json },
  Die: { message: Schema.String },
  Interrupt: {},
})

export type StoredResult = typeof StoredResult.Type

/** What a typed constructor names when it asks the engine to run or replay it. */
export interface StepIdentity {
  readonly workflow: string
  readonly name: string
  readonly kind: "activity" | "clock" | "wait" | "deferred"
}

/**
 * The engine of the run the calling fiber belongs to. Only the runtime
 * provides it, to a workflow body's fiber; constructors outside a body die.
 */
export interface WorkflowSteps {
  readonly activity: <R>(
    step: StepIdentity,
    run: Effect.Effect<RecordedExit, never, R>,
  ) => Effect.Effect<RecordedExit, never, R>
  readonly sleep: (step: StepIdentity, millis: number) => Effect.Effect<void>
  readonly wait: (
    step: StepIdentity,
    event: string,
    /** The stored value upcast to the event's current version when it matches; none otherwise. */
    matches: (value: string, version: number) => Effect.Effect<Option.Option<string>>,
    timeoutMs: number | undefined,
  ) => Effect.Effect<Option.Option<string>>
  readonly race: <R>(
    step: StepIdentity,
    run: Effect.Effect<RecordedExit, never, R>,
  ) => Effect.Effect<RecordedExit, never, R>
}

export const CurrentWorkflow = Context.Reference<WorkflowSteps | undefined>(
  "durable-actors/CurrentWorkflow",
  { defaultValue: () => undefined },
)

/**
 * Where the calling fiber stands for actor calls: outside any workflow, in a
 * workflow body (where calls die), or inside an activity, which derives each
 * call's command id.
 */
export type CallPhase = Data.TaggedEnum<{
  None: {}
  Body: {}
  Activity: { readonly nextCommandId: Effect.Effect<string> }
}>

export const CallPhase = Data.taggedEnum<CallPhase>()

export const CurrentCallPhase = Context.Reference<CallPhase>("durable-actors/CurrentCallPhase", {
  defaultValue: () => CallPhase.None(),
})
