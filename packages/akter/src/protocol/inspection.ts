import { Schema } from "effect"

/** A stored value: its JSON, or the text when it could not be decoded. */
export const Decoded = Schema.Union([
  Schema.Struct({ json: Schema.Json }),
  Schema.Struct({ undecodable: Schema.String }),
])

export type Decoded = typeof Decoded.Type

const Stored = Schema.NullOr(Decoded)

const Millis = Schema.Finite

const Identity = { actorType: Schema.String, actorId: Schema.String }

/**
 * A tenant's view versions and row counts, and when its soonest pending timer
 * is due in epoch milliseconds, null when it has none.
 */
export const Overview = Schema.Struct({
  tenant: Schema.String,
  views: Schema.Array(Schema.Struct({ view: Schema.String, version: Schema.Finite })),
  counts: Schema.Struct({
    actors: Schema.Finite,
    receipts: Schema.Finite,
    events: Schema.Finite,
    outbox: Schema.Finite,
    timers: Schema.Finite,
    jobs: Schema.Finite,
    deadLetters: Schema.Finite,
    workflows: Schema.Finite,
    openWorkflows: Schema.Finite,
  }),
  nextTimerDueAtMs: Schema.NullOr(Millis),
})

export type Overview = typeof Overview.Type

/** One actor with its placement, generation and last event sequence. */
export const ActorRow = Schema.Struct({
  ...Identity,
  placement: Schema.NullOr(Schema.String),
  generation: Schema.Finite,
  created: Schema.Boolean,
  lastEventSequence: Schema.Finite,
})

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

export type OutboxRow = typeof OutboxRow.Type

/**
 * A pending job with its attempts, last error, due time in epoch
 * milliseconds and whether an earlier attempt's outcome is ambiguous.
 */
export const JobRow = Schema.Struct({
  ...Identity,
  jobId: Schema.String,
  job: Schema.String,
  payload: Stored,
  caller: Stored,
  attempts: Schema.Finite,
  lastError: Schema.NullOr(Schema.String),
  ambiguous: Schema.Boolean,
  dueAtMs: Millis,
})

export type JobRow = typeof JobRow.Type

/** A job that gave up, with its cause and the epoch millisecond it died. */
export const DeadLetterRow = Schema.Struct({
  ...Identity,
  jobId: Schema.String,
  job: Schema.String,
  payload: Stored,
  attempts: Schema.Finite,
  cause: Schema.String,
  ambiguous: Schema.Boolean,
  deadAtMs: Millis,
})

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
  jobs: Schema.Array(JobRow),
  deadLetters: Schema.Array(DeadLetterRow),
  workflows: Schema.Array(WorkflowRow),
  totals: Schema.Struct({
    receipts: Schema.Finite,
    events: Schema.Finite,
    outbox: Schema.Finite,
    jobs: Schema.Finite,
    deadLetters: Schema.Finite,
    workflows: Schema.Finite,
  }),
})

export type ActorDetail = typeof ActorDetail.Type

/** Without `receipts.read`, an operator sees that a command ran but not what it returned. */
export const OperatorActorDetail = ActorDetail.mapFields((fields) => ({
  ...fields,
  receipts: Schema.Array(
    ReceiptRow.mapFields(({ outcome, ...receipt }) => ({
      ...receipt,
      outcome: Schema.optionalKey(outcome),
    })),
  ),
}))

/** A tenant-wide page of outbox rows. */
export const OutboxPage = Schema.Struct({ outbox: Schema.Array(OutboxRow) })

/** A tenant-wide page of job rows. */
export const JobsPage = Schema.Struct({ jobs: Schema.Array(JobRow) })

/** A tenant-wide page of dead letters; `next` is the dead letter to continue after, or null at the end. */
export const DeadLettersPage = Schema.Struct({
  deadLetters: Schema.Array(DeadLetterRow),
  next: Schema.NullOr(Schema.Struct({ deadAtMs: Millis, jobId: Schema.String })),
})

/** A tenant-wide page of workflows; `next` is the execution to continue after, or null at the end. */
export const WorkflowsPage = Schema.Struct({
  workflows: Schema.Array(WorkflowRow),
  next: Schema.NullOr(Schema.Struct({ startedAtMs: Millis, executionId: Schema.String })),
})

/** How many of the tenant's actors have one type. */
export const ActorTypeRow = Schema.Struct({ actorType: Schema.String, actors: Schema.Finite })

export type ActorTypeRow = typeof ActorTypeRow.Type

/** A page of actor types by name; `next` is the type to continue after, or null at the end. */
export const ActorTypesPage = Schema.Struct({
  actorTypes: Schema.Array(ActorTypeRow),
  next: Schema.NullOr(Schema.String),
})

/** A receipt with the actor that holds it. */
export const ActorReceiptRow = Schema.Struct({ ...Identity, ...ReceiptRow.fields })

export type ActorReceiptRow = typeof ActorReceiptRow.Type

/**
 * A page of receipts, the latest expiry first; `next` is the receipt to
 * continue after, or null at the end.
 */
export const ReceiptsPage = Schema.Struct({
  receipts: Schema.Array(ActorReceiptRow),
  next: Schema.NullOr(
    Schema.Struct({ ...Identity, expiresAtMs: Millis, commandId: Schema.String }),
  ),
})

/** The newest retained event of one name, with its sequence and emission time in epoch milliseconds. */
export const LatestEventRow = Schema.Struct({
  event: Schema.String,
  sequence: Schema.Finite,
  emittedAtMs: Millis,
})

export type LatestEventRow = typeof LatestEventRow.Type

/** A page of an actor's event names; `next` is the name to continue after, or null at the end. */
export const LatestEventsPage = Schema.Struct({
  events: Schema.Array(LatestEventRow),
  next: Schema.NullOr(Schema.String),
})

/**
 * One entry of an actor's timeline: an event at its emission time, or the
 * command whose turn emitted events, at that turn's emission time and its
 * first event's sequence. `callerKey` is the caller of the command's retained
 * receipt, null once the receipt has expired.
 */
export const TimelineRow = Schema.Struct({
  kind: Schema.Literals(["command", "event"]),
  sequence: Schema.Finite,
  name: Schema.String,
  commandId: Schema.String,
  callerKey: Stored,
  atMs: Millis,
})

export type TimelineRow = typeof TimelineRow.Type

/**
 * A page of an actor's timeline, newest first, each command after the events
 * its turn emitted; `next` is the entry to continue after, or null at the end.
 */
export const TimelinePage = Schema.Struct({
  entries: Schema.Array(TimelineRow),
  next: Schema.NullOr(
    Schema.Struct({ sequence: Schema.Finite, kind: Schema.Literals(["command", "event"]) }),
  ),
})

/**
 * The tenant's pending jobs of one name, split by whether an attempt has
 * failed yet, and its dead letters of that name.
 */
export const JobTypeRow = Schema.Struct({
  job: Schema.String,
  queued: Schema.Finite,
  retrying: Schema.Finite,
  deadLetters: Schema.Finite,
})

export type JobTypeRow = typeof JobTypeRow.Type

/** A page of job names; `next` is the name to continue after, or null at the end. */
export const JobTypesPage = Schema.Struct({
  jobTypes: Schema.Array(JobTypeRow),
  next: Schema.NullOr(Schema.String),
})
