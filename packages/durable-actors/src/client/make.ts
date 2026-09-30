import {
  Clock,
  Duration,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Random,
  Schema,
  SchemaAST,
  Stream,
} from "effect"
import type { ServedDefinition, ServedMember, StateValue } from "../actor/served.ts"
import { ActorError, InvalidCommandId, InvalidInput, Timeout } from "../errors/actor.ts"
import type { AnyMember, MemberRecord, ValueSchema } from "../members/command.ts"
import type { AnyConnection } from "../members/connection.ts"
import type { AnyStream } from "../members/stream.ts"
import type { EventClass } from "../members/event.ts"
import {
  type ClientConnection,
  type ConnectOptions,
  connect,
  type ProgressOfConnection,
} from "./sessions/connection.ts"
import { type FeedEntry, type FeedOptions, feedStream } from "./sessions/feed.ts"
import { type StreamOptions, subscription } from "./sessions/stream.ts"
import { ConsistencyToken, DatabaseClock, lifetime, retryDeadline } from "./clock.ts"
import { openCommandQueue, type OfflineQueue, type Refused } from "./offline/queue.ts"
import type { OfflineStore } from "./offline/store.ts"
import { Optimistic, type PendingInput } from "./optimistic.ts"
import {
  CREDENTIAL_CODES,
  decodeFailure,
  decodeSuccess,
  type Failure,
  type Reply,
  networkFailure,
  retryAfterHeader,
} from "./transport.ts"

type HeadersValue = Readonly<Record<string, string>> | Headers | Array<[string, string]>

/** Headers sent with every attempt; a function is called again for each attempt, including retries. */
export type HeadersProvider = HeadersValue | (() => HeadersValue | Promise<HeadersValue>)

/** Options of `X.client`. */
export interface ClientOptions {
  /** Where `Actor.serve` is mounted, absolute or relative to the page. */
  readonly baseUrl: string
  /**
   * Headers for every request. A connection sends the `authorization` header
   * in `hello` instead, because browsers can't set headers on a WebSocket.
   */
  readonly headers?: HeadersProvider
  /** How long one call, retries included, may wait. Defaults to 60,000. */
  readonly timeoutInMs?: number
  /** Defaults to the global `fetch`. */
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /**
   * `client` (default) mints ids from the database clock learned through
   * `/protocol`; `server` asks `/command-ids` for each one.
   */
  readonly commandIds?: "client" | "server"
  /**
   * Saves every command before its first attempt and delivers it in order per
   * actor under its original id, across outages and reloads; see
   * `ActorClient.offline`. Queries and streams are unaffected.
   */
  readonly offline?: OfflineStore
}

/** Options of one query call. */
export interface QueryOptions {
  /** Stops waiting; server work already accepted is not cancelled. */
  readonly signal?: AbortSignal
  /** Overrides `ClientOptions.timeoutInMs` for this call. */
  readonly timeoutInMs?: number
}

/** Options of one command call. */
export interface CommandOptions extends QueryOptions {
  /** Sent as `Idempotency-Key` on every attempt; minted once when omitted. */
  readonly commandId?: string
}

type Call<M extends AnyMember> = M["input"]["Type"] extends void
  ? (
      options?: M["kind"] extends "query" ? QueryOptions : CommandOptions,
    ) => Promise<M["output"]["Type"]>
  : (
      input: M["input"]["Type"],
      options?: M["kind"] extends "query" ? QueryOptions : CommandOptions,
    ) => Promise<M["output"]["Type"]>

/**
 * A handle's view of its actor's state: the committed state it last learned,
 * from a reducer's reply or `reconcile`, with its pending reducer inputs applied.
 * Reducer calls send one at a time, so each reply is the committed state
 * before every later pending input. The view has settled before the caller's
 * own callbacks run, and a listener that calls another reducer queues it
 * behind the current one.
 */
export interface ClientState<State> {
  /** Committed state plus pending inputs; undefined until committed state is known. */
  readonly current: State | undefined
  /** Reducer inputs applied ahead of their receipts, in call order. */
  readonly pending: ReadonlyArray<PendingInput>
  /** Calls `listener` with `current` after each change; returns the unsubscribe. */
  readonly subscribe: (listener: (state: State | undefined) => void) => () => void
  /** Replaces the committed state, e.g. with one a query read, and reapplies pending inputs. */
  readonly reconcile: (committed: State) => void
}

/** A connection member: `connect` opens one session over WebSocket. */
export interface ConnectionClient<M extends AnyConnection> {
  /** Opens a session; the `authorization` header from `headers` travels in `hello`. */
  readonly connect: (
    ...args: M["input"]["Type"] extends void
      ? [params?: M["input"]["Type"], options?: ConnectOptions]
      : [params: M["input"]["Type"], options?: ConnectOptions]
  ) => Promise<ClientConnection<M["server"]["Type"], M["client"]["Type"], ProgressOfConnection<M>>>
}

/** A stream member: each call subscribes once, as an `AsyncIterable` of its elements. */
export type StreamCall<M extends AnyStream> = (
  ...args: M["input"]["Type"] extends void
    ? [options?: StreamOptions]
    : [input: M["input"]["Type"], options?: StreamOptions]
) => AsyncIterable<M["output"]["Type"]>

/** One actor over HTTP: each public member as a Promise-returning method, connections as `connect`. */
export type ClientHandle<
  Members extends MemberRecord,
  Id = string,
  State = unknown,
  Events extends EventClass = never,
> = {
  readonly [K in keyof Members]: Members[K] extends AnyConnection
    ? ConnectionClient<Members[K]>
    : Members[K] extends AnyStream
      ? StreamCall<Members[K]>
      : Call<Members[K]>
} & {
  /** The actor type's name and this handle's id. */
  readonly ref: { readonly actor: string; readonly id: Id }
  /** The handle's committed and optimistic state. */
  readonly state: ClientState<State>
  /**
   * The actor's committed `event`s after `options.after`, over its event feed,
   * as they commit. Only events the actor type lists in `feeds` are served.
   */
  readonly events: <E extends Events>(
    event: E,
    options?: FeedOptions,
  ) => AsyncIterable<FeedEntry<E["Type"]>>
}

/** The client of one actor type: `get` (and `create` for minted ids) return handles. */
export type ActorClient<
  Members extends MemberRecord,
  Kind extends ServedDefinition["key"],
  Id,
  State = unknown,
  Events extends EventClass = never,
> = {
  /** A fresh command id, for a caller that saves it before sending the command. */
  readonly commandId: () => Promise<string>
  /**
   * The persisted command queue when `ClientOptions.offline` is set, else
   * `undefined`. A command call then resolves with its output once the server
   * answers, and rejects with `Timeout` carrying the command's id if the
   * call's own timeout or signal ends the wait first; the command stays
   * queued and is still delivered under that id.
   */
  readonly offline: OfflineQueue | undefined
} & (Kind extends "singleton"
  ? { readonly get: () => ClientHandle<Members, string, State, Events> }
  : Kind extends "minted"
    ? {
        readonly get: (id: Id) => ClientHandle<Members, Id, State, Events>
        /** A handle to a new actor whose UUIDv7 id is minted here; it exists once a command reaches it. */
        readonly create: () => ClientHandle<Members, Id, State, Events>
      }
    : { readonly get: (id: Id) => ClientHandle<Members, Id, State, Events> })

const DEFAULT_TIMEOUT_MS = 60_000

const MAX_BACKOFF_MS = 2_000

/** Ids a client remembers minting per origin, so it can tell whether one might have been admitted; the oldest go first. */
const MINTED_LIMIT = 1_024

/** How long a mint waits for the server before it falls back to the retry window and clock offset this page last learned. */
const MINT_PROBE_MS = 3_000

/** Base URLs whose clock and token state are shared per process; the least recently used go first. */
const ORIGIN_LIMIT = 64

/** Handles kept per client. */
const HANDLE_LIMIT = 1_024

/** State every client of one base URL shares: the database clock, the retry window, and the token. */
interface Origin {
  readonly clock: DatabaseClock
  readonly token: ConsistencyToken
  window: number | undefined
  /** Ids this client minted, each with whether any attempt might have been admitted. */
  readonly minted: Map<string, MintedUse>
}

/** A minted id's attempts: whether any might have been admitted, and how many are unanswered. */
interface MintedUse {
  admitted: boolean
  inFlight: number
}

const origins = new Map<string, Origin>()

const originOf = (baseUrl: string): Origin => {
  const existing = origins.get(baseUrl)

  if (existing !== undefined) {
    origins.delete(baseUrl)
    origins.set(baseUrl, existing)

    return existing
  }

  const origin: Origin = {
    clock: new DatabaseClock(),
    token: new ConsistencyToken(),
    window: undefined,
    minted: new Map(),
  }

  origins.set(baseUrl, origin)
  const oldest = origins.keys().next()

  if (origins.size > ORIGIN_LIMIT && oldest.done !== true) origins.delete(oldest.value)

  return origin
}

const ProtocolInfo = Schema.Struct({
  protocol: Schema.Literal(1),
  retryWindowMs: Schema.Int,
  now: Schema.Int,
})

const decodeProtocol = Schema.decodeUnknownEffect(ProtocolInfo)

const decodeMinted = Schema.decodeUnknownEffect(Schema.Struct({ commandId: Schema.String }))

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const isFramework = Schema.is(ActorError)

const isInvalidCommandId = Schema.is(InvalidCommandId)

/** True when a failure proves the attempt was refused before any turn could run. */
const refusedBeforeTurn = (failure: Failure) =>
  isFramework(failure) &&
  Match.value(failure.reason).pipe(
    Match.tags({
      InvalidCommandId: () => true,
      InvalidInput: () => true,
      Unauthorized: (reason) => CREDENTIAL_CODES.has(reason.code),
    }),
    Match.orElse(() => false),
  )

/** Counts `request` as unanswered for `use` while it runs; an abandoned request might still be admitted. */
const tracked = <A, E>(use: MintedUse | undefined, request: Effect.Effect<A, E>) =>
  use === undefined
    ? request
    : Effect.suspend(() => {
        use.inFlight += 1

        return request.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              use.inFlight -= 1

              if (Exit.hasInterrupts(exit)) use.admitted = true
            }),
          ),
        )
      })

const invalid = () => ActorError.make({ reason: InvalidInput.make({ code: "decode" }) })

/** Per-call retry bookkeeping. */
interface Retry {
  attempts: number
  futureRetried: boolean
  authRetried: boolean
}

/** A failed attempt, with the response it came from when there was one. */
interface Attempted {
  readonly failure: Failure
  readonly reply: Reply | undefined
}

const jittered = (ms: number) =>
  Random.nextBetween(0.5, 1.5).pipe(Effect.map((f) => Math.round(ms * f)))

const retryAfterOf = (failure: ActorError) => Effect.succeed(failure.retryAfter)

/** Milliseconds to wait before retrying with the same id, or none to stop. */
const retryDelay = (retry: Retry, clock: DatabaseClock) => (attempted: Attempted) =>
  Effect.gen(function* () {
    const { failure, reply } = attempted

    if (!isFramework(failure)) return Option.none<number>()

    const now = yield* Clock.currentTimeMillis

    const header = Option.fromUndefinedOr(
      reply === undefined
        ? undefined
        : retryAfterHeader({
            headers: reply.headers,
            now,
            elapsed: clock.localNow() - reply.sentAt,
          }),
    )

    return yield* Match.value(failure.reason).pipe(
      Match.tags({
        ActorUnavailable: () => retryAfterOf(failure),
        RunnerAtCapacity: () => retryAfterOf(failure),
        MailboxFull: () => retryAfterOf(failure),
        Timeout: () => Effect.asSome(jittered(50)),
        TransportError: (reason) =>
          !reason.retryable
            ? Effect.succeedNone
            : Option.isSome(header)
              ? Effect.succeed(header)
              : Effect.asSome(jittered(Math.min(MAX_BACKOFF_MS, 100 * 2 ** retry.attempts))),
        InvalidCommandId: (reason) => {
          const issued = lifetime(reason.commandId)

          if (reason.code !== "future" || retry.futureRetried || issued === undefined)
            return Effect.succeedNone

          retry.futureRetried = true

          return Effect.succeedSome(Math.max(50, clock.untilReached(issued.issuedAt) + 50))
        },
        Unauthorized: (reason) => {
          if (reason.code !== "expired" || retry.authRetried) return Effect.succeedNone

          retry.authRetried = true

          return Effect.succeedSome(0)
        },
      }),
      Match.orElse(() => Effect.succeedNone),
    )
  })

const joinUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, "")}${path}`

/**
 * A connection's WebSocket URL from its route's URL, resolved against the page
 * when relative: `wss:` for `https:` or `wss:`, and `ws:` otherwise.
 */
export const socketUrl = (route: string) => {
  const url = new URL(route, "location" in globalThis ? globalThis.location.href : undefined)

  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"

  return url.href
}

interface Request {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body: string | undefined
  readonly headers: Readonly<Record<string, string>>
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const formatUuid = (bytes: Uint8Array) => {
  const digits = hex(bytes)

  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`
}

/** A random RFC 9562 UUID of `version` 4 or 7; a v7 carries the local clock in its first 48 bits. */
const uuid = (version: 4 | 7) =>
  Effect.gen(function* () {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))

    if (version === 7) {
      let time = yield* Clock.currentTimeMillis

      for (let index = 5; index >= 0; index -= 1) {
        bytes[index] = time % 256
        time = Math.floor(time / 256)
      }
    }

    bytes[6] = (bytes[6]! & 0x0f) | (version << 4)
    bytes[8] = (bytes[8]! & 0x3f) | 0x80

    return formatUuid(bytes)
  })

const declaredDecoders = new WeakMap<ServedMember, (body: Schema.Json) => Option.Option<Failure>>()

const declaredDecoder = (member: ServedMember) => {
  const cached = declaredDecoders.get(member)

  if (cached !== undefined) return cached

  const decode: (body: Schema.Json) => Option.Option<Failure> =
    member.errors.length === 0
      ? () => Option.none()
      : Schema.decodeUnknownOption(Schema.toCodecJson(Schema.Union(member.errors)))

  declaredDecoders.set(member, decode)

  return decode
}

const decodeInputCopy = (member: ServedMember) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(member.input)))

const isVoidInput = (member: ServedMember) =>
  SchemaAST.isVoid(member.input.ast) || SchemaAST.isUndefined(member.input.ast)

/** Decodes a success body the way the server writes it: empty for void, `null` for undefined. */
const outputDecoder = (member: ServedMember) => {
  if (SchemaAST.isVoid(member.output.ast)) return () => Effect.void

  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(member.output))

  return (json: Schema.Json | undefined) =>
    json === null ? decode(null).pipe(Effect.catch(() => decode(undefined))) : decode(json)
}

/**
 * The Promise client of one served actor type, typed by its caller.
 *
 * Every response carries `durable-now`, so each round trip refreshes the
 * database clock, except a 504, which waited out a deadline and says little
 * about when it was stamped. `/protocol` is read again when no recent clock
 * sample remains, since the offset may have drifted, and a `window` rejection
 * clears the cached window because a deployment at this URL may have changed
 * it. Without a usable clock sample, such as after a slow `/protocol`, the
 * server mints the id instead. An unanswered command's outcome is unknown, so
 * its `Timeout` carries the id a caller retries later. Past 1,024 handles the
 * least recently used other handle with nothing pending and no listener is
 * dropped.
 */
export const clientOf =
  <Client>(definition: ServedDefinition) =>
  (options: ClientOptions): Client => {
    const origin = originOf(options.baseUrl)
    const clock = origin.clock
    const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)

    const provided = Effect.suspend(() => {
      const headers = options.headers

      return Predicate.isFunction(headers)
        ? Effect.promise(() => Promise.resolve(headers()))
        : Effect.succeed(headers)
    })

    const authorization = provided.pipe(
      Effect.map((headers) => new Headers(headers).get("authorization") ?? undefined),
    )

    const send = (request: Request) =>
      Effect.gen(function* () {
        const headers = new Headers(yield* provided)

        for (const [name, value] of Object.entries(request.headers)) headers.set(name, value)

        headers.set("durable-protocol", "1")
        headers.set("accept", "application/json")
        const sentAt = clock.localNow()

        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(joinUrl(options.baseUrl, request.path), {
              method: request.method,
              headers,
              body: request.body,
              signal,
            }),
          catch: networkFailure,
        })

        const text = yield* Effect.tryPromise({ try: () => response.text(), catch: networkFailure })
        const now = response.headers.get("durable-now")

        if (now !== null && response.status !== 504)
          clock.observe(sentAt, clock.localNow(), Number(now))
        origin.token.observe(response.headers.get("durable-version"))

        const reply: Reply = { status: response.status, headers: response.headers, text, sentAt }

        return reply
      })

    const isOk = (reply: Reply) => reply.status >= 200 && reply.status < 300

    const retryWindow = Effect.suspend(() => {
      const cached = origin.window

      if (cached !== undefined && clock.isFresh) return Effect.succeed(cached)

      return send({ method: "GET", path: "/protocol", body: undefined, headers: {} }).pipe(
        Effect.flatMap((reply) =>
          isOk(reply)
            ? decodeSuccess((body) => decodeProtocol(body))(reply)
            : Effect.fail(decodeFailure(undefined)(reply)),
        ),
        Effect.map((protocol) => {
          origin.window = protocol.retryWindowMs

          return protocol.retryWindowMs
        }),
      )
    })

    const mintServer = send({
      method: "POST",
      path: "/command-ids",
      body: undefined,
      headers: {},
    }).pipe(
      Effect.flatMap((reply) =>
        isOk(reply)
          ? decodeSuccess((body) => decodeMinted(body))(reply)
          : Effect.fail(decodeFailure(undefined)(reply)),
      ),
      Effect.map((minted) => minted.commandId),
    )

    const mintLocal = Effect.gen(function* () {
      const window = yield* retryWindow

      if (!clock.isFresh) return yield* mintServer

      return clock.mint(window, yield* uuid(4))
    })

    const remember = (commandId: string) =>
      Effect.sync(() => {
        origin.minted.set(commandId, { admitted: false, inFlight: 0 })
        const oldest = origin.minted.keys().next()

        if (origin.minted.size > MINTED_LIMIT && oldest.done !== true)
          origin.minted.delete(oldest.value)
      })

    const mintOnline = (options.commandIds === "server" ? mintServer : mintLocal).pipe(
      Effect.tap(remember),
    )

    /**
     * With an offline store, a mint that cannot reach the server within
     * `MINT_PROBE_MS` uses the retry window and the clock offset this page
     * last learned, so a command can be queued while the network is down. A
     * page that never reached the server has learned neither, and fails
     * with the network error rather than guess a window.
     */
    const mintOffline = mintOnline.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(MINT_PROBE_MS),
        orElse: () => Effect.fail(networkFailure()),
      }),
      Effect.catch((failure) => {
        const window = origin.window

        if (window === undefined || !clock.isSampled) return Effect.fail(failure)

        return uuid(4).pipe(
          Effect.map((id) => clock.mint(window, id)),
          Effect.tap(remember),
        )
      }),
    )

    const mint = options.offline === undefined ? mintOnline : mintOffline

    /**
     * Waits for `work` until the call's timeout or signal ends the wait, which
     * fails with `Timeout` carrying the command's id: the outcome is unknown,
     * and that id is what a caller retries later.
     */
    const waiting = <A>(
      work: Effect.Effect<A, Failure>,
      call: QueryOptions,
      commandId: () => string | undefined,
    ): Promise<A> => {
      const unanswered = Effect.suspend(() => {
        const id = commandId()

        return Effect.fail(
          ActorError.make({ reason: Timeout.make(id === undefined ? {} : { commandId: id }) }),
        )
      })

      const aborted = Effect.callback<never, Failure>((resume) => {
        const signal = call.signal

        if (signal === undefined) return

        if (signal.aborted) return resume(unanswered)

        const onAbort = () => resume(unanswered)
        signal.addEventListener("abort", onAbort, { once: true })

        return Effect.sync(() => signal.removeEventListener("abort", onAbort))
      })

      const bounded = work.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(call.timeoutInMs ?? options.timeoutInMs ?? DEFAULT_TIMEOUT_MS),
          orElse: () => unanswered,
        }),
      )

      return Effect.runPromise(Effect.raceFirst(bounded, aborted))
    }

    /**
     * Runs `attempt` until it succeeds or a stop condition holds, surfacing the last failure.
     * With `after`, the first attempt waits for it, inside the same timeout and abort.
     */
    const withRetries = <A>(
      attempt: Effect.Effect<A, Attempted>,
      call: QueryOptions,
      commandId: () => string | undefined,
      after?: Promise<void>,
    ): Promise<A> => {
      const retry: Retry = { attempts: 0, futureRetried: false, authRetried: false }

      const loop: Effect.Effect<A, Failure> = attempt.pipe(
        Effect.catch((attempted) =>
          Effect.gen(function* () {
            if (
              isFramework(attempted.failure) &&
              isInvalidCommandId(attempted.failure.reason) &&
              attempted.failure.reason.code === "window"
            )
              origin.window = undefined
            const delay = yield* retryDelay(retry, clock)(attempted)
            retry.attempts += 1
            const id = commandId()
            const deadline = id === undefined || !clock.isFresh ? undefined : retryDeadline(id)

            if (
              Option.isNone(delay) ||
              (deadline !== undefined && clock.now() + delay.value >= deadline)
            )
              return yield* attempted.failure

            yield* Effect.sleep(Duration.millis(delay.value))

            return yield* loop
          }),
        ),
      )

      const queued =
        after === undefined ? loop : Effect.promise(() => after).pipe(Effect.andThen(loop))

      return waiting(queued, call, commandId)
    }

    /** A failure as the call that sent `commandId` reports it, with whether any attempt might have been admitted. */
    const admittedFor = (commandId: string | undefined) => (failure: Failure) => {
      const use = commandId === undefined ? undefined : origin.minted.get(commandId)

      if (use === undefined) return failure

      if (!refusedBeforeTurn(failure)) use.admitted = true

      if (!isFramework(failure) || !isInvalidCommandId(failure.reason)) return failure

      return ActorError.make({
        reason: InvalidCommandId.make({
          commandId: failure.reason.commandId,
          code: failure.reason.code,
          neverAdmitted: !use.admitted && use.inFlight === 0,
        }),
      })
    }

    /** One attempt of `member` at `path`, sending `payload` under `commandId`, which a query has none of. */
    const poster = (member: ServedMember) => {
      const decode = outputDecoder(member)
      const isQuery = member.kind === "query"
      const decodeDeclared = declaredDecoder(member)

      return (path: string, payload: string | undefined, commandId: string | undefined) =>
        Effect.gen(function* () {
          const headers: Record<string, string> = {}

          if (payload !== undefined) headers["content-type"] = "application/json"

          if (commandId !== undefined) headers["idempotency-key"] = commandId

          const token = origin.token.value

          if (isQuery && token !== undefined) headers["durable-min-version"] = token

          const use = commandId === undefined ? undefined : origin.minted.get(commandId)

          const reply = yield* tracked(use, send({ method: "POST", path, body: payload, headers }))

          if (isOk(reply)) {
            if (use !== undefined) use.admitted = true

            return yield* decodeSuccess(decode)(reply)
          }

          const attempted: Attempted = {
            failure: admittedFor(commandId)(decodeFailure(decodeDeclared)(reply)),
            reply,
          }

          return yield* Effect.fail(attempted)
        }).pipe(
          Effect.mapError((error): Attempted =>
            "failure" in error
              ? error
              : { failure: admittedFor(commandId)(error), reply: undefined },
          ),
        )
    }

    const members = new Map(definition.members.map((member) => [member.tag, member]))

    const unknownMember = () =>
      ActorError.make({ reason: InvalidInput.make({ code: "unknown_route" }) })

    /**
     * The persisted queue of `options.offline`, delivering the commands saved
     * under this base URL for this actor type. Each delivery keeps its own
     * retry state, and a member removed since a command was saved fails that
     * command for good instead of retrying it.
     */
    const queue =
      options.offline === undefined
        ? undefined
        : openCommandQueue<ValueSchema["Type"]>({
            store: options.offline,
            baseUrl: options.baseUrl,
            actor: definition.name,
            now: () => clock.now(),
            begin: (command) => {
              const member = members.get(command.member)

              if (member === undefined)
                return Effect.fail<Refused>({
                  failure: unknownMember(),
                  retryAfterMs: Option.none(),
                  answer: undefined,
                })

              const retry: Retry = { attempts: 0, futureRetried: false, authRetried: false }

              return poster(member)(
                `${command.target}/${member.tag}`,
                command.body,
                command.commandId,
              ).pipe(
                Effect.catch((attempted) =>
                  retryDelay(
                    retry,
                    clock,
                  )(attempted).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        retry.attempts += 1
                      }),
                    ),
                    Effect.flatMap((delay) =>
                      Effect.fail<Refused>({
                        failure: attempted.failure,
                        retryAfterMs: delay,
                        answer:
                          attempted.reply === undefined
                            ? undefined
                            : { status: attempted.reply.status, text: attempted.reply.text },
                      }),
                    ),
                  ),
                ),
              )
            },
            failureOf: (command) => {
              const member = members.get(command.member)
              const answer = command.answer ?? { status: 0, text: "" }

              if (member === undefined) return unknownMember()

              return decodeFailure(declaredDecoder(member))({
                status: answer.status,
                headers: new Headers(),
                text: answer.text,
                sentAt: 0,
              })
            },
            warm: retryWindow.pipe(Effect.asVoid, Effect.ignore),
          })

    /**
     * Encodes one call's input now, so every attempt under one id sends the same
     * bytes, and returns what sends it, with a decoded copy of that input.
     */
    const prepare = (
      member: ServedMember,
      segment: Effect.Effect<string, ActorError>,
      args: ReadonlyArray<unknown>,
    ) => {
      const isVoid = isVoidInput(member)
      const call: CommandOptions = (isVoid ? args[0] : args[1]) ?? {}
      const isQuery = member.kind === "query"
      let commandId = isQuery ? undefined : call.commandId

      const body = Effect.runSyncExit(
        Schema.encodeUnknownEffect(Schema.toCodecJson(member.input))(
          isVoid ? undefined : args[0],
        ).pipe(
          Effect.flatMap((json) =>
            json === undefined ? Effect.succeedNone : Effect.asSome(encodeJson(json)),
          ),
          Effect.mapError(invalid),
        ),
      )

      const post = poster(member)

      const attempt = Effect.gen(function* () {
        const path = `/actors/${definition.name}${yield* segment}/${member.tag}`
        const payload = Option.getOrUndefined(yield* body)

        if (!isQuery && commandId === undefined) commandId = yield* mint

        return yield* post(path, payload, commandId)
      }).pipe(
        Effect.mapError((error): Attempted =>
          "failure" in error ? error : { failure: admittedFor(commandId)(error), reply: undefined },
        ),
      )

      const input = Exit.isSuccess(body)
        ? Option.getOrUndefined(
            Exit.getSuccess(
              Effect.runSyncExit(
                Option.match(body.value, {
                  onNone: () => Effect.void,
                  onSome: (json) => decodeInputCopy(member)(json),
                }),
              ),
            ),
          )
        : undefined

      /**
       * Saves this command in the offline queue, minting its id first when the
       * caller gave none, and reports when it is delivered. `call` is the
       * caller's view, bounded by its timeout and signal; `delivered` outlives
       * both, so state that follows the command follows its real outcome.
       */
      const enqueue =
        queue === undefined || isQuery
          ? undefined
          : () => {
              const make = Effect.gen(function* () {
                const target = `/actors/${definition.name}${yield* segment}`
                const payload = Option.getOrUndefined(yield* body)

                commandId ??= yield* mint

                return { commandId, target, member: member.tag, body: payload }
              })

              const delivered = queue.submit(make, call.signal).then((delivery) =>
                delivery === undefined
                  ? Promise.reject(
                      ActorError.make({
                        reason: Timeout.make(commandId === undefined ? {} : { commandId }),
                      }),
                    )
                  : Effect.runPromise(delivery.settled),
              )

              return {
                delivered,
                call: waiting(
                  Effect.tryPromise({
                    try: () => delivered,
                    catch: (thrown) => thrown as Failure,
                  }),
                  call,
                  () => commandId,
                ),
              }
            }

      return {
        input: Exit.isSuccess(body) ? Option.some(input) : Option.none(),
        send: (after?: Promise<void>) => withRetries(attempt, call, () => commandId, after),
        enqueue,
      }
    }

    const method =
      (member: ServedMember, segment: Effect.Effect<string, ActorError>, store: Optimistic) =>
      (...args: ReadonlyArray<unknown>) => {
        const { input, send, enqueue } = prepare(member, segment, args)
        const reducer = member.reducer

        if (reducer === undefined || Option.isNone(input))
          return enqueue === undefined ? send() : enqueue().call

        const entry = { member: member.tag, input: input.value, reducer }

        if (enqueue !== undefined) {
          const { call, delivered } = enqueue()

          void delivered.then(
            (value) => {
              store.confirm(
                entry,
                reducer.commutative || !Predicate.isObject(value) ? undefined : value,
              )
            },
            () => {
              store.drop(entry)
            },
          )

          store.add(entry)

          return call
        }

        const previous = store.queue
        const settled = send(previous)
        store.queue = Promise.allSettled([previous, settled]).then(() => undefined)

        void settled.then(
          (value) => {
            store.confirm(
              entry,
              reducer.commutative || !Predicate.isObject(value) ? undefined : value,
            )
          },
          () => {
            store.drop(entry)
          },
        )

        store.add(entry)

        return settled
      }

    const handles = new Map<string, object>()
    const stores = new Map<string, Optimistic>()

    const handle = (id: string, segment: Effect.Effect<string, ActorError>) => {
      const existing = handles.get(id)
      const existingStore = stores.get(id)

      if (existing !== undefined && existingStore !== undefined) {
        handles.delete(id)
        handles.set(id, existing)

        return existing
      }

      const store = new Optimistic(
        definition.members.find((member) => member.reducer !== undefined)?.reducer,
      )

      const path = (member: string) =>
        segment.pipe(Effect.map((encoded) => `/actors/${definition.name}${encoded}/${member}`))

      const created = {
        ...Object.fromEntries(
          definition.members.map((member) => [member.tag, method(member, segment, store)]),
        ),
        ...Object.fromEntries(
          definition.connections.map((member) => [
            member.tag,
            {
              connect: (params: ValueSchema["Type"], connectOptions?: ConnectOptions) =>
                Effect.runPromise(path(member.tag)).then((memberPath) =>
                  connect({
                    member,
                    url: socketUrl(joinUrl(options.baseUrl, memberPath)),
                    authorization,
                    params,
                    options: connectOptions ?? {},
                  }),
                ),
            },
          ]),
        ),
        ...Object.fromEntries(
          definition.streams.map((member) => [
            member.tag,
            (...args: ReadonlyArray<unknown>) => {
              const isVoid = isVoidInput(member)
              const streamOptions: StreamOptions = (isVoid ? args[0] : args[1]) ?? {}

              const body = Schema.encodeUnknownEffect(Schema.toCodecJson(member.input))(
                isVoid ? undefined : args[0],
              ).pipe(
                Effect.flatMap((json) =>
                  json === undefined ? Effect.succeedNone : Effect.asSome(encodeJson(json)),
                ),
                Effect.map(Option.getOrUndefined),
                Effect.mapError(invalid),
              )

              return Stream.toAsyncIterable(
                subscription({
                  member,
                  declared: declaredDecoder(member),
                  options: streamOptions,
                  open: (signal) =>
                    Effect.gen(function* () {
                      const payload = yield* body
                      const headers = new Headers(yield* provided)
                      headers.set("accept", "text/event-stream")
                      headers.set("durable-protocol", "1")

                      if (payload !== undefined) headers.set("content-type", "application/json")

                      const url = joinUrl(options.baseUrl, yield* path(member.tag))

                      return yield* Effect.tryPromise({
                        try: () => fetch(url, { method: "POST", headers, body: payload, signal }),
                        catch: networkFailure,
                      })
                    }),
                }),
              )
            },
          ]),
        ),
        events: (event: EventClass, feedOptions?: FeedOptions) =>
          Stream.toAsyncIterable(
            feedStream({
              event,
              options: feedOptions ?? {},
              open: (cursor, signal) =>
                Effect.gen(function* () {
                  const query = new URLSearchParams({ event: event.identifier })
                  const headers = new Headers(yield* provided)

                  if (cursor !== undefined) headers.set("last-event-id", cursor)

                  headers.set("accept", "text/event-stream")
                  headers.set("durable-protocol", "1")
                  const url = joinUrl(options.baseUrl, `${yield* path("events")}?${query}`)

                  return yield* Effect.tryPromise({
                    try: () =>
                      fetch(url, {
                        headers,
                        signal,
                      }),
                    catch: networkFailure,
                  })
                }),
            }),
          ),
        ref: { actor: definition.name, id },
        state: {
          get current() {
            return store.state
          },
          get pending() {
            return store.pending
          },
          subscribe: (listener: (state: StateValue | undefined) => void) =>
            store.subscribe(listener),
          reconcile: (committed: StateValue) => store.reconcile(committed),
        },
      }

      handles.set(id, created)
      stores.set(id, store)

      if (handles.size > HANDLE_LIMIT)
        for (const key of handles.keys())
          if (key !== id && stores.get(key)?.isIdle === true) {
            handles.delete(key)
            stores.delete(key)
            break
          }

      return created
    }

    const keyed = (id: string) =>
      handle(
        id,
        definition.encodeId(id).pipe(
          Effect.map((encoded) => `/${encodeURIComponent(encoded)}`),
          Effect.mapError(invalid),
        ),
      )

    const client = {
      offline: queue,
      commandId: () =>
        withRetries(
          mint.pipe(Effect.mapError((failure): Attempted => ({ failure, reply: undefined }))),
          {},
          () => undefined,
        ),
      get:
        definition.key === "singleton"
          ? () => handle("singleton", Effect.succeed(""))
          : (id: string) => keyed(id),
      create: definition.key === "minted" ? () => keyed(Effect.runSync(uuid(7))) : undefined,
    }

    return client as Client
  }
