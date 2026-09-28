import { Effect, Exit, Option, Schedule, Schema } from "effect"
import { Workflow as EffectWorkflow } from "effect/unstable/workflow"
import { type RecordedExit, StoredResult } from "../contexts/workflow.ts"
import type { ActorError } from "../errors/actor.ts"
import type { AnyWorkflow } from "../members/workflow.ts"
import type { WorkflowStatus } from "./actors.ts"

export const START = "$workflow/start"

export const RESUME = "$workflow/resume"

export const INTERRUPT = "$workflow/interrupt"

/** Names one execution in a resume or interrupt payload. */
export const Target = Schema.fromJsonString(Schema.Struct({ executionId: Schema.String }))

/**
 * A workflow start staged as an intent. `after` is the owner's event
 * sequence before the staging turn's emits when the owner staged it, so its
 * waits see every owner event from that turn on, even ones committed before
 * the start is delivered.
 */
export const StartPayload = Schema.fromJsonString(
  Schema.Struct({
    workflow: Schema.String,
    input: Schema.String,
    key: Schema.String,
    after: Schema.NullOr(Schema.String),
  }),
)

/** A start's output: the execution id. */
export const ExecutionIdOutput = Schema.fromJsonString(Schema.Struct({ value: Schema.String }))

type PollReason = "ActorUnavailable" | "Unauthorized" | "Timeout"

type CommandReason =
  | "ActorUnavailable"
  | "CommandConflict"
  | "CommandExpired"
  | "InvalidCommandId"
  | "Unauthorized"
  | "Timeout"
  | "RunnerAtCapacity"

/** One workflow execution, from a start or `X.run(member, executionId)`. */
export interface WorkflowRun<W extends AnyWorkflow> {
  readonly executionId: string
  /** `None` for an unknown execution; `Suspended` until it finishes. */
  readonly poll: Effect.Effect<
    Option.Option<EffectWorkflow.Result<W["output"]["Type"], W["errors"][number]["Type"]>>,
    ActorError.Of<PollReason>
  >
  /** Polls until the execution finishes; an interrupted execution interrupts. */
  readonly result: Effect.Effect<
    W["output"]["Type"],
    W["errors"][number]["Type"] | ActorError.Of<PollReason>
  >
  /** Durably interrupts the execution; idempotent, and a no-op once it finished. */
  readonly interrupt: Effect.Effect<void, ActorError.Of<CommandReason>>
}

const RESULT_POLL = Schedule.spaced("100 millis")

/** Builds the run of one execution from its owner's poll and interrupt. */
export const workflowRun = <W extends AnyWorkflow>(options: {
  readonly executionId: string
  readonly poll: Effect.Effect<WorkflowStatus | undefined, ActorError>
  readonly interrupt: Effect.Effect<void, ActorError>
  readonly decode: (
    recorded: RecordedExit,
  ) => Effect.Effect<Exit.Exit<W["output"]["Type"], W["errors"][number]["Type"]>>
}) => {
  type Result = EffectWorkflow.Result<W["output"]["Type"], W["errors"][number]["Type"]>

  const poll = Effect.gen(function* (): Effect.fn.Return<Option.Option<Result>, ActorError> {
    const status = yield* options.poll

    if (status === undefined) return Option.none()

    if (!status.finished || status.result === undefined)
      return Option.some(EffectWorkflow.Suspended.make({}))

    const recorded = status.result

    const exit = StoredResult.guards.Interrupt(recorded)
      ? Exit.interrupt()
      : yield* options.decode(recorded)

    return Option.some(new EffectWorkflow.Complete({ exit }))
  })

  const result = poll.pipe(
    Effect.map(
      Option.filter(
        (
          found,
        ): found is EffectWorkflow.Complete<W["output"]["Type"], W["errors"][number]["Type"]> =>
          found instanceof EffectWorkflow.Complete,
      ),
    ),
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(pending), onSome: Effect.succeed })),
    Effect.retry({ while: (error) => error === pending, schedule: RESULT_POLL }),
    Effect.flatMap((complete) => complete.exit),
  )

  return { executionId: options.executionId, poll, result, interrupt: options.interrupt }
}

const pending = Symbol("pending")
