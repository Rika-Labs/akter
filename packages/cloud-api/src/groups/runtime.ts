import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

import { ReadErrors, WriteErrors } from "../errors.ts"
import { DeadLetterId, EnvironmentName, Page, pageQuery, ProjectId } from "../primitives.ts"
import {
  ActorEvent,
  ActorInspector,
  ActorInstance,
  ActorJob,
  ActorTimelineEntry,
  ActorTypeSummary,
  CommandLogEntry,
  CommandOutcome,
  ConnectionsSummary,
  DeadLetter,
  JobsSummary,
  Overview,
  OwnedTableRows,
  Receipt,
  Schedule,
  SearchResult,
  SidebarCounts,
  TimersSummary,
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
    { params: actorParams, success: Schema.Array(ActorJob), error: ReadErrors },
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
