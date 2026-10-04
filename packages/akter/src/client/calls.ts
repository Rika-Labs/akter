import {
  Clock,
  Duration,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Random,
  Result,
  Schema,
  SchemaAST,
} from "effect"
import { Base64Url } from "effect/encoding"
import type { ServedDefinition, ServedMember } from "../actor/served.ts"
import { ActorError, InvalidCommandId, InvalidInput, Timeout } from "../errors/actor.ts"
import type { ValueSchema } from "../members/command.ts"
import { ConsistencyToken, DatabaseClock, lifetime, retryDeadline } from "./clock.ts"
import type { ClientOptions, QueryOptions } from "./make.ts"
import { openCommandQueue, type Refused } from "./offline/queue.ts"
import {
  aborted,
  decodeFailure,
  decodeSuccess,
  type Failure,
  type Reply,
  networkFailure,
  retryAfterHeader,
} from "./transport.ts"

const JwtClaims = Schema.Struct({ iss: Schema.NonEmptyString, sub: Schema.NonEmptyString })

const decodeJwtPayload = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims))

/**
 * The unverified `iss` and `sub` of a `Bearer` JWT: only a key naming whose
 * queued commands these are, since the server verifies every attempt.
 */
const decodeJwtClaims = (header: string | undefined) => {
  const parts =
    header === undefined ? undefined : /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(header)?.[1]?.split(".")

  if (parts?.length !== 3) return Option.none()

  return Result.match(Base64Url.decodeString(parts[1]!), {
    onFailure: () => Option.none(),
    onSuccess: decodeJwtPayload,
  })
}

const DEFAULT_TIMEOUT_MS = 60_000

const MAX_BACKOFF_MS = 2_000

/** Ids a client remembers minting per origin, so it can tell whether one might have been admitted; the oldest go first. */
const MINTED_LIMIT = 1_024

/** How long a mint waits for the server before it falls back to the retry window and clock offset this page last learned. */
const MINT_PROBE_MS = 3_000

/** Base URLs whose clock and token state are shared per process; the least recently used go first. */
const ORIGIN_LIMIT = 64

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

const isFramework = Schema.is(ActorError)

const isInvalidCommandId = Schema.is(InvalidCommandId)

/** True when a failure proves the attempt was refused before any turn could run. */
const refusedBeforeTurn = (failure: Failure) =>
  isFramework(failure) &&
  Match.value(failure.reason).pipe(
    Match.tags({
      InvalidCommandId: () => true,
      InvalidInput: () => true,
      Unauthorized: (reason) => reason.isCredential,
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
        ConnectionLimitExceeded: () => retryAfterOf(failure),
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

/** `path` under `baseUrl`, without doubling the slash between them. */
export const joinUrl = ({ baseUrl, path }: { readonly baseUrl: string; readonly path: string }) =>
  `${baseUrl.replace(/\/+$/, "")}${path}`

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
export const uuid = (version: 4 | 7) =>
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

export const declaredDecoder = (member: ServedMember) => {
  const cached = declaredDecoders.get(member)

  if (cached !== undefined) return cached

  const decode: (body: Schema.Json) => Option.Option<Failure> =
    member.errors.length === 0
      ? () => Option.none()
      : Schema.decodeUnknownOption(Schema.toCodecJson(Schema.Union(member.errors)))

  declaredDecoders.set(member, decode)

  return decode
}

/** Decodes a success body the way the server writes it: empty for void, `null` for undefined. */
const outputDecoder = (member: ServedMember) => {
  if (SchemaAST.isVoid(member.output.ast)) return () => Effect.void

  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(member.output))

  return (json: Schema.Json | undefined) =>
    json === null ? decode(null).pipe(Effect.catch(() => decode(undefined))) : decode(json)
}

/**
 * The transport attempt policy of one actor type's client at one base URL:
 * fresh headers and credentials for each attempt, the database clock and
 * retry window its ids are minted from, which minted ids might have been
 * admitted, bounded retries under one id, and the offline queue. The typed
 * handle projection lives in `clientOf`; nothing here knows member types.
 */
export const callsOf = ({
  definition,
  options,
}: {
  readonly definition: ServedDefinition
  readonly options: ClientOptions
}) => {
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

  const identity = options.identity

  const principal =
    identity === undefined
      ? Effect.flatMap(authorization, (header) => {
          const claims = decodeJwtClaims(header)

          return Option.isSome(claims)
            ? Effect.succeed(`${claims.value.iss}\n${claims.value.sub}`)
            : Effect.die(
                new Error(
                  "An offline client needs ClientOptions.identity unless its authorization is a Bearer JWT with iss and sub",
                ),
              )
        })
      : Effect.promise(() => Promise.resolve(identity()))

  const send = (request: Request) =>
    Effect.gen(function* () {
      const headers = new Headers(yield* provided)

      for (const [name, value] of Object.entries(request.headers)) headers.set(name, value)

      headers.set("durable-protocol", "1")
      headers.set("accept", "application/json")
      const sentAt = clock.localNow()

      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(joinUrl({ baseUrl: options.baseUrl, path: request.path }), {
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

  /** Opens an SSE response at `path` with fresh headers and `init.headers` set over them. */
  const openEvents = (
    path: Effect.Effect<string, ActorError>,
    signal: AbortSignal,
    init: {
      readonly method?: string
      readonly body?: string | undefined
      readonly headers: Readonly<Record<string, string>>
    },
  ) =>
    Effect.gen(function* () {
      const headers = new Headers(yield* provided)

      for (const [name, value] of Object.entries(init.headers)) headers.set(name, value)

      headers.set("accept", "text/event-stream")
      headers.set("durable-protocol", "1")
      const url = joinUrl({ baseUrl: options.baseUrl, path: yield* path })

      return yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: init.method,
            headers,
            body: init.body,
            signal,
          }),
        catch: networkFailure,
      })
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

    const bounded = work.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(call.timeoutInMs ?? options.timeoutInMs ?? DEFAULT_TIMEOUT_MS),
        orElse: () => unanswered,
      }),
    )

    return Effect.runPromise(
      Effect.raceFirst(bounded, aborted(call.signal).pipe(Effect.andThen(unanswered))),
    )
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

  /** `error` as a failed attempt: its own, or a failure before any request, reported for `commandId`. */
  const asAttempt =
    (commandId: string | undefined) =>
    (error: Attempted | Failure): Attempted =>
      "failure" in error ? error : { failure: admittedFor(commandId)(error), reply: undefined }

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
      }).pipe(Effect.mapError(asAttempt(commandId)))
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
          principal,
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

  return {
    authorization,
    token: origin.token,
    openEvents,
    mint,
    waiting,
    withRetries,
    asAttempt,
    poster,
    queue,
    /** A fresh command id, retried like a call until it is minted. */
    commandId: () =>
      withRetries(mint.pipe(Effect.mapError(asAttempt(undefined))), {}, () => undefined),
  }
}
