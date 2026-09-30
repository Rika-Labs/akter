import { Schema } from "effect"

/** The framework command that starts a workflow execution; its payload is a `StartPayload`. */
export const START = "$workflow/start"

/** The framework command that re-runs an execution's body after a wake, timer, or new event; its payload is an `ExecutionTarget`. */
export const RESUME = "$workflow/resume"

/** The framework command that durably interrupts an execution; its payload is an `ExecutionTarget`. */
export const INTERRUPT = "$workflow/interrupt"

/** Names one execution in a resume or interrupt payload. */
export const ExecutionTarget = Schema.fromJsonString(Schema.Struct({ executionId: Schema.String }))

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
