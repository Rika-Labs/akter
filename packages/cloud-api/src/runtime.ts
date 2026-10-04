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

/**
 * One environment's runtime at a glance: how many actors there are, the
 * pending jobs (`inFlight`, queued or waiting to retry) and the dead letters
 * by job name from the runners' durable views, and from the serving runner's
 * memory, while it is the only runner, the command rates and turn times
 * (`perSecond` over the current minute and the four before it, `series24h`
 * hourly since the runner began recording, `p50Ms` and `p99Ms` over the last
 * hour, null with no turn), the resident (`awake`) actors and the deepest
 * mailbox (`depth` 0 and `actor` null when none waits). Each nullable field is
 * null when the runners do not report it, never zero or empty: throughput and
 * p99 series, jobs done per hour and the runner, database, socket and
 * outbox-lag health. `lastDeployAt` is when the environment's newest
 * deployment was created, null when it has none. `recentDeployments` is null
 * here; the deployments list reports them with their rollout state.
 */
export const Overview = Schema.Struct({
  commands: Schema.NullOr(
    Schema.Struct({
      perSecond: NonNegative,
      series24h: Schema.Array(SeriesPoint),
      p50Ms: Schema.NullOr(NonNegative),
      p99Ms: Schema.NullOr(NonNegative),
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
 * One actor type and how many actors of it the runners hold. While one runner
 * serves the deployment, it reports how many of them are resident (`awake`),
 * the type's command rate over the current minute and the four before it, its
 * p99 turn time over the last hour (null with no turn) and its deepest
 * mailbox; otherwise those are null. The commands a type declares are not
 * reported, so `commands` is null, never empty.
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
 * Commands of one actor type over a window, as the serving runner counted the
 * turns that wrote a receipt. `series` is commands per second at evenly spaced
 * instants (minutes for `1h`, hours otherwise), oldest first, each the rate
 * over the part of its interval the runner observed; `commands` is the volume
 * of each command the type handled in the window, busiest first. `since` is
 * when the runner began recording: the window holds no point before it.
 */
export const ActorTypeActivity = Schema.Struct({
  window: SeriesWindow,
  since: Timestamp,
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

/**
 * How long the turns of one actor type took over a window, from their fenced
 * read to the database clock after `COMMIT`: buckets in ascending bound order
 * and the 50th, 95th and 99th percentile in milliseconds, each the bound of
 * the bucket it falls in capped by the slowest turn, and null when no turn
 * committed. `since` is when the serving runner began recording.
 */
export const TurnLatency = Schema.Struct({
  window: SeriesWindow,
  since: Timestamp,
  buckets: Schema.Array(LatencyBucket),
  p50Ms: Schema.NullOr(NonNegative),
  p95Ms: Schema.NullOr(NonNegative),
  p99Ms: Schema.NullOr(NonNegative),
})
export type TurnLatency = typeof TurnLatency.Type

/**
 * One actor of a type. `lastCommand` and `lastActivityAt` are the command and
 * commit time of its retained receipt with the newest recorded commit time,
 * null when none records one. `status` is whether it is resident on the
 * serving runner, null unless that runner is the only one.
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
 * its commit wrote it, on the database clock; null for a receipt written
 * before runners recorded it. A receipt is the committed turn itself, so
 * `replayed` is false unless the entry describes an answer served again from
 * the receipt.
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

/**
 * An event the actor emitted: the cursor and emission time of its newest
 * retained one, and its subscribers, the event feeds open on it that name the
 * event, null unless the serving runner is the only one.
 */
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
 * an entry does not decode. `timeline` is its newest timeline page. While one
 * runner serves the deployment, it reports whether the actor is resident
 * (`awake`), its open sockets, its mailbox depth (0 when idle), and, while it
 * is awake, the runner's name and region as the runner was configured. Every
 * other nullable field is null when the runner does not report it: the turn
 * count, owned-table rows, and those live fields with more than one runner.
 * A null is unknown, never zero or empty.
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
 * The command log is read from the runners' receipts: `at` is when the commit
 * wrote the receipt and `durationMs` the turn from its fenced read to that
 * write, both on the database clock and null for a receipt written before
 * runners recorded them; receipts keep no payload, so `payloadPreview` is
 * null there. The live stream sends each command as the serving runner
 * commits it, `at` read after `COMMIT` and `durationMs` through it, with a
 * preview of at most 256 characters that the runner cut and redacted. `caller`
 * is as in `Receipt`.
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

/**
 * The command stream missed commands: the serving runner no longer held what
 * came after the last one it sent, or this stream fell too far behind. It ends
 * the stream, so a client that reconnects knows it has a gap rather than
 * skipping entries unseen.
 */
export class CommandStreamGap extends Schema.TaggedError<CommandStreamGap>()(
  "CommandStreamGap",
  {},
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

/**
 * The edge refused a metered command because it cannot bill it: no
 * organization is bound to the deployment's tenant (`tenant`), the
 * organization has no billing account (`account`), or its stored plan is not
 * in the pricing configuration (`plan`); answered 402. It carries the edge's
 * own `QuotaUnbound` tag and payload. Retrying will not succeed until the
 * binding is fixed, which is why it is not an `Unavailable`.
 */
export class QuotaUnbound extends Schema.TaggedError<QuotaUnbound>()(
  "QuotaUnbound",
  {
    deployment: Schema.String,
    tenant: Schema.String,
    reason: Schema.Literals(["tenant", "account", "plan"]),
  },
  { httpApiStatus: 402 },
) {}

/**
 * The edge's usage refusals of a new command: the framework's four, each with
 * its tag and payload, and the edge's own `QuotaUnbound`.
 */
export const QuotaErrors = [
  QuotaExceeded,
  SpendLimitExceeded,
  ConnectionLimitExceeded,
  StorageQuotaExceeded,
  QuotaUnbound,
] as const

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

/**
 * One cron entry an actor type declares: `name` is the command it runs,
 * `actorPattern` the type's actors (`Type/*`) and `cron` the expression as the
 * runtime keys it. `nextRunAt` is the soonest pending tick of the tenant's
 * actors of the type, null when none holds one. `lastRun` is the newest tick
 * that committed, found among the type's newest 10,000 receipts, null when
 * none is there; its `durationMs` is null when the receipt holds no start.
 */
export const Schedule = Schema.Struct({
  name: Schema.String,
  actorPattern: Schema.String,
  cron: Schema.String,
  lastRun: Schema.NullOr(
    Schema.Struct({
      at: Timestamp,
      outcome: Schema.Literals(["ok", "error"]),
      durationMs: Schema.NullOr(NonNegative),
    }),
  ),
  nextRunAt: Schema.NullOr(Timestamp),
})
export type Schedule = typeof Schedule.Type

/**
 * The tenant's open connections on the serving runner, which reports them
 * only while it is the only runner: `open` counts every WebSocket session and
 * SSE response, `sseStreams` the SSE responses (event feeds, stream members
 * and query watches) and `feedSubscribers` the event feeds, overall and by
 * actor type. Runners do not measure parked connections, replay gaps or their
 * history, so `parked`, `replayGaps` and `openVersusParked` are null.
 */
export const ConnectionsSummary = Schema.Struct({
  open: NonNegativeInt,
  parked: Schema.NullOr(NonNegativeInt),
  sseStreams: NonNegativeInt,
  feedSubscribers: NonNegativeInt,
  replayGaps: Schema.NullOr(NonNegativeInt),
  openVersusParked: Schema.NullOr(
    Schema.Array(Schema.Struct({ at: Timestamp, open: NonNegativeInt, parked: NonNegativeInt })),
  ),
  byActorType: Schema.Array(
    Schema.Struct({
      actorType: Schema.String,
      open: NonNegativeInt,
      parked: Schema.NullOr(NonNegativeInt),
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
