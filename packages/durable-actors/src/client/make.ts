import {
  Clock,
  Duration,
  Effect,
  Match,
  Option,
  Predicate,
  Random,
  Schema,
  SchemaAST,
} from "effect"
import type { ServedDefinition, ServedMember } from "../actor/served.ts"
import {
  ActorError,
  InvalidCommandId,
  InvalidInput,
  Timeout,
  TransportError,
  Unauthorized,
} from "../errors/actor.ts"
import type { AnyMember, MemberRecord } from "../members/command.ts"
import { ConsistencyToken, DatabaseClock, lifetime } from "./clock.ts"
import {
  decodeFailure,
  decodeSuccess,
  type Failure,
  type Reply,
  retryAfterHeader,
  transport,
} from "./transport.ts"

type HeadersValue = Readonly<Record<string, string>> | Headers | Array<[string, string]>

/** Headers sent with every attempt; a function is called again for each attempt, including retries. */
export type HeadersProvider = HeadersValue | (() => HeadersValue | Promise<HeadersValue>)

export interface ClientOptions {
  /** Where `Actor.serve` is mounted, absolute or relative to the page. */
  readonly baseUrl: string
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
}

export interface QueryOptions {
  /** Stops waiting; server work already accepted is not cancelled. */
  readonly signal?: AbortSignal
  readonly timeoutInMs?: number
}

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

/** One actor over HTTP: each public member as a Promise-returning method. */
export type ClientHandle<Members extends MemberRecord, Id = string> = {
  readonly [K in keyof Members]: Call<Members[K]>
} & { readonly ref: { readonly actor: string; readonly id: Id } }

export type ActorClient<Members extends MemberRecord, Kind extends ServedDefinition["key"], Id> = {
  /** A fresh command id, for a caller that saves it before sending the command. */
  readonly commandId: () => Promise<string>
} & (Kind extends "singleton"
  ? { readonly get: () => ClientHandle<Members> }
  : Kind extends "minted"
    ? {
        readonly get: (id: Id) => ClientHandle<Members, Id>
        /** A handle to a new actor whose UUIDv7 id is minted here; it exists once a command reaches it. */
        readonly create: () => ClientHandle<Members, Id>
      }
    : { readonly get: (id: Id) => ClientHandle<Members, Id> })

const DEFAULT_TIMEOUT_MS = 60_000

/** Retries stop this long before an id expires, so no attempt races its own expiry. */
const EXPIRY_MARGIN_MS = 1_000

const MAX_BACKOFF_MS = 2_000

const MINTED_LIMIT = 1_024

/** State every client of one base URL shares: the database clock, the retry window, and the token. */
interface Origin {
  readonly clock: DatabaseClock
  readonly token: ConsistencyToken
  window: number | undefined
  /** Ids this client minted, each with whether any attempt might have been admitted. */
  readonly minted: Map<string, boolean>
}

const origins = new Map<string, Origin>()

const originOf = (baseUrl: string): Origin => {
  const existing = origins.get(baseUrl)

  if (existing !== undefined) return existing

  const origin: Origin = {
    clock: new DatabaseClock(),
    token: new ConsistencyToken(),
    window: undefined,
    minted: new Map(),
  }

  origins.set(baseUrl, origin)

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

const CREDENTIAL_CODES: ReadonlySet<Unauthorized["code"]> = new Set([
  "missing_credentials",
  "invalid_credentials",
  "expired",
])

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

const network = () => transport(TransportError.make({ code: "network", retryable: true }))

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

    const header = Option.fromUndefinedOr(
      reply === undefined ? undefined : retryAfterHeader(reply.headers),
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

          return Effect.succeedSome(Math.max(50, issued.issuedAt - clock.now() + 50))
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

const isVoidInput = (member: ServedMember) =>
  SchemaAST.isVoid(member.input.ast) || SchemaAST.isUndefined(member.input.ast)

/** The Promise client of one served actor type, typed by its caller. */
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

    // Every response carries `durable-now`, so each round trip refreshes the clock.
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
          catch: network,
        })

        const text = yield* Effect.tryPromise({ try: () => response.text(), catch: network })
        const now = response.headers.get("durable-now")

        if (now !== null) clock.observe(sentAt, clock.localNow(), Number(now))
        origin.token.observe(response.headers.get("durable-version"))

        const reply: Reply = { status: response.status, headers: response.headers, text }

        return reply
      })

    const isOk = (reply: Reply) => reply.status >= 200 && reply.status < 300

    const retryWindow = Effect.suspend(() => {
      const cached = origin.window

      if (cached !== undefined) return Effect.succeed(cached)

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

    const mintLocal = Effect.gen(function* () {
      const window = yield* retryWindow

      return clock.mint(window, yield* uuid(4))
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

    const mint = (options.commandIds === "server" ? mintServer : mintLocal).pipe(
      Effect.tap((commandId) =>
        Effect.sync(() => {
          origin.minted.set(commandId, false)
          const oldest = origin.minted.keys().next()

          if (origin.minted.size > MINTED_LIMIT && oldest.done !== true)
            origin.minted.delete(oldest.value)
        }),
      ),
    )

    /** Runs `attempt` until it succeeds or a stop condition holds, surfacing the last failure. */
    const withRetries = <A>(
      attempt: Effect.Effect<A, Attempted>,
      call: QueryOptions,
      commandId: () => string | undefined,
    ): Promise<A> => {
      const retry: Retry = { attempts: 0, futureRetried: false, authRetried: false }
      let last: Failure | undefined

      const loop: Effect.Effect<A, Failure> = attempt.pipe(
        Effect.catch((attempted) =>
          Effect.gen(function* () {
            last = attempted.failure
            const delay = yield* retryDelay(retry, clock)(attempted)
            retry.attempts += 1
            const id = commandId()
            const expiresAt = id === undefined ? undefined : lifetime(id)?.expiresAt

            if (
              Option.isNone(delay) ||
              (expiresAt !== undefined && clock.now() + delay.value >= expiresAt - EXPIRY_MARGIN_MS)
            )
              return yield* attempted.failure

            yield* Effect.sleep(Duration.millis(delay.value))

            return yield* loop
          }),
        ),
      )

      // The outcome of an unanswered command is unknown; its id is what a caller retries later.
      const unanswered = Effect.suspend(() => {
        const id = commandId()

        return Effect.fail(
          last ??
            (id === undefined
              ? network()
              : ActorError.make({ reason: Timeout.make({ commandId: id }) })),
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

      const bounded = loop.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(call.timeoutInMs ?? options.timeoutInMs ?? DEFAULT_TIMEOUT_MS),
          orElse: () => unanswered,
        }),
      )

      return Effect.runPromise(Effect.raceFirst(bounded, aborted))
    }

    const method =
      (member: ServedMember, segment: Effect.Effect<string, ActorError>) =>
      (...args: ReadonlyArray<unknown>) => {
        const isVoid = isVoidInput(member)
        const call: CommandOptions = (isVoid ? args[0] : args[1]) ?? {}
        const isQuery = member.kind === "query"
        let commandId = isQuery ? undefined : call.commandId

        const body = Schema.encodeUnknownEffect(Schema.toCodecJson(member.input))(
          isVoid ? undefined : args[0],
        ).pipe(
          Effect.flatMap((json) =>
            json === undefined ? Effect.succeedNone : Effect.asSome(encodeJson(json)),
          ),
          Effect.mapError(invalid),
        )

        const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(member.output))

        const admitted = (failure: Failure) => {
          if (commandId === undefined || !origin.minted.has(commandId)) return failure

          if (!refusedBeforeTurn(failure)) origin.minted.set(commandId, true)

          if (!isFramework(failure) || !isInvalidCommandId(failure.reason)) return failure

          return ActorError.make({
            reason: InvalidCommandId.make({
              commandId: failure.reason.commandId,
              code: failure.reason.code,
              neverAdmitted: origin.minted.get(commandId) === false,
            }),
          })
        }

        const attempt = Effect.gen(function* () {
          const path = `/actors/${definition.name}${yield* segment}/${member.tag}`
          const payload = Option.getOrUndefined(yield* body)

          if (!isQuery && commandId === undefined) commandId = yield* mint

          const headers: Record<string, string> = {}

          if (payload !== undefined) headers["content-type"] = "application/json"

          if (commandId !== undefined) headers["idempotency-key"] = commandId

          const token = origin.token.value

          if (isQuery && token !== undefined) headers["durable-min-version"] = token

          const reply = yield* send({ method: "POST", path, body: payload, headers })

          if (isOk(reply)) return yield* decodeSuccess((json) => decode(json))(reply)

          const attempted: Attempted = {
            failure: admitted(decodeFailure(declaredDecoder(member))(reply)),
            reply,
          }

          return yield* Effect.fail(attempted)
        }).pipe(
          Effect.mapError((error): Attempted =>
            "failure" in error ? error : { failure: admitted(error), reply: undefined },
          ),
        )

        return withRetries(attempt, call, () => commandId)
      }

    const handle = (id: string, segment: Effect.Effect<string, ActorError>) => ({
      ...Object.fromEntries(
        definition.members.map((member) => [member.tag, method(member, segment)]),
      ),
      ref: { actor: definition.name, id },
    })

    const keyed = (id: string) =>
      handle(
        id,
        definition.encodeId(id).pipe(
          Effect.map((encoded) => `/${encodeURIComponent(encoded)}`),
          Effect.mapError(invalid),
        ),
      )

    const client = {
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
