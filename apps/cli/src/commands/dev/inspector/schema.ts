import { Schema } from "effect"

/** The inspector API's JSON bodies, as `Inspector.serve` answers them. */

export const Decoded = Schema.Union([
  Schema.Struct({ json: Schema.Json }),
  Schema.Struct({ undecodable: Schema.String }),
])

export type Decoded = typeof Decoded.Type

const Stored = Schema.NullOr(Decoded)

const Millis = Schema.Finite

const Identity = { actorType: Schema.String, actorId: Schema.String }

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

export type Overview = typeof Overview.Type

export const ActorRow = Schema.Struct({
  ...Identity,
  placement: Schema.NullOr(Schema.String),
  generation: Schema.Finite,
  created: Schema.Boolean,
  lastEventSequence: Schema.Finite,
})

export type ActorRow = typeof ActorRow.Type

export const ActorsPage = Schema.Struct({
  actors: Schema.Array(ActorRow),
  next: Schema.NullOr(Schema.Struct(Identity)),
})

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

export type OutboxRow = typeof OutboxRow.Type

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

export type EffectRow = typeof EffectRow.Type

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

export type DeadLetterRow = typeof DeadLetterRow.Type

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

export type StepRow = typeof StepRow.Type

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

export type WorkflowRow = typeof WorkflowRow.Type

export const ReceiptRow = Schema.Struct({
  commandId: Schema.String,
  command: Schema.String,
  callerKey: Stored,
  outcomeTag: Schema.NullOr(Schema.String),
  outcome: Stored,
  expiresAtMs: Millis,
  events: Schema.Array(Schema.Finite),
})

export type ReceiptRow = typeof ReceiptRow.Type

export const EventRow = Schema.Struct({
  sequence: Schema.Finite,
  event: Schema.String,
  commandId: Schema.NullOr(Schema.String),
  value: Stored,
  bytes: Schema.Finite,
  emittedAtMs: Millis,
})

export type EventRow = typeof EventRow.Type

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

export type ActorDetail = typeof ActorDetail.Type

export const OutboxPage = Schema.Struct({ outbox: Schema.Array(OutboxRow) })

export const EffectsPage = Schema.Struct({ effects: Schema.Array(EffectRow) })

export const DeadLettersPage = Schema.Struct({ deadLetters: Schema.Array(DeadLetterRow) })

export const WorkflowsPage = Schema.Struct({ workflows: Schema.Array(WorkflowRow) })
