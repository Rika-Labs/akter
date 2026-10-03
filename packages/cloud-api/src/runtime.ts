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

export const Workflow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: ActorAddress,
  step: Schema.Struct({
    index: NonNegativeInt,
    total: NonNegativeInt,
    name: Schema.String,
  }),
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
