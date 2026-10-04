import { Schema } from "effect"

import { DeploymentSummary } from "./deployments.ts"
import {
  ActorAddress,
  DeadLetterId,
  NonNegative,
  NonNegativeInt,
  SeriesPoint,
  Timestamp,
} from "./primitives.ts"

export const SidebarCounts = Schema.Struct({
  actorTypes: NonNegativeInt,
  openDeadLetters: NonNegativeInt,
})
export type SidebarCounts = typeof SidebarCounts.Type

/**
 * One environment's runtime at a glance, read from its runners' durable views:
 * how many actors there are, the pending jobs (`inFlight`, queued or waiting
 * to retry) and the dead letters by job name. Each nullable field is null when
 * the runners do not report it, never zero or empty: command rates and
 * latencies, throughput and p99 series, awake actors, jobs done per hour and
 * the runner, database, mailbox, socket and outbox-lag health.
 * `lastDeployAt` is when the environment's newest deployment was created, null
 * when it has none. `recentDeployments` is null here; the deployments list
 * reports them with their rollout state.
 */
export const Overview = Schema.Struct({
  commands: Schema.NullOr(
    Schema.Struct({
      perSecond: NonNegative,
      series24h: Schema.Array(SeriesPoint),
      p50Ms: NonNegative,
      p99Ms: NonNegative,
    }),
  ),
  actors: Schema.Struct({ awake: Schema.NullOr(NonNegativeInt), total: NonNegativeInt }),
  jobs: Schema.Struct({ inFlight: NonNegativeInt, donePerHour: Schema.NullOr(NonNegativeInt) }),
  deadLettersByJobType: Schema.Array(
    Schema.Struct({ jobName: Schema.String, count: NonNegativeInt }),
  ),
  throughput: Schema.NullOr(Schema.Array(SeriesPoint)),
  p99: Schema.NullOr(Schema.Array(SeriesPoint)),
  health: Schema.Struct({
    runners: Schema.NullOr(Schema.Struct({ healthy: NonNegativeInt, total: NonNegativeInt })),
    databaseCpuPercent: Schema.NullOr(NonNegative),
    maxMailbox: Schema.NullOr(
      Schema.Struct({ depth: NonNegativeInt, actor: Schema.NullOr(ActorAddress) }),
    ),
    parkedSockets: Schema.NullOr(NonNegativeInt),
    outboxLagP99Ms: Schema.NullOr(NonNegative),
    lastDeployAt: Schema.NullOr(Timestamp),
  }),
  recentDeployments: Schema.NullOr(Schema.Array(DeploymentSummary)),
})
export type Overview = typeof Overview.Type

/**
 * One actor type and how many actors of it the runners hold. The runners'
 * durable views record neither the commands a type declares nor its awake
 * actors, rates, latencies or mailboxes, so those are null, never empty or
 * zero.
 */
export const ActorTypeSummary = Schema.Struct({
  name: Schema.String,
  commands: Schema.NullOr(Schema.Array(Schema.String)),
  instances: NonNegativeInt,
  awake: Schema.NullOr(NonNegativeInt),
  commandsPerSecond: Schema.NullOr(NonNegative),
  p99Ms: Schema.NullOr(NonNegative),
  maxMailbox: Schema.NullOr(NonNegativeInt),
})
export type ActorTypeSummary = typeof ActorTypeSummary.Type

/** How far back a series reaches, ending now; the server picks the point spacing for the window. */
export const SeriesWindow = Schema.Literals(["1h", "24h", "7d"])
export type SeriesWindow = typeof SeriesWindow.Type

/** One command's volume over a window: its total and its mean rate. */
export const CommandVolume = Schema.Struct({
  command: Schema.String,
  count: NonNegativeInt,
  perSecond: NonNegative,
})
export type CommandVolume = typeof CommandVolume.Type

/**
 * Commands of one actor type over a window. `series` is commands per second at
 * evenly spaced instants, oldest first; `commands` is the volume of each
 * command the type handled in the window, busiest first.
 */
export const ActorTypeActivity = Schema.Struct({
  window: SeriesWindow,
  series: Schema.Array(SeriesPoint),
  commands: Schema.Array(CommandVolume),
})
export type ActorTypeActivity = typeof ActorTypeActivity.Type

/** Turns that finished in at most `upToMs` and more than the previous bucket's bound; the last bucket has a null bound and takes every slower turn. */
export const LatencyBucket = Schema.Struct({
  upToMs: Schema.NullOr(NonNegative),
  count: NonNegativeInt,
})
export type LatencyBucket = typeof LatencyBucket.Type

/** How long the turns of one actor type took over a window: buckets in ascending bound order and the 50th, 95th and 99th percentile in milliseconds. */
export const TurnLatency = Schema.Struct({
  window: SeriesWindow,
  buckets: Schema.Array(LatencyBucket),
  p50Ms: NonNegative,
  p95Ms: NonNegative,
  p99Ms: NonNegative,
})
export type TurnLatency = typeof TurnLatency.Type

/**
 * One actor of a type. Whether it is awake, its last command and when it was
 * last active are null when the runners do not report them.
 */
export const ActorInstance = Schema.Struct({
  key: Schema.String,
  status: Schema.NullOr(Schema.Literals(["awake", "idle"])),
  lastCommand: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(Timestamp),
  generation: NonNegativeInt,
})
export type ActorInstance = typeof ActorInstance.Type

export const OwnedTableRows = Schema.Struct({
  table: Schema.String,
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.Json)),
})
export type OwnedTableRows = typeof OwnedTableRows.Type

/**
 * Whom a command ran as, as the runner recorded it: a `user` with its
 * `subject` (`user:<id>` or `api-key:<id>` for a command sent from the
 * console), an `anonymous` caller, or a `system` delivery the framework made
 * from `source` (an actor's intent, a timer, cron, a workflow, a job or a
 * subscription), with `subject` the principal of the turn that caused it when
 * there was one.
 */
export const CommandCaller = Schema.Struct({
  kind: Schema.Literals(["user", "anonymous", "system"]),
  subject: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
})
export type CommandCaller = typeof CommandCaller.Type

/**
 * A command receipt the runner still holds. `result` is the outcome's tag
 * (`Success` or `Failure`), never the stored value, so reading a receipt
 * reveals that a command ran but not what it returned. `caller` is whom it
 * ran as, null when the runner's record of the caller does not decode.
 * `expiresAt` is when the runner stops answering a retry from it. `at` is when
 * it committed; runners do not record that time, so it is null. A receipt is
 * the committed turn itself, so `replayed` is false unless the entry describes
 * an answer served again from the receipt.
 */
export const Receipt = Schema.Struct({
  commandId: Schema.String,
  command: Schema.String,
  result: Schema.NullOr(Schema.String),
  caller: Schema.NullOr(CommandCaller),
  at: Schema.NullOr(Timestamp),
  expiresAt: Timestamp,
  replayed: Schema.Boolean,
})
export type Receipt = typeof Receipt.Type

/** An event the actor emitted: the cursor and emission time of its newest retained one, and its subscribers, null when the runner does not report them. */
export const ActorEvent = Schema.Struct({
  name: Schema.String,
  cursor: Schema.String,
  emittedAt: Timestamp,
  subscribers: Schema.NullOr(NonNegativeInt),
})
export type ActorEvent = typeof ActorEvent.Type

export const JobStatus = Schema.Literals(["queued", "running", "retrying", "done", "dead"])
export type JobStatus = typeof JobStatus.Type

export const ActorJob = Schema.Struct({
  name: Schema.String,
  id: Schema.String,
  attempts: NonNegativeInt,
  status: JobStatus,
})
export type ActorJob = typeof ActorJob.Type

/**
 * One moment of an actor's history: an event it emitted (`label` the event)
 * or a command whose turn emitted events (`label` the command), both at the
 * turn's emission time, with `detail` the command id. `caller` is whom the
 * command ran as, null once its receipt has expired.
 */
export const ActorTimelineEntry = Schema.Struct({
  at: Timestamp,
  kind: Schema.Literals(["command", "event", "job"]),
  label: Schema.String,
  detail: Schema.NullOr(Schema.String),
  caller: Schema.NullOr(CommandCaller),
})
export type ActorTimelineEntry = typeof ActorTimelineEntry.Type

/**
 * One actor as the inspector shows it, read from the runner that owns it.
 * `state` is the committed state, one field per stored entry, and null when
 * an entry does not decode. `timeline` is its newest timeline page. Every
 * other nullable field is null when the runner does not report it: the turn
 * count, owned-table rows, subscriber and socket counts, whether the actor is
 * awake, the runner and region that hold it and its mailbox depth. A null is
 * unknown, never zero or empty.
 */
export const ActorInspector = Schema.Struct({
  address: ActorAddress,
  state: Schema.Json,
  turn: Schema.NullOr(NonNegativeInt),
  tables: Schema.NullOr(Schema.Array(OwnedTableRows)),
  receipts: Schema.Array(Receipt),
  events: Schema.Array(ActorEvent),
  jobs: Schema.Array(ActorJob),
  connections: Schema.Struct({
    sockets: Schema.NullOr(NonNegativeInt),
    feedCursor: Schema.NullOr(Schema.String),
  }),
  properties: Schema.Struct({
    status: Schema.NullOr(Schema.Literals(["awake", "idle"])),
    type: Schema.String,
    generation: NonNegativeInt,
    runner: Schema.NullOr(Schema.String),
    region: Schema.NullOr(Schema.String),
    tenant: Schema.String,
    mailboxDepth: Schema.NullOr(NonNegativeInt),
  }),
  timeline: Schema.NullOr(Schema.Array(ActorTimelineEntry)),
})
export type ActorInspector = typeof ActorInspector.Type

export const CommandOutcome = Schema.Literals(["ok", "error", "replayed"])
export type CommandOutcome = typeof CommandOutcome.Type

/**
 * One committed command; `errorTag` is set only when `outcome` is `error`.
 * The command log is read from the runners' receipts, which hold no commit
 * time, duration or payload, so `at`, `durationMs` and `payloadPreview` are
 * null there; `caller` is as in `Receipt`.
 */
export const CommandLogEntry = Schema.Struct({
  commandId: Schema.String,
  at: Schema.NullOr(Timestamp),
  durationMs: Schema.NullOr(NonNegative),
  address: ActorAddress,
  command: Schema.String,
  caller: Schema.NullOr(CommandCaller),
  payloadPreview: Schema.NullOr(Schema.String),
  outcome: CommandOutcome,
  errorTag: Schema.NullOr(Schema.String),
})
export type CommandLogEntry = typeof CommandLogEntry.Type

const commandName = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)))

/**
 * A command the console sends to one actor. `commandId` is the client
 * idempotency key: when omitted the server mints a new one, and when a caller
 * resends the same key the control plane reuses its durably assigned command
 * id. The runner then answers from its stored receipt without running the
 * command again.
 */
export const SendCommand = Schema.Struct({
  address: ActorAddress,
  command: commandName,
  payload: Schema.Json,
  commandId: Schema.optional(commandName),
})
export type SendCommand = typeof SendCommand.Type

/** The actor's return value for a command; `replayed` is true when it came from the stored receipt of an earlier send of the same `commandId`. */
export const CommandSent = Schema.Struct({
  commandId: Schema.String,
  result: Schema.Json,
  replayed: Schema.Boolean,
})
export type CommandSent = typeof CommandSent.Type

/** A client key remains expired for 30 days after its runner identity expires; answered 410. */
export class CommandExpired extends Schema.TaggedError<CommandExpired>()(
  "CommandExpired",
  { commandId: Schema.String },
  { httpApiStatus: 410 },
) {}

/** A remote runner defect is opaque and must never cause an automatic retry; answered 502. */
export class RunnerDefect extends Schema.TaggedError<RunnerDefect>()(
  "RunnerDefect",
  {},
  { httpApiStatus: 502 },
) {}

/** The runner refused admission without committing a command receipt; answered 422. */
export class CommandRefused extends Schema.TaggedError<CommandRefused>()(
  "CommandRefused",
  { commandId: Schema.String, reasonTag: Schema.String, reason: Schema.Json },
  { httpApiStatus: 422 },
) {}

/**
 * The actor ran the command and returned a typed error, answered 422. `errorTag`
 * and `error` are the actor's own error; `replayed` is as in `CommandSent`.
 */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  {
    commandId: Schema.String,
    errorTag: Schema.String,
    error: Schema.Json,
    replayed: Schema.Boolean,
  },
  { httpApiStatus: 422 },
) {}

/**
 * One job name: `retried` counts its pending jobs that have failed at least
 * one attempt and `dead` its dead letters. Jobs done and their latency are
 * null when the runners do not report them.
 */
export const JobTypeStats = Schema.Struct({
  jobName: Schema.String,
  done: Schema.NullOr(NonNegativeInt),
  retried: NonNegativeInt,
  dead: NonNegativeInt,
  p99Ms: Schema.NullOr(NonNegative),
})
export type JobTypeStats = typeof JobTypeStats.Type

/**
 * The environment's jobs: pending ones that have not failed an attempt yet
 * (`queued`) or have (`retrying`), and dead letters. Which jobs are running
 * and the throughput are null when the runners do not report them.
 */
export const JobsSummary = Schema.Struct({
  queued: NonNegativeInt,
  running: Schema.NullOr(NonNegativeInt),
  retrying: NonNegativeInt,
  dead: NonNegativeInt,
  byType: Schema.Array(JobTypeStats),
  throughput: Schema.NullOr(Schema.Array(SeriesPoint)),
})
export type JobsSummary = typeof JobsSummary.Type

export const DeadLetter = Schema.Struct({
  id: DeadLetterId,
  jobName: Schema.String,
  jobId: Schema.String,
  actor: ActorAddress,
  attempts: NonNegativeInt,
  lastError: Schema.String,
  since: Timestamp,
})
export type DeadLetter = typeof DeadLetter.Type

/**
 * One workflow run. `step` is the step it reached last: `index` counts the
 * distinct steps it has recorded, from 1, so a run showing "step n of m" has
 * `index` n and `total` m, and `index` never exceeds `total`. `total` is null
 * when the runner does not know how many steps the workflow has, and `step`
 * is null when the run holds no recorded step, as once it finished. A failed
 * run ended with a declared failure, a defect or an interruption. `status` is
 * null for a finished run whose stored result does not decode.
 */
export const Workflow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: ActorAddress,
  step: Schema.NullOr(
    Schema.Struct({
      index: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
      total: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
      name: Schema.String,
    }).pipe(
      Schema.check(
        Schema.makeFilter(
          (step) =>
            step.total === null ||
            step.index <= step.total ||
            "step.index must not exceed step.total",
        ),
      ),
    ),
  ),
  waitingFor: Schema.NullOr(
    Schema.Struct({ kind: Schema.Literals(["event", "timer"]), name: Schema.String }),
  ),
  startedAt: Timestamp,
  status: Schema.NullOr(Schema.Literals(["running", "waiting", "completed", "failed"])),
})
export type Workflow = typeof Workflow.Type

export const TimersSummary = Schema.Struct({
  pending: NonNegativeInt,
  nextFireAt: Schema.NullOr(Timestamp),
})
export type TimersSummary = typeof TimersSummary.Type

export const Schedule = Schema.Struct({
  name: Schema.String,
  actorPattern: Schema.String,
  cron: Schema.String,
  lastRun: Schema.NullOr(
    Schema.Struct({
      at: Timestamp,
      outcome: Schema.Literals(["ok", "error"]),
      durationMs: NonNegative,
    }),
  ),
  nextRunAt: Timestamp,
})
export type Schedule = typeof Schedule.Type

export const ConnectionsSummary = Schema.Struct({
  open: NonNegativeInt,
  parked: NonNegativeInt,
  sseStreams: NonNegativeInt,
  feedSubscribers: NonNegativeInt,
  replayGaps: NonNegativeInt,
  openVersusParked: Schema.Array(
    Schema.Struct({ at: Timestamp, open: NonNegativeInt, parked: NonNegativeInt }),
  ),
  byActorType: Schema.Array(
    Schema.Struct({
      actorType: Schema.String,
      open: NonNegativeInt,
      parked: NonNegativeInt,
      sse: NonNegativeInt,
    }),
  ),
})
export type ConnectionsSummary = typeof ConnectionsSummary.Type

/**
 * A command-palette hit among the runtime's own data; pages and settings are
 * searched client side. An `actor-type` hit's `id` is the type's name and an
 * `actor` hit's its address.
 */
export const SearchResult = Schema.Struct({
  kind: Schema.Literals(["actor-type", "actor", "deployment"]),
  id: Schema.String,
  title: Schema.String,
  subtitle: Schema.NullOr(Schema.String),
})
export type SearchResult = typeof SearchResult.Type
