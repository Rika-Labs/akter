import {
  type ActorJob,
  CloudApi,
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
import { HttpApiBuilder } from "effect/http-api"
import { Access } from "./access.ts"
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
const decodeJobs = Schema.decodeUnknownEffect(ActorJobs)

/** The most rows the runners' inspector returns for one list. */
const INSPECTOR_ROWS = 500

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

  /** One actor as the inspector reads it, or `undefined` when the tenant has no such actor. */
  const inspect = Effect.fn("Runtime.inspect")(function* (target: RuntimeTarget, address: string) {
    const { type, id } = split(address)

    const { status, body } = yield* call(
      target,
      HttpClientRequest.get(url(target, `${target.inspectorPath ?? "/inspector"}/actor`)).pipe(
        HttpClientRequest.setUrlParams({ type, id, limit: String(INSPECTOR_ROWS) }),
      ),
    )

    if (status === 404) return undefined

    if (status !== 200) return yield* unavailable(`inspector answered ${status}`)

    return body
  })

  const sendCommand = Effect.fn("Runtime.sendCommand")(function* (input: {
    readonly organizationId: string
    readonly projectId: string
    readonly environment: string
    readonly address: string
    readonly command: string
    readonly payload: Schema.Json
    readonly commandId?: string | undefined
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
        { headers: { "idempotency-key": commandId } },
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
    const found = yield* inspect(yield* edge.resolve(input), input.address)

    if (found === undefined) return yield* NotFound.make({ resource: "actor", id: input.address })

    const detail = yield* decodeJobs(found).pipe(Effect.orDie)

    return [
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
  })

  return { sendCommand, actorJobs }
})

const notImplemented = (operation: string) => Effect.fail(NotImplemented.make({ operation }))

/**
 * The console's runtime endpoints, answered by asking runners through the
 * edge. `sendCommand` and `listActorJobs` are the ones a runner's inspection
 * surface can answer completely: the rest of the contract needs rates,
 * latencies, awake state, mailbox depth, connection counts or a command log
 * that the runners do not report, so they stay `NotImplemented` rather than
 * answer with invented numbers.
 */
export const RuntimeLive = HttpApiBuilder.group(CloudApi, "runtime", (handlers) =>
  Effect.gen(function* () {
    const access = yield* Access
    const runtime = yield* makeRuntime

    return handlers
      .handle("getOverview", () => notImplemented("runtime.getOverview"))
      .handle("getSidebarCounts", () => notImplemented("runtime.getSidebarCounts"))
      .handle("search", () => notImplemented("runtime.search"))
      .handle("listActorTypes", () => notImplemented("runtime.listActorTypes"))
      .handle("getActorType", () => notImplemented("runtime.getActorType"))
      .handle("getActorTypeActivity", ({ params }) =>
        access
          .project(params.projectId)
          .pipe(Effect.andThen(notImplemented("runtime.getActorTypeActivity"))),
      )
      .handle("getActorTypeLatency", ({ params }) =>
        access
          .project(params.projectId)
          .pipe(Effect.andThen(notImplemented("runtime.getActorTypeLatency"))),
      )
      .handle("listActorInstances", () => notImplemented("runtime.listActorInstances"))
      .handle("inspectActor", () => notImplemented("runtime.inspectActor"))
      .handle("listActorTables", () => notImplemented("runtime.listActorTables"))
      .handle("listActorReceipts", () => notImplemented("runtime.listActorReceipts"))
      .handle("listActorEvents", () => notImplemented("runtime.listActorEvents"))
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
      .handle("listActorTimeline", () => notImplemented("runtime.listActorTimeline"))
      .handle("listCommands", () => notImplemented("runtime.listCommands"))
      .handle("streamCommands", () => notImplemented("runtime.streamCommands"))
      .handle("getJobs", () => notImplemented("runtime.getJobs"))
      .handle("listDeadLetters", () => notImplemented("runtime.listDeadLetters"))
      .handle("retryDeadLetter", () => notImplemented("runtime.retryDeadLetter"))
      .handle("discardDeadLetter", () => notImplemented("runtime.discardDeadLetter"))
      .handle("listWorkflows", () => notImplemented("runtime.listWorkflows"))
      .handle("getTimers", () => notImplemented("runtime.getTimers"))
      .handle("listSchedules", () => notImplemented("runtime.listSchedules"))
      .handle("getConnections", () => notImplemented("runtime.getConnections"))
      .handle("sendCommand", ({ params, payload }) =>
        access.project(params.projectId, "write").pipe(
          Effect.flatMap((organizationId) =>
            runtime.sendCommand({
              ...payload,
              organizationId,
              projectId: params.projectId,
              environment: params.environment,
            }),
          ),
        ),
      )
  }),
)
