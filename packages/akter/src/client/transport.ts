import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  JsonPatch,
  Layer,
  Option,
  Predicate,
  Random,
  Result,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import type { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import { ActorError, Reason, TransportError } from "../contract/errors.ts"
import { Client } from "../contract/handle.ts"
import type { StateFrame, Transport } from "../contract/handle.ts"
import type { AnyActor } from "../contract/make.ts"
import { CommandIds, commandLifetime } from "../execution/command-ids.ts"
import { ActionFailed, ErrorEnvelope, FindCodec, groupOf, SPAN_PREFIX, Tags } from "../rpc/group.ts"
import type { Frame } from "../rpc/group.ts"

/** Where the client connects and as whom. */
export interface ClientOptions {
  /**
   * The server's `/rpc` URL. `ws:` and `wss:` hold one WebSocket session (JSON); `http:` and
   * `https:` send each call as its own `POST` (NDJSON).
   */
  readonly url: string
  /** The actor contracts this client calls; their calls form the RPC group it speaks. */
  readonly actors: ReadonlyArray<AnyActor>
  /**
   * Headers sent on every HTTP request and on each WebSocket upgrade. Browsers cannot set
   * upgrade headers, so a browser's WebSocket session authenticates with cookies.
   */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * A fresh `authorization` value (`Bearer <token>`), read for every HTTP request and each
   * WebSocket upgrade, and sent as `$reauthenticate` every `reauthenticateEvery` to keep a
   * WebSocket session within the server's reauthorization bound.
   */
  readonly authorization?: Effect.Effect<string>
  /** How often a WebSocket session renews its credential when `authorization` is set; default 30 seconds. */
  readonly reauthenticateEvery?: Duration.Input
}

type CallFailure = ActorError | typeof ActionFailed.Type

const isClientError = (error: CallFailure | RpcClientError.RpcClientError) =>
  Predicate.isTagged(error, "RpcClientError")

/**
 * A response that never arrived as a valid envelope. A lost connection is safe to retry: an
 * command resends its command id, so the server runs it at most once, and a read resubscribes.
 */
const transportError = (error: RpcClientError.RpcClientError) =>
  ActorError.make({
    reason: Predicate.isTagged(error.reason, "RpcClientDefect")
      ? TransportError.make({ code: "decode", retrySafe: false })
      : TransportError.make({ code: "network", retrySafe: true }),
  })

const fromWire = <E extends CallFailure>(error: E | RpcClientError.RpcClientError) =>
  isClientError(error) ? transportError(error as RpcClientError.RpcClientError) : (error as E)

/** Whether a session ended at its reauthorization bound, which only a new session recovers from. */
const lapsed = (error: CallFailure) =>
  Schema.is(ActorError)(error) &&
  Reason.guards.Unauthorized(error.reason) &&
  error.reason.code === "reauthorization_unavailable"

/** The WebSocket a session currently runs over, so a lapsed session can be replaced. */
interface Connection {
  socket: globalThis.WebSocket | undefined
}

/**
 * Closes the session's socket after it lapsed; the protocol reconnects with fresh headers, which
 * opens a new session, and the calls retried meanwhile run on it. A socket already closing is left
 * alone, so the errors of one lapse close it once.
 */
const reconnect = (connection: Connection) =>
  Effect.sync(() => {
    if (connection.socket?.readyState === 1) connection.socket.close(1000, "reauthorize")
  })

/**
 * Retries a call with the same command id while its error is retryable and the id has not
 * expired: waiting the error's own `retryAfter` (100 ms for a lost connection) first, doubling up
 * to the greater of 500 ms and that first wait, each wait jittered by ±50%.
 */
const retrying = <A, E extends CallFailure>(attempt: Effect.Effect<A, E>, until: number) =>
  Effect.gen(function* () {
    let wait: number | undefined
    while (true) {
      const result = yield* Effect.result(attempt)
      if (Result.isSuccess(result)) return result.success
      const error = result.failure
      if (!Schema.is(ActorError)(error) || !error.isRetryable) return yield* Effect.fail(error)
      if ((yield* Clock.currentTimeMillis) >= until) return yield* error
      const first = error.retryAfter ?? 100
      wait = wait === undefined ? first : Math.min(wait * 2, Math.max(500, first))
      yield* Effect.sleep(Duration.millis(wait * (0.5 + (yield* Random.next))))
    }
  })

/** Resubscribes a stream after a retryable end; the server starts every new stream with a full value. */
const resubscribing = <A>(open: () => Stream.Stream<A, ActorError>): Stream.Stream<A, ActorError> =>
  open().pipe(
    Stream.catch((error) =>
      error.isRetryable
        ? Stream.unwrap(
            Effect.as(
              Effect.flatMap(Random.next, (jitter) =>
                Effect.sleep(Duration.millis((error.retryAfter ?? 100) * (0.5 + jitter))),
              ),
              resubscribing(open),
            ),
          )
        : Stream.fail(error),
    ),
  )

interface Delivered {
  readonly value: Schema.Json
  readonly text: string | undefined
}

/**
 * Drops a frame that leaves the delivered value unchanged. A resubscription starts again with a
 * full frame, sometimes at a newer version of the same value, so a reconnect never repeats one.
 */
const unrepeated = <F extends Frame | StateFrame>(frames: Stream.Stream<F, ActorError>) =>
  frames.pipe(
    Stream.mapAccum(
      (): Delivered => ({ value: null, text: undefined }),
      (
        current,
        frame,
      ): readonly [
        Delivered,
        ReadonlyArray<{ readonly frame: F; readonly value: Schema.Json }>,
      ] => {
        const value =
          frame.kind === "Frame" ? frame.value : JsonPatch.apply(frame.ops, current.value)
        const text = JSON.stringify(value)
        return [{ value, text }, text === current.text ? [] : [{ frame, value }]]
      },
    ),
  )

/** Wire frames to the full values they carry, without repeats. */
const unframed = (frames: Stream.Stream<Frame, ActorError>) =>
  Stream.map(unrepeated(frames), ({ value }) => value)

const makeTransport = (options: ClientOptions, connection: Connection) =>
  Effect.gen(function* () {
    const flat = yield* RpcClient.make(groupOf(options.actors), {
      spanPrefix: SPAN_PREFIX,
      flatten: true,
    })
    const unary = <A, E extends CallFailure = ActorError>(
      tag: string,
      payload: Parameters<typeof flat>[1],
    ): Effect.Effect<A, E | ActorError> =>
      Effect.mapError(
        flat(tag, payload) as Effect.Effect<A, E | RpcClientError.RpcClientError>,
        fromWire,
      ).pipe(Effect.tapError((error) => (lapsed(error) ? reconnect(connection) : Effect.void)))
    const streamed = <A>(
      tag: string,
      payload: Parameters<typeof flat>[1],
    ): Stream.Stream<A, ActorError> =>
      resubscribing(() =>
        Stream.mapError(
          flat(tag, payload) as Stream.Stream<A, ActorError | RpcClientError.RpcClientError>,
          fromWire,
        ).pipe(Stream.tapError((error) => (lapsed(error) ? reconnect(connection) : Effect.void))),
      )

    const transport: Transport = {
      call: (request) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const commandId = yield* CommandIds.mint(now)
          return yield* retrying(
            unary<{ readonly value: Schema.Json }, CallFailure>(
              Tags.action(request.actor.name, request.member),
              { id: request.id, commandId, payload: request.payload },
            ),
            now + commandLifetime,
          ).pipe(
            Effect.map((success) => ({ kind: "Success" as const, value: success.value })),
            Effect.catchIf(
              (error): error is typeof ActionFailed.Type => Schema.is(ActionFailed)(error),
              (failed) => Effect.succeed({ kind: "Failure" as const, error: failed.error }),
            ),
          )
        }),
      state: (target) => streamed<StateFrame>(Tags.state(target.actor.name), { id: target.id }),
      view: (request) =>
        unframed(
          streamed<Frame>(Tags.view(request.actor.name, request.member), {
            id: request.id,
            params: request.params,
          }),
        ),
      broadcast: (request) =>
        streamed<Schema.Json>(Tags.event(request.actor.name, request.member), { id: request.id }),
      range: (request) =>
        retrying(
          unary<ReadonlyArray<Schema.Json>>(Tags.range(request.actor.name, request.member), {
            id: request.id,
            ...request.range,
          }),
          Number.POSITIVE_INFINITY,
        ),
      watch: (request) =>
        unframed(
          streamed<Frame>(Tags.watch(request.actor.name, request.member), {
            id: request.id,
            ...request.range,
          }),
        ).pipe(Stream.map((items) => (Array.isArray(items) ? items : []))),
      join: (request) =>
        Effect.gen(function* () {
          const joined = yield* Deferred.make<void, ActorError>()
          yield* streamed<"joined">(Tags.join(request.actor.name), {
            id: request.id,
            presence: request.presence,
          }).pipe(
            Stream.runForEach(() => Deferred.succeed(joined, undefined)),
            Effect.catch((error) => Deferred.fail(joined, error)),
            Effect.forkScoped,
          )
          yield* Deferred.await(joined)
        }),
      find: (request) =>
        Effect.flatMap(FindCodec.encode(request.actor, request.query), (query) =>
          retrying(
            unary<ReadonlyArray<Schema.Json>>(Tags.find(request.actor.name), query),
            Number.POSITIVE_INFINITY,
          ),
        ),
    }

    const authorization = options.authorization
    if (authorization !== undefined && isSocket(options.url))
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.flatMap(
            Effect.sleep(Duration.fromInputUnsafe(options.reauthenticateEvery ?? "30 seconds")),
            () =>
              Effect.ignore(
                Effect.flatMap(authorization, (value) =>
                  unary<void>(Tags.reauthenticate, { authorization: value }),
                ),
              ),
          ),
        ),
      )
    return transport
  })

const isSocket = (url: string) => url.startsWith("ws:") || url.startsWith("wss:")

const headersOf = (options: ClientOptions): Effect.Effect<Record<string, string>> =>
  options.authorization === undefined
    ? Effect.succeed({ ...options.headers })
    : Effect.map(options.authorization, (authorization) => ({ ...options.headers, authorization }))

/**
 * Opens the runtime's own `WebSocket`. Bun's and Node's accept `{ headers }` as the second
 * argument and send them on the upgrade; the DOM's type, which this package compiles against,
 * only knows subprotocols, and a browser is never given headers.
 */
const openWebSocket = (url: string, headers: Record<string, string>) =>
  Object.keys(headers).length === 0
    ? new globalThis.WebSocket(url)
    : new globalThis.WebSocket(url, { headers } as never)

/**
 * The WebSocket a session runs over, opened again with fresh headers on every reconnect. The
 * runtime's own `WebSocket` sends upgrade headers on Bun and Node; a browser's takes none.
 */
const socketLayer = (options: ClientOptions, connection: Connection) =>
  Layer.effect(
    Socket.Socket,
    Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.map(headersOf(options), (headers) => {
          const socket = openWebSocket(options.url, headers)
          connection.socket = socket
          return socket
        }),
        (socket) => Effect.sync(() => socket.close(1000)),
      ),
    ),
  )

const RequestId = Schema.Union([Schema.String, Schema.Finite])

const RequestLine = Schema.fromJsonString(Schema.Struct({ id: RequestId }))

const RefusalBody = Schema.fromJsonString(ErrorEnvelope)

/** The RPC exit a refusal stands for. */
const RefusalExit = Schema.TaggedStruct("Exit", {
  requestId: RequestId,
  exit: Schema.Exit(Schema.Void, ErrorEnvelope, Schema.Defect()),
})

/** The refusal's exit as the NDJSON line the protocol reads. */
const encodeRefusal = Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(RefusalExit)))

/**
 * A refusal answered before the RPC handler (`401`, `403`, `429`, `503`) carries the `ActorError`
 * envelope instead of RPC messages. This turns it into the call's failed exit, so the caller
 * receives the envelope's error, not a transport failure.
 */
const refusalsAsExits = <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
  HttpClient.transformResponse(client, (effect) =>
    Effect.flatMap(effect, (response) =>
      Effect.gen(function* () {
        if (response.status === 200) return response
        const body = response.request.body
        const line = Predicate.isTagged(body, "Uint8Array")
          ? new TextDecoder().decode(body.body).split("\n")[0]
          : undefined
        const request = Schema.decodeOption(RequestLine)(line ?? "")
        const error = Schema.decodeOption(RefusalBody)(
          yield* Effect.orElseSucceed(response.text, () => ""),
        )
        if (Option.isNone(request) || Option.isNone(error)) return response
        const exit = yield* Effect.orDie(
          encodeRefusal(
            RefusalExit.make({ requestId: request.value.id, exit: Exit.fail(error.value) }),
          ),
        )
        return HttpClientResponse.fromWeb(
          response.request,
          new Response(`${exit}\n`, {
            status: 200,
            headers: { "content-type": "application/ndjson" },
          }),
        )
      }),
    ),
  )

/** The RPC protocol for the URL's scheme over `connection`, which holds the current socket. */
const connected = (options: ClientOptions, connection: Connection) =>
  isSocket(options.url)
    ? RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
        Layer.provide([socketLayer(options, connection), RpcSerialization.layerJson]),
      )
    : RpcClient.layerProtocolHttp({
        url: options.url,
        transformClient: (client) =>
          refusalsAsExits(
            HttpClient.mapRequestEffect(client, (request) =>
              Effect.map(headersOf(options), (headers) =>
                HttpClientRequest.setHeaders(request, headers),
              ),
            ),
          ),
      }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]))

/**
 * The `Client` every handle calls through, over `/rpc`. Each command mints a command id from the
 * client's clock and retries with that same id after a lost connection or a retryable refusal;
 * each stream resubscribes after a lost connection and starts again from a full value. A WebSocket
 * session that lapses at its reauthorization bound is replaced by reconnecting.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const room = yield* Room.client("lobby")
 *   yield* room.post("hello")
 * }).pipe(
 *   Effect.scoped,
 *   Effect.provide(AkterClient.layer({ url: "wss://example.com/rpc", actors: [Room] })),
 * )
 * ```
 */
/** The RPC protocol for the URL's scheme: one WebSocket session, or a `POST` per call. */
export const protocolLayer = (options: ClientOptions) => connected(options, { socket: undefined })

const layer = (options: ClientOptions): Layer.Layer<Client> =>
  Layer.unwrap(
    Effect.sync(() => {
      const connection: Connection = { socket: undefined }
      return Layer.effect(Client, makeTransport(options, connection)).pipe(
        Layer.provide(connected(options, connection)),
      )
    }),
  )

/** The Effect client over `/rpc`. */
export const AkterClient = { layer }
