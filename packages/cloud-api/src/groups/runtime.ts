import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { ReadErrors, WriteErrors } from "../errors.ts"
import { DeadLetterId, EnvironmentName, Page, pageQuery, ProjectId } from "../primitives.ts"
import {
  ActorEvent,
  ActorInspector,
  ActorInstance,
  ActorJob,
  ActorTimelineEntry,
  ActorTypeActivity,
  ActorTypeSummary,
  CommandFailed,
  CommandExpired,
  CommandRefused,
  RunnerDefect,
  CommandLogEntry,
  CommandOutcome,
  CommandSent,
  ConnectionsSummary,
  DeadLetter,
  JobsSummary,
  Overview,
  OwnedTableRows,
  QuotaErrors,
  Receipt,
  Schedule,
  SearchResult,
  SendCommand,
  SeriesWindow,
  SidebarCounts,
  TimersSummary,
  TurnLatency,
  Workflow,
} from "../runtime.ts"

const environmentParams = { projectId: ProjectId, environment: EnvironmentName }
const actorTypeParams = { ...environmentParams, actorType: Schema.String }
const actorParams = { ...actorTypeParams, key: Schema.String }

/** A read the runner's inspector answers can also fail with the runner's own opaque defect. */
const InspectErrors = [...ReadErrors, RunnerDefect] as const

/**
 * Inspection of the runners serving one project environment. Every path sits
 * under `/projects/:projectId/environments/:environment/runtime`; actor keys
 * are URL-encoded path segments.
 */
export class RuntimeGroup extends HttpApiGroup.make("runtime").add(
  HttpApiEndpoint.get(
    "getOverview",
    "/projects/:projectId/environments/:environment/runtime/overview",
    {
      params: environmentParams,
      success: Overview,
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.get(
    "getSidebarCounts",
    "/projects/:projectId/environments/:environment/runtime/sidebar-counts",
    { params: environmentParams, success: SidebarCounts, error: InspectErrors },
  ),
  HttpApiEndpoint.get("search", "/projects/:projectId/environments/:environment/runtime/search", {
    params: environmentParams,
    query: { q: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256))) },
    success: Schema.Array(SearchResult),
    error: InspectErrors,
  }),
  HttpApiEndpoint.get(
    "listActorTypes",
    "/projects/:projectId/environments/:environment/runtime/actor-types",
    {
      params: environmentParams,
      success: Schema.Array(ActorTypeSummary),
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.get(
    "getActorType",
    "/projects/:projectId/environments/:environment/runtime/actor-types/:actorType",
    { params: actorTypeParams, success: ActorTypeSummary, error: InspectErrors },
  ),
  HttpApiEndpoint.get(
    "getActorTypeActivity",
    "/projects/:projectId/environments/:environment/runtime/actor-types/:actorType/activity",
    {
      params: actorTypeParams,
      query: { window: Schema.optional(SeriesWindow) },
      success: ActorTypeActivity,
      error: InspectErrors,
    },
  ).annotate(
    OpenApi.Description,
    "Commands per second over the window (default 24h) and the volume of each command, for one actor type, as the serving runner counted them since `since`. `NotImplemented` while more than one runner serves the environment.",
  ),
  HttpApiEndpoint.get(
    "getActorTypeLatency",
    "/projects/:projectId/environments/:environment/runtime/actor-types/:actorType/latency",
    {
      params: actorTypeParams,
      query: { window: Schema.optional(SeriesWindow) },
      success: TurnLatency,
      error: InspectErrors,
    },
  ).annotate(
    OpenApi.Description,
    "Turn-latency histogram over the window (default 24h) with p50, p95 and p99, for one actor type, as the serving runner measured them since `since`. `NotImplemented` while more than one runner serves the environment.",
  ),
  HttpApiEndpoint.get(
    "listActorInstances",
    "/projects/:projectId/environments/:environment/runtime/actor-types/:actorType/instances",
    {
      params: actorTypeParams,
      query: { ...pageQuery, status: Schema.optional(Schema.Literals(["awake", "idle"])) },
      success: Page(ActorInstance),
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.get(
    "inspectActor",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key",
    { params: actorParams, success: ActorInspector, error: InspectErrors },
  ),
  HttpApiEndpoint.get(
    "listActorTables",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/tables",
    { params: actorParams, success: Schema.Array(OwnedTableRows), error: ReadErrors },
  ),
  HttpApiEndpoint.get(
    "listActorReceipts",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/receipts",
    { params: actorParams, query: pageQuery, success: Page(Receipt), error: InspectErrors },
  ),
  HttpApiEndpoint.get(
    "listActorEvents",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/events",
    { params: actorParams, success: Schema.Array(ActorEvent), error: InspectErrors },
  ),
  HttpApiEndpoint.get(
    "listActorJobs",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/jobs",
    { params: actorParams, success: Schema.Array(ActorJob), error: InspectErrors },
  ),
  HttpApiEndpoint.get(
    "listActorTimeline",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/timeline",
    {
      params: actorParams,
      query: pageQuery,
      success: Page(ActorTimelineEntry),
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.get(
    "listCommands",
    "/projects/:projectId/environments/:environment/runtime/commands",
    {
      params: environmentParams,
      query: {
        ...pageQuery,
        actorType: Schema.optional(Schema.String),
        outcome: Schema.optional(CommandOutcome),
      },
      success: Page(CommandLogEntry),
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.post(
    "sendCommand",
    "/projects/:projectId/environments/:environment/runtime/commands",
    {
      params: environmentParams,
      payload: SendCommand,
      success: CommandSent,
      error: [
        ...WriteErrors,
        CommandFailed,
        CommandRefused,
        CommandExpired,
        RunnerDefect,
        ...QuotaErrors,
      ],
    },
  ).annotate(
    OpenApi.Description,
    "Sends to an actor address, including one not yet created, without requiring an inspector read. Requires project write permission. `commandId` is an optional client idempotency key, not a runner command id. Its scope is organization/project/environment/actor address/command, independent of deployment. The control plane durably assigns a runner-minted id and stores only a canonical payload hash; the same key and JSON input reuse it and replay the receipt with `replayed: true` within the runner's retry window. Different input returns 409 Conflict. After expiry, the key is retained as a tombstone for 30 days and returns 410 `CommandExpired`; reusing it after that starts a new command. Declared actor errors are 422 CommandFailed; admission refusals are typed 4xx, including 422 CommandRefused. Mailbox backpressure remains 503 Unavailable. Remote defects are opaque, non-retryable 502 RunnerDefect errors. The edge's usage refusals keep the framework's tags and payloads: a full Free command quota is a 429 `QuotaExceeded`, a passed spend limit a 402 `SpendLimitExceeded`, a full connection allowance a 429 `ConnectionLimitExceeded` and a Free tenant at its storage cap a 429 `StorageQuotaExceeded`. A command the edge cannot bill, because the tenant has no organization, the organization no billing account, or its plan is not in the pricing configuration, is a 402 `QuotaUnbound` carrying that reason, never a generic 503.",
  ),
  HttpApiEndpoint.get(
    "streamCommands",
    "/projects/:projectId/environments/:environment/runtime/commands/stream",
    {
      params: environmentParams,
      query: {
        actorType: Schema.optional(Schema.String),
        outcome: Schema.optional(CommandOutcome),
      },
      success: HttpApiSchema.StreamSse({ data: Schema.toCodecJson(CommandLogEntry) }),
      error: InspectErrors,
    },
  ).annotate(
    OpenApi.Description,
    "Each command the serving runner commits from now on, filtered by actor type and outcome (`replayed` is always empty, since a replay commits no turn), with a payload preview of at most 256 characters that the runner cut and redacted. The control plane resumes across the runner's credential expiry; the stream ends when the runner can no longer resume it without a gap, or the runner goes away, and a client reconnects. `NotImplemented` while more than one runner serves the environment.",
  ),
  HttpApiEndpoint.get("getJobs", "/projects/:projectId/environments/:environment/runtime/jobs", {
    params: environmentParams,
    success: JobsSummary,
    error: InspectErrors,
  }),
  HttpApiEndpoint.get(
    "listDeadLetters",
    "/projects/:projectId/environments/:environment/runtime/dead-letters",
    {
      params: environmentParams,
      query: pageQuery,
      success: Page(DeadLetter),
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.post(
    "retryDeadLetter",
    "/projects/:projectId/environments/:environment/runtime/dead-letters/:deadLetterId/retry",
    {
      params: { ...environmentParams, deadLetterId: DeadLetterId },
      error: WriteErrors,
    },
  ),
  HttpApiEndpoint.post(
    "discardDeadLetter",
    "/projects/:projectId/environments/:environment/runtime/dead-letters/:deadLetterId/discard",
    {
      params: { ...environmentParams, deadLetterId: DeadLetterId },
      error: WriteErrors,
    },
  ),
  HttpApiEndpoint.get(
    "listWorkflows",
    "/projects/:projectId/environments/:environment/runtime/workflows",
    {
      params: environmentParams,
      query: {
        ...pageQuery,
        status: Schema.optional(Schema.Literals(["running", "waiting", "completed", "failed"])),
      },
      success: Page(Workflow),
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.get(
    "getTimers",
    "/projects/:projectId/environments/:environment/runtime/timers",
    {
      params: environmentParams,
      success: TimersSummary,
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.get(
    "listSchedules",
    "/projects/:projectId/environments/:environment/runtime/schedules",
    {
      params: environmentParams,
      success: Schema.Array(Schedule),
      error: InspectErrors,
    },
  ),
  HttpApiEndpoint.get(
    "getConnections",
    "/projects/:projectId/environments/:environment/runtime/connections",
    { params: environmentParams, success: ConnectionsSummary, error: InspectErrors },
  ),
) {}
