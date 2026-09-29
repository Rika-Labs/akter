import { Schema } from "effect"

/** The inspector API's JSON bodies, as `Inspector.serve` answers them. */

/** A stored value: its JSON, or the text when it could not be decoded. */
export const Decoded = Schema.Union([
  Schema.Struct({ json: Schema.Json }),
  Schema.Struct({ undecodable: Schema.String }),
])

/** A stored value: its JSON, or the text when it could not be decoded. */
export type Decoded = typeof Decoded.Type

const Stored = Schema.NullOr(Decoded)

const Millis = Schema.Finite

const Identity = { actorType: Schema.String, actorId: Schema.String }

/** A tenant's view versions and row counts. */
export const Overview = Schema.Struct({
  tenant: Schema.String,
  views: Schema.Array(Schema.Struct({ view: Schema.String, version: Schema.Finite })),
  counts: Schema.Struct({
    actors: Schema.Finite,
    receipts: Schema.Finite,
    events: Schema.Finite,
    outbox: Schema.Finite,
    timers: Schema.Finite,
    effects: Schema.Finite,
    deadLetters: Schema.Finite,
    workflows: Schema.Finite,
    openWorkflows: Schema.Finite,
  }),
})

/** A tenant's view versions and row counts. */
export type Overview = typeof Overview.Type

/** One actor with its placement, generation and last event sequence. */
export const ActorRow = Schema.Struct({
  ...Identity,
  placement: Schema.NullOr(Schema.String),
  generation: Schema.Finite,
  created: Schema.Boolean,
  lastEventSequence: Schema.Finite,
})

/** One actor with its placement, generation and last event sequence. */
export type ActorRow = typeof ActorRow.Type

/** A page of actors; `next` is the identity to continue from, or null at the end. */
export const ActorsPage = Schema.Struct({
  actors: Schema.Array(ActorRow),
  next: Schema.NullOr(Schema.Struct(Identity)),
})

/** A staged intent with its target, attempts, last error and due time in epoch milliseconds. */
export const OutboxRow = Schema.Struct({
  ...Identity,
  intentId: Schema.String,
  timerKey: Schema.NullOr(Schema.String),
  targetType: Schema.String,
  targetId: Schema.String,
  command: Schema.String,
  payload: Stored,
  caller: Stored,
  attempts: Schema.Finite,
  lastError: Schema.NullOr(Schema.String),
  dueAtMs: Millis,
})

/** A staged intent with its target, attempts, last error and due time in epoch milliseconds. */
export type OutboxRow = typeof OutboxRow.Type

/**
 * A pending effect with its attempts, last error, due time in epoch
 * milliseconds and whether an earlier attempt's outcome is ambiguous.
 */
export const EffectRow = Schema.Struct({
  ...Identity,
  effectId: Schema.String,
  effect: Schema.String,
  payload: Stored,
  caller: Stored,
  attempts: Schema.Finite,
  lastError: Schema.NullOr(Schema.String),
  ambiguous: Schema.Boolean,
  dueAtMs: Millis,
})

/**
 * A pending effect with its attempts, last error, due time in epoch
 * milliseconds and whether an earlier attempt's outcome is ambiguous.
 */
export type EffectRow = typeof EffectRow.Type

/** An effect that gave up, with its cause and the epoch millisecond it died. */
export const DeadLetterRow = Schema.Struct({
  ...Identity,
  effectId: Schema.String,
  effect: Schema.String,
  payload: Stored,
  attempts: Schema.Finite,
  cause: Schema.String,
  ambiguous: Schema.Boolean,
  deadAtMs: Millis,
})

/** An effect that gave up, with its cause and the epoch millisecond it died. */
export type DeadLetterRow = typeof DeadLetterRow.Type

/** One attempt of one workflow step; times are epoch milliseconds. */
export const StepRow = Schema.Struct({
  step: Schema.String,
  attempt: Schema.Finite,
  kind: Schema.String,
  exit: Stored,
  waitEvent: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.Finite),
  dueAtMs: Schema.NullOr(Millis),
  startedAtMs: Millis,
  settledAtMs: Schema.NullOr(Millis),
})

/** One attempt of one workflow step; times are epoch milliseconds. */
export type StepRow = typeof StepRow.Type

/** A workflow execution with its status, payload and result sizes in bytes, and steps. */
export const WorkflowRow = Schema.Struct({
  ...Identity,
  executionId: Schema.String,
  workflow: Schema.String,
  workflowKey: Schema.String,
  manifestHash: Schema.String,
  status: Schema.String,
  interrupt: Schema.Boolean,
  caller: Stored,
  payload: Stored,
  payloadBytes: Schema.Finite,
  result: Stored,
  resultBytes: Schema.NullOr(Schema.Finite),
  startedAtMs: Millis,
  finishedAtMs: Schema.NullOr(Millis),
  steps: Schema.Array(StepRow),
})

/** A workflow execution with its status, payload and result sizes in bytes, and steps. */
export type WorkflowRow = typeof WorkflowRow.Type

/**
 * A command receipt with its outcome, expiry in epoch milliseconds and the
 * sequences of the events it emitted.
 */
export const ReceiptRow = Schema.Struct({
  commandId: Schema.String,
  command: Schema.String,
  callerKey: Stored,
  outcomeTag: Schema.NullOr(Schema.String),
  outcome: Stored,
  expiresAtMs: Millis,
  events: Schema.Array(Schema.Finite),
})

/**
 * A command receipt with its outcome, expiry in epoch milliseconds and the
 * sequences of the events it emitted.
 */
export type ReceiptRow = typeof ReceiptRow.Type

/** A stored event with its sequence, size in bytes and emission time in epoch milliseconds. */
export const EventRow = Schema.Struct({
  sequence: Schema.Finite,
  event: Schema.String,
  commandId: Schema.NullOr(Schema.String),
  value: Stored,
  bytes: Schema.Finite,
  emittedAtMs: Millis,
})

/** A stored event with its sequence, size in bytes and emission time in epoch milliseconds. */
export type EventRow = typeof EventRow.Type

/**
 * One actor with its state entries, recent rows of every kind, and the totals
 * they were cut from.
 */
export const ActorDetail = Schema.Struct({
  actor: ActorRow,
  state: Schema.Array(Schema.Struct({ key: Schema.String, bytes: Schema.Finite, value: Stored })),
  receipts: Schema.Array(ReceiptRow),
  events: Schema.Array(EventRow),
  outbox: Schema.Array(OutboxRow),
  effects: Schema.Array(EffectRow),
  deadLetters: Schema.Array(DeadLetterRow),
  workflows: Schema.Array(WorkflowRow),
  totals: Schema.Struct({
    receipts: Schema.Finite,
    events: Schema.Finite,
    outbox: Schema.Finite,
    effects: Schema.Finite,
    deadLetters: Schema.Finite,
    workflows: Schema.Finite,
  }),
})

/**
 * One actor with its state entries, recent rows of every kind, and the totals
 * they were cut from.
 */
export type ActorDetail = typeof ActorDetail.Type

/** A tenant-wide page of outbox rows. */
export const OutboxPage = Schema.Struct({ outbox: Schema.Array(OutboxRow) })

/** A tenant-wide page of effect rows. */
export const EffectsPage = Schema.Struct({ effects: Schema.Array(EffectRow) })

/** A tenant-wide page of dead letters. */
export const DeadLettersPage = Schema.Struct({ deadLetters: Schema.Array(DeadLetterRow) })

/** A tenant-wide page of workflows. */
export const WorkflowsPage = Schema.Struct({ workflows: Schema.Array(WorkflowRow) })
