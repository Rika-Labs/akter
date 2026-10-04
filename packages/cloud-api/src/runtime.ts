import * as Framework from "@rikalabs/akter/client"
import { Schema, Struct } from "effect"

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

export const Overview = Schema.Struct({
  commands: Schema.Struct({
    perSecond: NonNegative,
    series24h: Schema.Array(SeriesPoint),
    p50Ms: NonNegative,
    p99Ms: NonNegative,
  }),
  actors: Schema.Struct({ awake: NonNegativeInt, total: NonNegativeInt }),
  jobs: Schema.Struct({ inFlight: NonNegativeInt, donePerHour: NonNegativeInt }),
  deadLettersByJobType: Schema.Array(
    Schema.Struct({ jobName: Schema.String, count: NonNegativeInt }),
  ),
  throughput: Schema.Array(SeriesPoint),
  p99: Schema.Array(SeriesPoint),
  health: Schema.Struct({
    runners: Schema.Struct({ healthy: NonNegativeInt, total: NonNegativeInt }),
    databaseCpuPercent: NonNegative,
    maxMailbox: Schema.Struct({ depth: NonNegativeInt, actor: Schema.NullOr(ActorAddress) }),
    parkedSockets: NonNegativeInt,
    outboxLagP99Ms: NonNegative,
    lastDeployAt: Schema.NullOr(Timestamp),
  }),
  recentDeployments: Schema.Array(DeploymentSummary),
})
export type Overview = typeof Overview.Type

export const ActorTypeSummary = Schema.Struct({
  name: Schema.String,
  commands: Schema.Array(Schema.String),
  instances: NonNegativeInt,
  awake: NonNegativeInt,
  commandsPerSecond: NonNegative,
  p99Ms: NonNegative,
  maxMailbox: NonNegativeInt,
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

export const ActorInstance = Schema.Struct({
  key: Schema.String,
  status: Schema.Literals(["awake", "idle"]),
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

export const Receipt = Schema.Struct({
  commandId: Schema.String,
  command: Schema.String,
  result: Schema.String,
  at: Timestamp,
  replayed: Schema.Boolean,
})
export type Receipt = typeof Receipt.Type

export const ActorEvent = Schema.Struct({
  name: Schema.String,
  cursor: Schema.String,
  subscribers: NonNegativeInt,
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

export const ActorTimelineEntry = Schema.Struct({
  at: Timestamp,
  kind: Schema.Literals(["command", "event", "job"]),
  label: Schema.String,
  detail: Schema.NullOr(Schema.String),
})
export type ActorTimelineEntry = typeof ActorTimelineEntry.Type

/** One actor as the inspector shows it, read from the runner that owns it. */
export const ActorInspector = Schema.Struct({
  address: ActorAddress,
  state: Schema.Json,
  turn: NonNegativeInt,
  tables: Schema.Array(OwnedTableRows),
  receipts: Schema.Array(Receipt),
  events: Schema.Array(ActorEvent),
  jobs: Schema.Array(ActorJob),
  connections: Schema.Struct({ sockets: NonNegativeInt, feedCursor: Schema.NullOr(Schema.String) }),
  properties: Schema.Struct({
    status: Schema.Literals(["awake", "idle"]),
    type: Schema.String,
    generation: NonNegativeInt,
    runner: Schema.NullOr(Schema.String),
    region: Schema.String,
    tenant: Schema.String,
    mailboxDepth: NonNegativeInt,
  }),
  timeline: Schema.Array(ActorTimelineEntry),
})
export type ActorInspector = typeof ActorInspector.Type

export const CommandOutcome = Schema.Literals(["ok", "error", "replayed"])
export type CommandOutcome = typeof CommandOutcome.Type

/** One committed command in the live tail; `errorTag` is set only when `outcome` is `error`. */
export const CommandLogEntry = Schema.Struct({
  at: Timestamp,
  durationMs: NonNegative,
  address: ActorAddress,
  command: Schema.String,
  payloadPreview: Schema.String,
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

/**
 * The runner refused admission without committing a command receipt; answered
 * 422. `reason` is the framework's own refusal, already taken out of the
 * runner's `ActorError` envelope, and `reasonTag` its tag.
 */
export class CommandRefused extends Schema.TaggedError<CommandRefused>()(
  "CommandRefused",
  {
    commandId: Schema.String,
    reasonTag: Schema.String,
    reason: Framework.ActorError.fields.reason,
  },
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
 * The organization's Free period quota cannot take the command's units;
 * answered 429. It carries the framework's `QuotaExceeded` payload, including
 * when the period resets as `retryAfterMs`.
 */
export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()(
  "QuotaExceeded",
  Struct.omit(Framework.QuotaExceeded.fields, ["_tag"]),
  { httpApiStatus: 429 },
) {}

/** The organization's estimated period cost would pass its spend limit; answered 402. */
export class SpendLimitExceeded extends Schema.TaggedError<SpendLimitExceeded>()(
  "SpendLimitExceeded",
  Struct.omit(Framework.SpendLimitExceeded.fields, ["_tag"]),
  { httpApiStatus: 402 },
) {}

/** The organization already holds every concurrent connection its plan allows; answered 429. */
export class ConnectionLimitExceeded extends Schema.TaggedError<ConnectionLimitExceeded>()(
  "ConnectionLimitExceeded",
  Struct.omit(Framework.ConnectionLimitExceeded.fields, ["_tag"]),
  { httpApiStatus: 429 },
) {}

/**
 * A Free tenant's latest storage sample is at or over its cap, so it takes no
 * new command until a lower sample arrives; answered 429.
 */
export class StorageQuotaExceeded extends Schema.TaggedError<StorageQuotaExceeded>()(
  "StorageQuotaExceeded",
  Struct.omit(Framework.StorageQuotaExceeded.fields, ["_tag"]),
  { httpApiStatus: 429 },
) {}

/** The edge's usage refusals of a new command, each with the framework's tag and payload. */
export const QuotaErrors = [
  QuotaExceeded,
  SpendLimitExceeded,
  ConnectionLimitExceeded,
  StorageQuotaExceeded,
] as const

export const JobTypeStats = Schema.Struct({
  jobName: Schema.String,
  done: NonNegativeInt,
  retried: NonNegativeInt,
  dead: NonNegativeInt,
  p99Ms: NonNegative,
})
export type JobTypeStats = typeof JobTypeStats.Type

export const JobsSummary = Schema.Struct({
  queued: NonNegativeInt,
  running: NonNegativeInt,
  retrying: NonNegativeInt,
  dead: NonNegativeInt,
  byType: Schema.Array(JobTypeStats),
  throughput: Schema.Array(SeriesPoint),
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
 * One workflow run. `step.index` counts from 1, so the first step is 1 and a
 * run showing "step n of m" has `index` n and `total` m; `index` never exceeds
 * `total`.
 */
export const Workflow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: ActorAddress,
  step: Schema.Struct({
    index: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    total: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    name: Schema.String,
  }).pipe(
    Schema.check(
      Schema.makeFilter(
        (step) => step.index <= step.total || "step.index must not exceed step.total",
      ),
    ),
  ),
  waitingFor: Schema.NullOr(
    Schema.Struct({ kind: Schema.Literals(["event", "timer"]), name: Schema.String }),
  ),
  startedAt: Timestamp,
  status: Schema.Literals(["running", "waiting", "completed", "failed"]),
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

/** A command-palette hit among the runtime's own data; pages and settings are searched client side. */
export const SearchResult = Schema.Struct({
  kind: Schema.Literals(["actor", "deployment"]),
  id: Schema.String,
  title: Schema.String,
  subtitle: Schema.NullOr(Schema.String),
})
export type SearchResult = typeof SearchResult.Type
