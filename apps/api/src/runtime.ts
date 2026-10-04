import {
  type ActorEvent,
  type ActorInspector,
  type ActorJob,
  type ActorTimelineEntry,
  CloudApi,
  type CommandCaller,
  type CommandLogEntry,
  DeadLetterId,
  type Receipt,
  type Workflow,
  CurrentIdentity,
  CommandFailed,
  CommandExpired,
  CommandRefused,
  Conflict,
  Forbidden,
  NotFound,
  NotImplemented,
  RunnerDefect,
  Unavailable,
} from "@akter/cloud-api"
import {
  Context,
  DateTime,
  type Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { HttpApiBuilder } from "effect/http-api"
import { Inspection } from "@rikalabs/akter/client"
import { Access, attributedSubject } from "./access.ts"
import { commandPayloadHash, Repository } from "./repository.ts"

/**
 * Where and as whom the control plane reaches one environment's runners: the
 * edge's address, the deployment host the edge routes on, and a credential the
 * edge authenticates for that deployment (a hosted API key or a JWT). It is
 * the only credential a request here carries; the edge replaces it with its
 * own signed assertion, so neither this credential nor the console caller's
 * session or API key ever reaches a runner, and the API holds no runner
 * address and no signing key.
 */
export interface RuntimeTarget {
  readonly origin: string
  readonly host: string
  readonly credential: Redacted.Redacted<string>
  /** The tenant the credential acts in, which is the tenant whose actors it inspects. */
  readonly tenant: string
  /** Where the runners serve `Inspector.serve`. Default `/inspector`. */
  readonly inspectorPath?: string
  readonly requestTimeout?: Duration.Input
}

/** Resolves a project environment to the edge target that serves it, or `NotFound`. */
export class RuntimeEdge extends Context.Service<
  RuntimeEdge,
  {
    readonly resolve: (input: {
      readonly organizationId: string
      readonly projectId: string
      readonly environment: string
    }) => Effect.Effect<RuntimeTarget, NotFound>
  }
>()("@akter/api/runtime/RuntimeEdge") {
  static layer = (resolve: RuntimeEdge["Service"]["resolve"]) =>
    Layer.succeed(RuntimeEdge, RuntimeEdge.of({ resolve }))
}

/** A request the edge could not complete as the runtime's own answer: its refusal, outage or a defect. */
const unavailable = (what: string) => Effect.die(new Error(`Runtime request failed: ${what}`))

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** The framework's refusals the control plane tells apart; any other reason is an outage or a defect. */
const Reason = Schema.Union([
  Schema.TaggedStruct("NotCreated", {}),
  Schema.TaggedStruct("CommandConflict", {}),
  Schema.TaggedStruct("CommandExpired", {}),
  Schema.TaggedStruct("Unauthorized", { code: Schema.String }),
  Schema.TaggedStruct("InvalidInput", { code: Schema.String }),
])

const ActorErrorBody = Schema.TaggedStruct("ActorError", { reason: Reason })
const GenericActorErrorBody = Schema.TaggedStruct("ActorError", {
  reason: Schema.Struct({ _tag: Schema.String }),
})

const DefectBody = Schema.TaggedStruct("Defect", {})

const CommandId = Schema.Struct({ commandId: Schema.String })

const Job = Schema.Struct({ job: Schema.String, jobId: Schema.String, attempts: Schema.Finite })

const ActorJobs = Schema.Struct({ jobs: Schema.Array(Job), deadLetters: Schema.Array(Job) })

const decodeActorError = Schema.decodeUnknownOption(ActorErrorBody)
const decodeGenericActorError = Schema.decodeUnknownOption(GenericActorErrorBody)
const decodeCommandId = Schema.decodeUnknownEffect(CommandId)

/** The most rows the runners' inspector returns for one list. */
const INSPECTOR_ROWS = 500

/** The rows a runtime page holds when the caller names no limit. */
const PAGE_ROWS = 50

/** The most actors a search answers with. */
const SEARCH_ROWS = 20

/** The most pages read to collect one whole list; past it the runner is misbehaving. */
const MAX_PAGES = 100

const isJsonArray = Schema.is(Schema.Array(Schema.Json))

/**
 * Whom a receipt's command ran as, from the runner's caller key: the JSON
 * array `["User", subject]`, `["Anonymous"]` or `["System", source, ref,
 * onBehalfOf, mint?]`. A key that does not decode is null.
 */
const callerOf = (key: Inspection.Decoded | null): CommandCaller | null => {
  if (key === null || !("json" in key) || !isJsonArray(key.json)) return null

  const [tag, first, , onBehalfOf] = key.json

  if (tag === "User" && Predicate.isString(first))
    return { kind: "user", subject: first, source: null }
  if (tag === "Anonymous") return { kind: "anonymous", subject: null, source: null }
  if (tag === "System" && Predicate.isString(first))
    return {
      kind: "system",
      subject: Predicate.isString(onBehalfOf) ? onBehalfOf : null,
      source: first,
    }

  return null
}

const DeclaredFailure = Schema.TaggedStruct("Failure", {
  value: Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
})

const decodeFailure = Schema.decodeUnknownOption(DeclaredFailure)

/** The tag of the declared error a failed receipt stores, or null when it has none. */
const errorTagOf = (outcome: Inspection.Decoded | null | undefined) =>
  outcome == null || !("json" in outcome)
    ? null
    : Option.match(decodeFailure(outcome.json), {
        onNone: () => null,
        onSome: (failure) => failure.value._tag,
      })

const instant = (epochMillis: number) => DateTime.makeUnsafe(epochMillis)

/** A receipt as the console reads it: its outcome tag, whom it ran as and when it expires. */
const receiptOf = (receipt: Inspection.ReceiptRow): Receipt => ({
  commandId: receipt.commandId,
  command: receipt.command,
  result: receipt.outcomeTag,
  caller: callerOf(receipt.callerKey),
  at: null,
  expiresAt: instant(receipt.expiresAtMs),
  replayed: false,
})

const timelineOf = (entry: Inspection.TimelineRow): ActorTimelineEntry => ({
  at: instant(entry.atMs),
  kind: entry.kind,
  label: entry.name,
  detail: entry.commandId,
  caller: callerOf(entry.callerKey),
})

const eventOf = (event: Inspection.LatestEventRow): ActorEvent => ({
  name: event.event,
  cursor: String(event.sequence),
  emittedAt: instant(event.emittedAtMs),
  subscribers: null,
})

/**
 * One workflow run as the console reads it. The step is the one the run
 * started last, numbered by the distinct steps it has recorded; the runner
 * does not know how many steps the workflow has. A suspended run waits on its
 * unsettled clock step (a timer) or wait step (an event). A finished run
 * completed when its stored result is a success and failed otherwise; its
 * status is null when the result does not decode.
 */
const workflowOf = (row: Inspection.WorkflowRow): Workflow => {
  const names: Array<string> = []

  for (const step of row.steps.toSorted((left, right) => left.startedAtMs - right.startedAtMs))
    if (!names.includes(step.step)) names.push(step.step)

  const last = row.steps.reduce<Inspection.StepRow | undefined>(
    (latest, step) =>
      latest === undefined || step.startedAtMs >= latest.startedAtMs ? step : latest,
    undefined,
  )

  const pending = row.steps.find((step) => step.settledAtMs === null)

  const waitingFor: Workflow["waitingFor"] =
    row.status !== "suspended" || pending === undefined
      ? null
      : pending.kind === "clock"
        ? { kind: "timer", name: pending.step }
        : pending.kind === "wait"
          ? { kind: "event", name: pending.waitEvent ?? pending.step }
          : null

  const status: Workflow["status"] =
    row.status === "running"
      ? "running"
      : row.status === "suspended"
        ? "waiting"
        : row.status === "finished" &&
            row.result !== null &&
            "json" in row.result &&
            isTaggedJson(row.result.json)
          ? Predicate.isTagged(row.result.json, "Success")
            ? "completed"
            : "failed"
          : null

  return {
    id: row.executionId,
    name: row.workflow,
    actor: `${row.actorType}/${row.actorId}`,
    step:
      last === undefined
        ? null
        : { index: names.indexOf(last.step) + 1, total: null, name: last.step },
    waitingFor,
    startedAt: instant(row.startedAtMs),
    status,
  }
}

const isTaggedJson = Schema.is(Schema.Struct({ _tag: Schema.String }))

/**
 * A stored failure cause as a tenant may read it: its first line, the error's
 * tag and message, without the stack frames or file paths the runner's
 * pretty-printed cause carries, which name the deployment's own files.
 */
export const redactCause = (cause: string) =>
  (cause.split("\n").find((line) => line.trim() !== "") ?? "")
    .replace(/\s+at\s+\(?(?:file:\/\/)?\/\S*/gu, "")
    .replace(/\(?(?:file:\/\/)?(?:\/[\w.@+-]+){2,}\.[cm]?[jt]sx?(?::\d+){0,2}\)?/gu, "")
    .replace(/:\s*$/u, "")
    .trim()

/** A page cursor the console passes back: the runner's own `next`, opaque to the caller. */
const cursorOf = (next: Schema.Json | null) =>
  next === null ? null : Buffer.from(JSON.stringify(next), "utf8").toString("base64url")

/** An epoch millisecond or event sequence a cursor carries; the inspector refuses anything else. */
const Position = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

const ReceiptCursor = Schema.Struct({
  actorType: Schema.String,
  actorId: Schema.String,
  expiresAtMs: Position,
  commandId: Schema.String,
})

/** The cursor a caller passed back, decoded as `schema`, or `NotFound` for one this API did not issue. */
const cursor = <A, I>(schema: Schema.Codec<A, I>, value: string | undefined) =>
  Effect.map(
    value === undefined
      ? Effect.succeedNone
      : Schema.decodeEffect(Schema.fromJsonString(schema))(
          Buffer.from(value, "base64url").toString("utf8"),
        ).pipe(
          Effect.asSome,
          Effect.mapError(() => NotFound.make({ resource: "cursor", id: value })),
        ),
    Option.getOrUndefined,
  )

const receiptParams = (after: typeof ReceiptCursor.Type | undefined) =>
  after === undefined
    ? {}
    : {
        afterExpiresAtMs: String(after.expiresAtMs),
        afterType: after.actorType,
        afterId: after.actorId,
        afterCommandId: after.commandId,
      }

/**
 * The header naming whom a control-plane command acts for. The edge honors it
 * only on the control plane's own service credential and strips it from
 * every request, so a tenant can never choose the caller a runner sees.
 */
export const ON_BEHALF_OF_HEADER = "akter-on-behalf-of"

/** The state entry the runtime keeps for the state schema's migration version, which is not part of the actor's state. */
const STATE_VERSION_KEY = "$version"

/** Pending jobs as queued or retrying by their attempts, then dead letters as dead. */
const jobsOf = (detail: typeof ActorJobs.Type): Array<ActorJob> => [
  ...detail.jobs.map((job): ActorJob => ({
    name: job.job,
    id: job.jobId,
    attempts: job.attempts,
    status: job.attempts === 0 ? "queued" : "retrying",
  })),
  ...detail.deadLetters.map((job): ActorJob => ({
    name: job.job,
    id: job.jobId,
    attempts: job.attempts,
    status: "dead",
  })),
]

/**
 * The committed state as one object of its stored entries, or null when any
 * entry does not decode, since a partial object would misstate the state.
 */
const stateOf = (entries: Inspection.ActorDetail["state"]): Schema.Json => {
  const state: Record<string, Schema.Json> = {}

  for (const { key, value } of entries) {
    if (key === STATE_VERSION_KEY) continue
    if (value === null || !("json" in value)) return null
    state[key] = value.json
  }

  return state
}

/**
 * One actor's inspector page as the console contract states it. The runner's
 * inspector reads only the durable views, which hold no turn count, owned
 * rows, subscriber or socket counts, activation, placement on a runner or
 * mailbox, and keep no commit time on a receipt, so those are null. Each
 * event name keeps its newest retained cursor and emission time, read like
 * the event list so no name older than the detail's newest events is lost,
 * the event feed's cursor is the actor's last event sequence, and the
 * timeline is its newest page.
 */
const toInspector = (
  address: string,
  tenant: string,
  detail: Inspection.ActorDetail,
  events: ReadonlyArray<ActorEvent>,
  timeline: ReadonlyArray<Inspection.TimelineRow>,
): ActorInspector => ({
  address,
  state: stateOf(detail.state),
  turn: null,
  tables: null,
  receipts: detail.receipts.map(receiptOf),
  events,
  jobs: jobsOf(detail),
  connections: {
    sockets: null,
    feedCursor: detail.actor.lastEventSequence > 0 ? String(detail.actor.lastEventSequence) : null,
  },
  properties: {
    status: null,
    type: detail.actor.actorType,
    generation: detail.actor.generation,
    runner: null,
    region: null,
    tenant,
    mailboxDepth: null,
  },
  timeline: timeline.map(timelineOf),
})

const split = (address: string) => {
  const slash = address.indexOf("/")

  return { type: address.slice(0, slash), id: address.slice(slash + 1) }
}

/**
 * The requests the control plane makes of a runner, all through the edge.
 * Each carries only the target's own credential, so a caller's credentials
 * cannot leak into one by being copied from the console request.
 */
export const makeRuntime = Effect.gen(function* () {
  const edge = yield* RuntimeEdge
  const client = yield* HttpClient.HttpClient
  const repository = yield* Repository

  const call = Effect.fn("Runtime.call")(function* (
    target: RuntimeTarget,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* client
      .execute(
        request.pipe(
          HttpClientRequest.setHeaders({
            host: target.host,
            authorization: `Bearer ${Redacted.value(target.credential)}`,
          }),
        ),
      )
      .pipe(
        Effect.timeout(target.requestTimeout ?? "35 seconds"),
        Effect.catch(() =>
          Unavailable.make({
            message: "The deployment could not be reached",
            retryAfterSeconds: 1,
          }),
        ),
      )

    const text = yield* response.text.pipe(Effect.catch(() => unavailable("body")))
    const body = Option.getOrUndefined(decodeJson(text))
    if (Schema.is(DefectBody)(body)) return yield* RunnerDefect.make({})

    if ([502, 503, 504].includes(response.status))
      return yield* Unavailable.make({
        message: "The deployment is temporarily unavailable",
        retryAfterSeconds: 1,
      })

    return {
      status: response.status,
      body,
      replayed: response.headers["durable-replayed"],
    }
  })

  const url = (target: RuntimeTarget, path: string) => `${target.origin.replace(/\/+$/, "")}${path}`

  /**
   * One inspector read decoded as `schema`, or `undefined` when the inspector
   * answers 404, which it does for an actor the tenant does not have.
   */
  const read = <A, I>(
    target: RuntimeTarget,
    path: string,
    params: Readonly<Record<string, string | undefined>>,
    schema: Schema.Codec<A, I>,
  ) =>
    Effect.gen(function* () {
      const { status, body } = yield* call(
        target,
        HttpClientRequest.get(url(target, `${target.inspectorPath ?? "/inspector"}${path}`)).pipe(
          HttpClientRequest.setUrlParams(
            Object.fromEntries(
              Object.entries(params).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          ),
        ),
      )

      if (status === 404) return undefined

      if (status !== 200) return yield* unavailable(`inspector ${path} answered ${status}`)

      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.orDie)
    })

  /** An inspector read that names no actor, so a 404 is the runner misbehaving. */
  const readAll = <A, I>(
    target: RuntimeTarget,
    path: string,
    params: Readonly<Record<string, string | undefined>>,
    schema: Schema.Codec<A, I>,
  ) =>
    read(target, path, params, schema).pipe(
      Effect.filterOrElse(
        (found): found is A => found !== undefined,
        () => unavailable(`inspector ${path} answered 404`),
      ),
    )

  /** Every page of a list keyed by name, read `INSPECTOR_ROWS` at a time. */
  const everyName = <Page extends { readonly next: string | null }, I, Row>(
    target: RuntimeTarget,
    path: string,
    params: Readonly<Record<string, string | undefined>>,
    schema: Schema.Codec<Page, I>,
    rows: (page: Page) => ReadonlyArray<Row>,
  ) =>
    Effect.gen(function* () {
      const all: Array<Row> = []
      let after: string | undefined

      for (let page = 0; page < MAX_PAGES; page++) {
        const found = yield* readAll(
          target,
          path,
          { ...params, after, limit: String(INSPECTOR_ROWS) },
          schema,
        )
        all.push(...rows(found))

        if (found.next === null) return all

        after = found.next
      }

      return yield* unavailable(`inspector ${path} had more than ${MAX_PAGES} pages`)
    })

  const sendCommand = Effect.fn("Runtime.sendCommand")(function* (input: {
    readonly organizationId: string
    readonly projectId: string
    readonly environment: string
    readonly address: string
    readonly command: string
    readonly payload: Schema.Json
    readonly commandId?: string | undefined
    /** The control-plane identity the command is attributed to, such as `user:<id>`. */
    readonly onBehalfOf: string
  }) {
    const target = yield* edge.resolve(input)
    const { type, id } = split(input.address)

    const mint = call(target, HttpClientRequest.post(url(target, "/command-ids"))).pipe(
      Effect.flatMap(({ status, body }) => {
        if (status === 200) return decodeCommandId(body).pipe(Effect.orDie)
        const refusal = Option.getOrUndefined(decodeActorError(body))?.reason
        if (refusal?._tag === "Unauthorized")
          return Unavailable.make({
            message: "The deployment could not authorize the request",
            retryAfterSeconds: 1,
          })
        return unavailable(`command id mint answered ${status}`)
      }),
    )

    const clientKey = input.commandId
    let commandId: string
    if (clientKey === undefined) commandId = (yield* mint).commandId
    else {
      const key = {
        organizationId: input.organizationId,
        projectId: input.projectId,
        environment: input.environment,
        address: input.address,
        command: input.command,
        commandId: clientKey,
      }
      let assigned = yield* repository.findCommand(key)
      const payloadHash = commandPayloadHash(input.payload)
      if (assigned?.expired === true) return yield* CommandExpired.make({ commandId: clientKey })
      if (assigned === undefined) {
        const minted = yield* mint
        const expiresAt = Number(minted.commandId.split(".")[2])
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)
          return yield* unavailable("minted command id has no expiry")
        assigned = yield* repository.assignCommand({
          ...key,
          payloadHash,
          mintedCommandId: minted.commandId,
          expiresAt,
        })
        if (assigned.expired) return yield* CommandExpired.make({ commandId: clientKey })
      }
      if (assigned.payloadHash !== payloadHash)
        return yield* Conflict.make({
          message: "The idempotency key was already used for another payload",
        })
      if (assigned.commandId === null)
        return yield* unavailable("an active command assignment has no receipt reference")
      commandId = assigned.commandId
    }

    const {
      status,
      body,
      replayed: marker,
    } = yield* call(
      target,
      HttpClientRequest.post(
        url(
          target,
          `/actors/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${encodeURIComponent(input.command)}`,
        ),
        { headers: { "idempotency-key": commandId, [ON_BEHALF_OF_HEADER]: input.onBehalfOf } },
      ).pipe(HttpClientRequest.bodyJsonUnsafe(input.payload)),
    )

    const replayed = marker === "true"
    if (status >= 200 && status < 300) {
      if (marker !== "true" && marker !== "false")
        return yield* unavailable("authoritative replay metadata is missing")
      return { commandId, result: body ?? null, replayed }
    }

    const refusal = Option.getOrUndefined(decodeActorError(body))?.reason

    if (refusal === undefined) {
      const generic = Option.getOrUndefined(decodeGenericActorError(body))
      if (generic?.reason._tag === "MailboxFull")
        return yield* Unavailable.make({
          message: "The actor mailbox is temporarily full",
          retryAfterSeconds: 1,
        })

      if (generic !== undefined && status >= 400 && status < 500)
        return yield* CommandRefused.make({
          commandId,
          reasonTag: generic.reason._tag,
          reason: body,
        })

      if (
        Predicate.isTagged(body, "ActorError") ||
        !Predicate.hasProperty(body, "_tag") ||
        !Predicate.isString(body._tag)
      )
        return yield* unavailable(`command answered ${status}`)

      if (marker !== "true" && marker !== "false")
        return yield* unavailable("authoritative replay metadata is missing")

      return yield* CommandFailed.make({
        commandId,
        errorTag: body._tag,
        error: body,
        replayed,
      })
    }

    return yield* Match.value(refusal).pipe(
      Match.tagsExhaustive({
        NotCreated: () => NotFound.make({ resource: "actor", id: input.address }),
        CommandConflict: () =>
          Conflict.make({
            message: `The command id ${commandId} was already used for another command`,
          }),
        CommandExpired: () => CommandExpired.make({ commandId: clientKey ?? commandId }),
        Unauthorized: ({ code }) =>
          code === "access_denied" || code === "receipt_access_denied"
            ? Forbidden.make({ message: "The actor refused the command" })
            : Unavailable.make({
                message: "The deployment could not authorize the request",
                retryAfterSeconds: 1,
              }),
        InvalidInput: ({ code }) =>
          code === "unknown_route"
            ? NotFound.make({ resource: "command", id: `${input.address}/${input.command}` })
            : CommandRefused.make({ commandId, reasonTag: "InvalidInput", reason: body }),
      }),
    )
  })

  const actorJobs = Effect.fn("Runtime.actorJobs")(function* (input: {
    readonly organizationId: string
    readonly projectId: string
    readonly environment: string
    readonly address: string
  }) {
    const { type, id } = split(input.address)

    const found = yield* read(
      yield* edge.resolve(input),
      "/actor",
      { type, id, limit: String(INSPECTOR_ROWS) },
      ActorJobs,
    )

    if (found === undefined) return yield* NotFound.make({ resource: "actor", id: input.address })

    return jobsOf(found)
  })

  /**
   * The newest retained event of each name one actor emitted, every page of
   * it, or `undefined` when the tenant has no such actor.
   */
  const latestEvents = Effect.fn("Runtime.latestEvents")(function* (
    target: RuntimeTarget,
    type: string,
    id: string,
  ) {
    const events: Array<ActorEvent> = []
    let after: string | undefined

    for (let page = 0; page < MAX_PAGES; page++) {
      const found = yield* read(
        target,
        "/latest-events",
        { type, id, after, limit: String(INSPECTOR_ROWS) },
        Inspection.LatestEventsPage,
      )

      if (found === undefined) return undefined

      events.push(...found.events.map(eventOf))

      if (found.next === null) return events

      after = found.next
    }

    return yield* unavailable(`inspector /latest-events had more than ${MAX_PAGES} pages`)
  })

  const inspectActor = Effect.fn("Runtime.inspectActor")(function* (input: {
    readonly organizationId: string
    readonly projectId: string
    readonly environment: string
    readonly address: string
  }) {
    const target = yield* edge.resolve(input)
    const { type, id } = split(input.address)
    const params = { type, id, limit: String(INSPECTOR_ROWS) }
    const found = yield* read(target, "/actor", params, Inspection.ActorDetail)

    if (found === undefined) return yield* NotFound.make({ resource: "actor", id: input.address })

    const events = yield* latestEvents(target, type, id)
    const timeline = yield* read(
      target,
      "/timeline",
      { ...params, limit: String(PAGE_ROWS) },
      Inspection.TimelinePage,
    )

    return toInspector(input.address, target.tenant, found, events ?? [], timeline?.entries ?? [])
  })

  return {
    sendCommand,
    actorJobs,
    inspectActor,
    latestEvents,
    read,
    readAll,
    everyName,
  }
})

const notImplemented = (operation: string) => Effect.fail(NotImplemented.make({ operation }))

const ActorCursor = Schema.Struct({ actorType: Schema.String, actorId: Schema.String })

const TimelineCursor = Schema.Struct({
  sequence: Position,
  kind: Schema.Literals(["command", "event"]),
})

const DeadLetterCursor = Schema.Struct({ deadAtMs: Position, jobId: Schema.String })

const WorkflowCursor = Schema.Struct({ startedAtMs: Position, executionId: Schema.String })

/** The inspector status a console workflow status reads. */
const inspectorStatus = {
  running: "running",
  waiting: "suspended",
  completed: "completed",
  failed: "failed",
} as const

const decodeDeadLetterId = Schema.decodeUnknownEffect(DeadLetterId)

/**
 * The console's runtime endpoints, answered by asking runners through the
 * edge after the caller's project access is established: reads need read
 * permission and `sendCommand` write permission. Reads come from the runner's
 * read-only inspector over its durable views, so each field those views do not
 * hold is null and each endpoint that needs nothing else stays
 * `NotImplemented` rather than answer with invented numbers: rates,
 * latencies, the live stream, connections, schedules, owned-table rows, and
 * retrying or discarding a dead letter, which no runner route the control
 * plane can reach performs. A command is attributed to the signed-in user or
 * API key that sent it, after the control plane has authorized it.
 */
export const RuntimeLive = HttpApiBuilder.group(CloudApi, "runtime", (handlers) =>
  Effect.gen(function* () {
    const access = yield* Access
    const edge = yield* RuntimeEdge
    const runtime = yield* makeRuntime
    const sql = yield* SqlClient.SqlClient

    const environment = (params: { readonly projectId: string; readonly environment: string }) =>
      access
        .project(params.projectId)
        .pipe(Effect.flatMap((organizationId) => edge.resolve({ ...params, organizationId })))

    const allowed = (params: { readonly projectId: string }, operation: string) =>
      access.project(params.projectId).pipe(Effect.andThen(notImplemented(operation)))

    const actorTypes = (target: RuntimeTarget, type?: string) =>
      runtime.everyName(
        target,
        "/actor-types",
        { type },
        Inspection.ActorTypesPage,
        (page) => page.actorTypes,
      )

    const jobTypes = (target: RuntimeTarget) =>
      runtime.everyName(target, "/job-types", {}, Inspection.JobTypesPage, (page) => page.jobTypes)

    const overview = (target: RuntimeTarget) =>
      runtime.readAll(target, "/overview", {}, Inspection.Overview)

    const summaryOf = (row: Inspection.ActorTypeRow) => ({
      name: row.actorType,
      commands: null,
      instances: row.actors,
      awake: null,
      commandsPerSecond: null,
      p99Ms: null,
      maxMailbox: null,
    })

    const actorPage = <A, I>(
      target: RuntimeTarget,
      params: { readonly actorType: string; readonly key: string },
      path: string,
      extra: Readonly<Record<string, string | undefined>>,
      schema: Schema.Codec<A, I>,
    ) =>
      Effect.gen(function* () {
        const found = yield* runtime.read(
          target,
          path,
          { type: params.actorType, id: params.key, ...extra },
          schema,
        )

        if (found === undefined)
          return yield* NotFound.make({
            resource: "actor",
            id: `${params.actorType}/${params.key}`,
          })

        return found
      })

    return handlers
      .handle("getOverview", ({ params }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId)
          const target = yield* edge.resolve({ ...params, organizationId })
          const { counts } = yield* overview(target)
          const jobs = yield* jobTypes(target)
          const [deployed] = yield* sql<{ at: Date | null }>`
            SELECT max(created_at) AS at FROM deployment_rollout
            WHERE organization_id = ${organizationId} AND tenant_id = ${organizationId}
              AND project_id = ${params.projectId} AND environment = ${params.environment}`.pipe(
            Effect.orDie,
          )

          return {
            commands: null,
            actors: { awake: null, total: counts.actors },
            jobs: { inFlight: counts.jobs, donePerHour: null },
            deadLettersByJobType: jobs.flatMap((job) =>
              job.deadLetters === 0 ? [] : [{ jobName: job.job, count: job.deadLetters }],
            ),
            throughput: null,
            p99: null,
            health: {
              runners: null,
              databaseCpuPercent: null,
              maxMailbox: null,
              parkedSockets: null,
              outboxLagP99Ms: null,
              lastDeployAt: deployed?.at == null ? null : DateTime.fromDateUnsafe(deployed.at),
            },
            recentDeployments: null,
          }
        }),
      )
      .handle("getSidebarCounts", ({ params }) =>
        Effect.gen(function* () {
          const target = yield* environment(params)

          return {
            actorTypes: (yield* actorTypes(target)).length,
            openDeadLetters: (yield* overview(target)).counts.deadLetters,
          }
        }),
      )
      .handle("search", ({ params, query }) =>
        Effect.gen(function* () {
          const target = yield* environment(params)
          const types = yield* runtime.readAll(
            target,
            "/actor-types",
            { prefix: query.q, limit: String(SEARCH_ROWS) },
            Inspection.ActorTypesPage,
          )
          const found = yield* runtime.readAll(
            target,
            "/actors",
            { prefix: query.q, limit: String(SEARCH_ROWS) },
            Inspection.ActorsPage,
          )

          return [
            ...types.actorTypes.map((type) => ({
              kind: "actor-type" as const,
              id: type.actorType,
              title: type.actorType,
              subtitle: null,
            })),
            ...found.actors.map((actor) => ({
              kind: "actor" as const,
              id: `${actor.actorType}/${actor.actorId}`,
              title: `${actor.actorType}/${actor.actorId}`,
              subtitle: null,
            })),
          ]
        }),
      )
      .handle("listActorTypes", ({ params }) =>
        environment(params).pipe(
          Effect.flatMap((target) => actorTypes(target)),
          Effect.map((rows) => rows.map(summaryOf)),
        ),
      )
      .handle("getActorType", ({ params }) =>
        Effect.gen(function* () {
          const [row] = yield* actorTypes(yield* environment(params), params.actorType)

          if (row === undefined)
            return yield* NotFound.make({ resource: "actorType", id: params.actorType })

          return summaryOf(row)
        }),
      )
      .handle("getActorTypeActivity", ({ params }) =>
        allowed(params, "runtime.getActorTypeActivity"),
      )
      .handle("getActorTypeLatency", ({ params }) => allowed(params, "runtime.getActorTypeLatency"))
      .handle("listActorInstances", ({ params, query }) =>
        Effect.gen(function* () {
          const target = yield* environment(params)

          if (query.status !== undefined)
            return yield* notImplemented("runtime.listActorInstances.status")

          const after = yield* cursor(ActorCursor, query.cursor)
          const page = yield* runtime.readAll(
            target,
            "/actors",
            {
              type: params.actorType,
              limit: String(query.limit ?? PAGE_ROWS),
              afterType: after?.actorType,
              afterId: after?.actorId,
            },
            Inspection.ActorsPage,
          )

          return {
            items: page.actors.map((actor) => ({
              key: actor.actorId,
              status: null,
              lastCommand: null,
              lastActivityAt: null,
              generation: actor.generation,
            })),
            nextCursor: cursorOf(page.next),
          }
        }),
      )
      .handle("inspectActor", ({ params }) =>
        access.project(params.projectId).pipe(
          Effect.flatMap((organizationId) =>
            runtime.inspectActor({
              organizationId,
              projectId: params.projectId,
              environment: params.environment,
              address: `${params.actorType}/${params.key}`,
            }),
          ),
        ),
      )
      .handle("listActorTables", ({ params }) => allowed(params, "runtime.listActorTables"))
      .handle("listActorReceipts", ({ params, query }) =>
        Effect.gen(function* () {
          const target = yield* environment(params)
          const after = yield* cursor(ReceiptCursor, query.cursor)
          const page = yield* actorPage(
            target,
            params,
            "/receipts",
            { limit: String(query.limit ?? PAGE_ROWS), ...receiptParams(after) },
            Inspection.ReceiptsPage,
          )

          return { items: page.receipts.map(receiptOf), nextCursor: cursorOf(page.next) }
        }),
      )
      .handle("listActorEvents", ({ params }) =>
        Effect.gen(function* () {
          const events = yield* runtime.latestEvents(
            yield* environment(params),
            params.actorType,
            params.key,
          )

          if (events === undefined)
            return yield* NotFound.make({
              resource: "actor",
              id: `${params.actorType}/${params.key}`,
            })

          return events
        }),
      )
      .handle("listActorJobs", ({ params }) =>
        access.project(params.projectId).pipe(
          Effect.flatMap((organizationId) =>
            runtime.actorJobs({
              organizationId,
              projectId: params.projectId,
              environment: params.environment,
              address: `${params.actorType}/${params.key}`,
            }),
          ),
        ),
      )
      .handle("listActorTimeline", ({ params, query }) =>
        Effect.gen(function* () {
          const target = yield* environment(params)
          const before = yield* cursor(TimelineCursor, query.cursor)
          const page = yield* actorPage(
            target,
            params,
            "/timeline",
            {
              limit: String(query.limit ?? PAGE_ROWS),
              beforeSequence: before === undefined ? undefined : String(before.sequence),
              beforeKind: before?.kind,
            },
            Inspection.TimelinePage,
          )

          return { items: page.entries.map(timelineOf), nextCursor: cursorOf(page.next) }
        }),
      )
      .handle("listCommands", ({ params, query }) =>
        Effect.gen(function* () {
          const target = yield* environment(params)
          const after = yield* cursor(ReceiptCursor, query.cursor)

          if (query.outcome === "replayed") return { items: [], nextCursor: null }

          const page = yield* runtime.readAll(
            target,
            "/receipts",
            {
              type: query.actorType,
              outcome:
                query.outcome === undefined
                  ? undefined
                  : query.outcome === "ok"
                    ? "Success"
                    : "Failure",
              limit: String(query.limit ?? PAGE_ROWS),
              ...receiptParams(after),
            },
            Inspection.ReceiptsPage,
          )

          return {
            items: page.receipts.map((receipt): CommandLogEntry => ({
              commandId: receipt.commandId,
              at: null,
              durationMs: null,
              address: `${receipt.actorType}/${receipt.actorId}`,
              command: receipt.command,
              caller: callerOf(receipt.callerKey),
              payloadPreview: null,
              outcome: receipt.outcomeTag === "Success" ? "ok" : "error",
              errorTag: errorTagOf(receipt.outcome),
            })),
            nextCursor: cursorOf(page.next),
          }
        }),
      )
      .handle("streamCommands", ({ params }) => allowed(params, "runtime.streamCommands"))
      .handle("getJobs", ({ params }) =>
        Effect.gen(function* () {
          const jobs = yield* jobTypes(yield* environment(params))
          const total = (count: (job: Inspection.JobTypeRow) => number) =>
            jobs.reduce((sum, job) => sum + count(job), 0)

          return {
            queued: total((job) => job.queued),
            running: null,
            retrying: total((job) => job.retrying),
            dead: total((job) => job.deadLetters),
            byType: jobs.map((job) => ({
              jobName: job.job,
              done: null,
              retried: job.retrying,
              dead: job.deadLetters,
              p99Ms: null,
            })),
            throughput: null,
          }
        }),
      )
      .handle("listDeadLetters", ({ params, query }) =>
        Effect.gen(function* () {
          const target = yield* environment(params)
          const after = yield* cursor(DeadLetterCursor, query.cursor)
          const page = yield* runtime.readAll(
            target,
            "/dead-letters",
            {
              limit: String(query.limit ?? PAGE_ROWS),
              afterDeadAtMs: after === undefined ? undefined : String(after.deadAtMs),
              afterJobId: after?.jobId,
            },
            Inspection.DeadLettersPage,
          )

          return {
            items: yield* Effect.forEach(page.deadLetters, (letter) =>
              Effect.map(decodeDeadLetterId(letter.jobId).pipe(Effect.orDie), (id) => ({
                id,
                jobName: letter.job,
                jobId: letter.jobId,
                actor: `${letter.actorType}/${letter.actorId}`,
                attempts: letter.attempts,
                lastError: redactCause(letter.cause),
                since: instant(letter.deadAtMs),
              })),
            ),
            nextCursor: cursorOf(page.next),
          }
        }),
      )
      .handle("retryDeadLetter", ({ params }) =>
        access
          .project(params.projectId, "write")
          .pipe(Effect.andThen(notImplemented("runtime.retryDeadLetter"))),
      )
      .handle("discardDeadLetter", ({ params }) =>
        access
          .project(params.projectId, "write")
          .pipe(Effect.andThen(notImplemented("runtime.discardDeadLetter"))),
      )
      .handle("listWorkflows", ({ params, query }) =>
        Effect.gen(function* () {
          const target = yield* environment(params)
          const after = yield* cursor(WorkflowCursor, query.cursor)
          const page = yield* runtime.readAll(
            target,
            "/workflows",
            {
              status: query.status === undefined ? "all" : inspectorStatus[query.status],
              limit: String(query.limit ?? PAGE_ROWS),
              afterStartedAtMs: after === undefined ? undefined : String(after.startedAtMs),
              afterExecutionId: after?.executionId,
            },
            Inspection.WorkflowsPage,
          )
          return { items: page.workflows.map(workflowOf), nextCursor: cursorOf(page.next) }
        }),
      )
      .handle("getTimers", ({ params }) =>
        Effect.gen(function* () {
          const found = yield* overview(yield* environment(params))

          return {
            pending: found.counts.timers,
            nextFireAt: found.nextTimerDueAtMs === null ? null : instant(found.nextTimerDueAtMs),
          }
        }),
      )
      .handle("listSchedules", ({ params }) => allowed(params, "runtime.listSchedules"))
      .handle("getConnections", ({ params }) => allowed(params, "runtime.getConnections"))
      .handle("sendCommand", ({ params, payload }) =>
        Effect.gen(function* () {
          const organizationId = yield* access.project(params.projectId, "write")

          return yield* runtime.sendCommand({
            ...payload,
            organizationId,
            projectId: params.projectId,
            environment: params.environment,
            onBehalfOf: attributedSubject(yield* CurrentIdentity),
          })
        }),
      )
  }),
)
