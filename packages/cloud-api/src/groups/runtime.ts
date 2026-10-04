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
      error: ReadErrors,
    },
  ),
  HttpApiEndpoint.get(
    "getSidebarCounts",
    "/projects/:projectId/environments/:environment/runtime/sidebar-counts",
    { params: environmentParams, success: SidebarCounts, error: ReadErrors },
  ),
  HttpApiEndpoint.get("search", "/projects/:projectId/environments/:environment/runtime/search", {
    params: environmentParams,
    query: { q: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256))) },
    success: Schema.Array(SearchResult),
    error: ReadErrors,
  }),
  HttpApiEndpoint.get(
    "listActorTypes",
    "/projects/:projectId/environments/:environment/runtime/actor-types",
    {
      params: environmentParams,
      success: Schema.Array(ActorTypeSummary),
      error: ReadErrors,
    },
  ),
  HttpApiEndpoint.get(
    "getActorType",
    "/projects/:projectId/environments/:environment/runtime/actor-types/:actorType",
    { params: actorTypeParams, success: ActorTypeSummary, error: ReadErrors },
  ),
  HttpApiEndpoint.get(
    "getActorTypeActivity",
    "/projects/:projectId/environments/:environment/runtime/actor-types/:actorType/activity",
    {
      params: actorTypeParams,
      query: { window: Schema.optional(SeriesWindow) },
      success: ActorTypeActivity,
      error: ReadErrors,
    },
  ).annotate(
    OpenApi.Description,
    "Commands per second over the window (default 24h) and the volume of each command, for one actor type.",
  ),
  HttpApiEndpoint.get(
    "getActorTypeLatency",
    "/projects/:projectId/environments/:environment/runtime/actor-types/:actorType/latency",
    {
      params: actorTypeParams,
      query: { window: Schema.optional(SeriesWindow) },
      success: TurnLatency,
      error: ReadErrors,
    },
  ).annotate(
    OpenApi.Description,
    "Turn-latency histogram over the window (default 24h) with p50, p95 and p99, for one actor type.",
  ),
  HttpApiEndpoint.get(
    "listActorInstances",
    "/projects/:projectId/environments/:environment/runtime/actor-types/:actorType/instances",
    {
      params: actorTypeParams,
      query: { ...pageQuery, status: Schema.optional(Schema.Literals(["awake", "idle"])) },
      success: Page(ActorInstance),
      error: ReadErrors,
    },
  ),
  HttpApiEndpoint.get(
    "inspectActor",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key",
    { params: actorParams, success: ActorInspector, error: ReadErrors },
  ),
  HttpApiEndpoint.get(
    "listActorTables",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/tables",
    { params: actorParams, success: Schema.Array(OwnedTableRows), error: ReadErrors },
  ),
  HttpApiEndpoint.get(
    "listActorReceipts",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/receipts",
    { params: actorParams, query: pageQuery, success: Page(Receipt), error: ReadErrors },
  ),
  HttpApiEndpoint.get(
    "listActorEvents",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/events",
    { params: actorParams, success: Schema.Array(ActorEvent), error: ReadErrors },
  ),
  HttpApiEndpoint.get(
    "listActorJobs",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/jobs",
    { params: actorParams, success: Schema.Array(ActorJob), error: [...ReadErrors, RunnerDefect] },
  ),
  HttpApiEndpoint.get(
    "listActorTimeline",
    "/projects/:projectId/environments/:environment/runtime/actors/:actorType/:key/timeline",
    { params: actorParams, query: pageQuery, success: Page(ActorTimelineEntry), error: ReadErrors },
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
      error: ReadErrors,
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
    "Sends to an actor address, including one not yet created, without requiring an inspector read. Requires project write permission. `commandId` is an optional client idempotency key, not a runner command id. Its scope is organization/project/environment/actor address/command, independent of deployment. The control plane durably assigns a runner-minted id and stores only a canonical payload hash; the same key and JSON input reuse it and replay the receipt with `replayed: true` within the runner's retry window. Different input returns 409 Conflict. After expiry, the key is retained as a tombstone for 30 days and returns 410 `CommandExpired`; reusing it after that starts a new command. Declared actor errors are 422 CommandFailed; admission refusals are typed 4xx, including 422 CommandRefused. Mailbox backpressure remains 503 Unavailable. Remote defects are opaque, non-retryable 502 RunnerDefect errors. The edge's usage refusals keep the framework's tags and payloads: a full Free command quota is a 429 `QuotaExceeded`, a passed spend limit a 402 `SpendLimitExceeded`, a full connection allowance a 429 `ConnectionLimitExceeded` and a Free tenant at its storage cap a 429 `StorageQuotaExceeded`.",
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
      error: ReadErrors,
    },
  ),
  HttpApiEndpoint.get("getJobs", "/projects/:projectId/environments/:environment/runtime/jobs", {
    params: environmentParams,
    success: JobsSummary,
    error: ReadErrors,
  }),
  HttpApiEndpoint.get(
    "listDeadLetters",
    "/projects/:projectId/environments/:environment/runtime/dead-letters",
    { params: environmentParams, query: pageQuery, success: Page(DeadLetter), error: ReadErrors },
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
      error: ReadErrors,
    },
  ),
  HttpApiEndpoint.get(
    "getTimers",
    "/projects/:projectId/environments/:environment/runtime/timers",
    {
      params: environmentParams,
      success: TimersSummary,
      error: ReadErrors,
    },
  ),
  HttpApiEndpoint.get(
    "listSchedules",
    "/projects/:projectId/environments/:environment/runtime/schedules",
    {
      params: environmentParams,
      success: Schema.Array(Schedule),
      error: ReadErrors,
    },
  ),
  HttpApiEndpoint.get(
    "getConnections",
    "/projects/:projectId/environments/:environment/runtime/connections",
    { params: environmentParams, success: ConnectionsSummary, error: ReadErrors },
  ),
) {}
