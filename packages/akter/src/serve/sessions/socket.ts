import {
  Data,
  DateTime,
  Effect,
  Match,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect"
import { Socket } from "effect/socket"
import type { ServedConnection } from "../../actor/served.ts"
import { ActorError, SessionEnded, Unauthorized } from "../../errors/actor.ts"
import { type ActorRef, callerKey } from "../../identity/caller.ts"
import { type Holder, MAX_INBOUND_BYTES } from "../../runtime/connections/holder.ts"
import { ClientMessage } from "../../runtime/connections/protocol.ts"
import type { Authenticated } from "../auth.ts"
import { ClientWireMessage, ServerWireMessage } from "../../protocol/frames.ts"
import { actorErrorBody, closeCodeOf } from "../../protocol/wire.ts"
import { invalidInput, undecodable } from "../wire.ts"

/** How long a socket may wait after its upgrade for `hello`. */
const HELLO_TIMEOUT_MS = 10_000

/** Sockets one runner holds between their upgrade and their `hello`. */
export const MAX_AWAITING_HELLO = 1_000

/** Renewal is asked for this long before a credential expires, or at half its life if sooner. */
const REAUTHENTICATE_LEAD_MS = 60_000

/** Binary messages are refused with this close code. */
const UNSUPPORTED_DATA = 1003

/** An inbound message over the frame limit closes with this code. */
const MESSAGE_TOO_BIG = 1009

/** A declared `open` failure closes with this code. */
const DECLARED_FAILURE = 4400

const utf8 = new TextEncoder()

const encodeServerMessage = Schema.encodeEffect(Schema.fromJsonString(ServerWireMessage))

const decodeClientMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientWireMessage))

/** A progress frame as the effect's progress schema encoded it, as the JSON value a client reads. */
const progressFrame = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

/** Ends a session: the `end` message's error and the close code after it. */
class Refusal extends Data.TaggedError("Refusal")<{
  readonly error: ActorError
  readonly code: number
}> {}

const refuse = (error: ActorError, code = closeCodeOf(error.reason)) => new Refusal({ error, code })

const decodeFailed = () => refuse(invalidInput("decode"))

const expiryOf = (authenticated: Authenticated) =>
  authenticated.expiresAt === undefined
    ? undefined
    : DateTime.toEpochMillis(authenticated.expiresAt)

/** Whether two credentials name the same tenant, caller, and, when bound, session. */
const samePrincipal = (left: Authenticated, right: Authenticated) =>
  left.tenant === right.tenant &&
  callerKey(left.caller) === callerKey(right.caller) &&
  left.binding?.session === right.binding?.session

const differentIdentity = () =>
  refuse(ActorError.make({ reason: Unauthorized.make({ code: "invalid_credentials" }) }))

const isHello = (
  message: ClientWireMessage,
): message is Extract<ClientWireMessage, { readonly t: "hello" }> => message.t === "hello"

/** What `socketSession` needs to run one upgraded socket. */
interface SessionOptions {
  /** The upgraded socket. */
  readonly socket: Socket.Socket
  /** The served connection member the session belongs to. */
  readonly connection: ServedConnection
  /** Opens and drives the connection on the actor's owner. */
  readonly holder: Holder
  /** The actor the session's connection belongs to, in the authenticated tenant. */
  readonly ref: (tenant: string) => ActorRef
  /** The principal the upgrade request's own credential proved, if it carried one. */
  readonly upgrade: Authenticated | undefined
  /** Authenticates a frame credential, or, with `undefined`, the upgrade request as it is. */
  readonly authenticate: (
    credential: string | undefined,
  ) => Effect.Effect<Authenticated, ActorError>
  /** Authenticates a `reauthenticate` frame's credential. */
  readonly reauthenticate: (credential: string) => Effect.Effect<Authenticated, ActorError>
  /** Frees the socket's place among those awaiting `hello`; runs once. */
  readonly greeted: Effect.Effect<void>
}

/**
 * Runs one upgraded connection socket until it ends: `hello`, the holder's
 * open, then member frames both ways with the holder's control messages in
 * their own envelope, renewal of the credential before it expires, and an
 * `end` message and close code as the session's last words.
 *
 * Ordering and guarantees:
 * - `hello` comes first; nothing is authenticated or woken before it decodes.
 * - Only text messages are read. Each is bounded as a whole, so a frame inside
 *   it is too, and an unknown `t` fails to decode; both end the session.
 * - However the session stops, even by interruption when the server drops the
 *   socket or shuts down, the holder closes the connection and the owner its
 *   row. Once close publishes the ended session, cleanup cannot be interrupted
 *   by the outbound reader finishing first, or the durable row would remain.
 * - A failed write means the peer is gone; it ends the session like a close.
 * - Frames carry cursors only when the holder stamped them; `stampCursor:
 *   false` has none. Executor progress has its own message, never `frame`, and
 *   no cursor: it is not replayed.
 * - Backpressure: the socket is not read while the holder has a full window of
 *   frames in flight.
 * - Identity never changes mid-session, and a bound credential also names its
 *   session, which never changes either; a different caller reconnects. A
 *   refused renewal ends the session at the holder, which reports it.
 * - The client is asked for a fresh credential ahead of the current one's
 *   expiry; a renewal that arrives before it was asked for moves the next ask.
 */
export const socketSession = Effect.fnUntraced(function* (options: SessionOptions) {
  const { connection, holder } = options
  const writer = yield* options.socket.writer
  const reader = yield* options.socket.reader.pipe(Effect.option)

  if (Option.isNone(reader)) return

  let finished = false
  let buffered: Array<string | Uint8Array> = []

  const write = (message: ServerWireMessage) =>
    encodeServerMessage(message).pipe(Effect.orDie, Effect.flatMap(writer.write))

  const send = (message: ServerWireMessage) =>
    Effect.suspend(() => (finished ? Effect.void : write(message)))

  const finish = (error: Schema.Json | undefined, code: number) =>
    Effect.suspend(() => {
      if (finished) return Effect.void
      finished = true

      return write({ t: "end", error }).pipe(
        Effect.andThen(writer.write(new Socket.CloseEvent(code))),
        Effect.ignore,
      )
    })

  const finishWith = (refusal: Refusal) =>
    actorErrorBody(refusal.error).pipe(Effect.flatMap((body) => finish(body, refusal.code)))

  const nextRaw: Effect.Effect<string | Uint8Array, Socket.SocketError> = Effect.suspend(() => {
    const head = buffered.shift()

    if (head !== undefined) return Effect.succeed(head)

    return reader.value.pull.pipe(
      Effect.map((batch) => {
        buffered = batch.slice(1)

        return batch[0]
      }),
    )
  })

  const parse = (raw: string | Uint8Array) =>
    Effect.gen(function* () {
      if (!Predicate.isString(raw)) return yield* refuse(invalidInput("decode"), UNSUPPORTED_DATA)

      if (utf8.encode(raw).byteLength > MAX_INBOUND_BYTES)
        return yield* refuse(
          ActorError.make({ reason: SessionEnded.make({ cause: "Defect", resync: false }) }),
          MESSAGE_TOO_BIG,
        )

      return yield* decodeClientMessage(raw).pipe(
        Effect.mapError((error) => error.pipe(undecodable, refuse)),
      )
    })

  const hello = yield* nextRaw.pipe(
    Effect.timeoutOption(HELLO_TIMEOUT_MS),
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(decodeFailed()), onSome: parse })),
    Effect.filterOrFail(isHello, decodeFailed),
    Effect.ensuring(options.greeted),
    Effect.result,
  )

  if (Result.isFailure(hello)) {
    if (Predicate.isTagged(hello.failure, "Refusal")) yield* finishWith(hello.failure)

    return
  }

  const opened = yield* Effect.gen(function* () {
    const proved =
      hello.success.authorization === undefined
        ? undefined
        : yield* options.authenticate(hello.success.authorization).pipe(Effect.mapError(refuse))

    if (
      proved !== undefined &&
      options.upgrade !== undefined &&
      !samePrincipal(proved, options.upgrade)
    )
      return yield* differentIdentity()

    const principal =
      proved ??
      options.upgrade ??
      (yield* options.authenticate(undefined).pipe(Effect.mapError(refuse)))

    const params = yield* connection
      .openParams(hello.success.params)
      .pipe(Effect.mapError((error) => error.pipe(undecodable, refuse)))

    const held = yield* holder
      .open({
        ref: options.ref(principal.tenant),
        member: connection.tag,
        caller: principal.caller,
        params,
        expiresAt: expiryOf(principal),
      })
      .pipe(
        Effect.catchTag("OpenRejected", (rejected) =>
          connection.openFailure(rejected.value).pipe(
            Effect.orDie,
            Effect.flatMap((error) => finish(error, DECLARED_FAILURE)),
            Effect.andThen(Effect.fail(undefined)),
          ),
        ),
        Effect.mapError((error) => (error === undefined ? undefined : refuse(error))),
      )

    return { held, principal }
  }).pipe(Effect.result)

  if (Result.isFailure(opened)) {
    if (opened.failure !== undefined) yield* finishWith(opened.failure)

    return
  }

  const { held, principal } = opened.success
  const close = Effect.uninterruptible(held.close)

  const shutdown = refuse(
    ActorError.make({ reason: SessionEnded.make({ cause: "HolderShutdown", resync: true }) }),
  )

  yield* Effect.addFinalizer(() => finishWith(shutdown).pipe(Effect.andThen(close)))

  let expiresAt = expiryOf(principal)
  const renewed = yield* Queue.sliding<void>(1)

  const gone = Effect.sync(() => {
    finished = true
  }).pipe(Effect.andThen(close))

  const opening = send({
    t: "open",
    connectionId: held.connectionId,
    baseline: connection.stampCursor ? held.cursor : undefined,
    reauthenticateBy: expiresAt,
  })

  const wire = ClientMessage.match({
    Frame: (message) =>
      connection.serverFrame(message.frame).pipe(
        Effect.orDie,
        Effect.map((frame): ServerWireMessage => ({
          t: "frame",
          frame,
          cursor: message.cursor,
          event: message.event,
        })),
      ),
    Resync: (message) =>
      Effect.succeed<ServerWireMessage>({
        t: "resync",
        after: connection.stampCursor ? message.after : undefined,
        reason: message.reason,
        deadline: message.deadlineMs,
      }),
    ResyncReplayed: () => Effect.succeed<ServerWireMessage>({ t: "resyncReplayed" }),
    Progress: (message) =>
      progressFrame(message.frame).pipe(
        Effect.orDie,
        Effect.map((frame): ServerWireMessage => ({
          t: "progress",
          job: message.job,
          jobId: message.jobId,
          attempt: message.attempt,
          seq: message.seq,
          frame,
        })),
      ),
  })

  const outbound = held.messages.pipe(
    Stream.runForEach((message) => wire(message).pipe(Effect.flatMap(send))),
    Effect.matchEffect({
      onFailure: (error) =>
        Predicate.isTagged(error, "SocketError") ? gone : error.pipe(refuse, finishWith),
      onSuccess: () => finish(undefined, 1000),
    }),
  )

  const renew = (credential: string) =>
    Effect.gen(function* () {
      const fresh = yield* options.reauthenticate(credential).pipe(Effect.mapError(refuse))

      if (!samePrincipal(fresh, principal)) return yield* differentIdentity()

      const next = expiryOf(fresh)

      const accepted = yield* held.reauthenticate(next).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )

      if (!accepted) return
      expiresAt = next
      yield* send({ t: "reauthenticated", by: next })
      yield* Queue.offer(renewed, undefined)
    })

  const handle = Match.type<ClientWireMessage>().pipe(
    Match.discriminatorsExhaustive("t")({
      frame: (message) =>
        connection.clientFrame(message.frame).pipe(
          Effect.mapError((error) => error.pipe(undecodable, refuse)),
          Effect.tap(() => held.writable),
          Effect.flatMap((frame) => held.send(frame).pipe(Effect.ignore)),
        ),
      resyncDone: () => held.resyncDone,
      reauthenticate: (message) => renew(message.authorization),
      hello: () => Effect.fail(decodeFailed()),
    }),
  )

  const inbound = nextRaw.pipe(
    Effect.flatMap(parse),
    Effect.flatMap(handle),
    Effect.forever,
    Effect.catchTag("Refusal", (refusal) => finishWith(refusal).pipe(Effect.andThen(close))),
    Effect.catch(() => close),
  )

  const reauthenticate = Effect.gen(function* () {
    while (true) {
      const deadline = expiresAt

      if (deadline === undefined) return yield* Effect.never

      const now = yield* holder.now
      const askAt = Math.min(deadline - REAUTHENTICATE_LEAD_MS, now + (deadline - now) / 2)

      const early = yield* Queue.take(renewed).pipe(Effect.timeoutOption(Math.max(0, askAt - now)))

      if (Option.isSome(early)) continue

      yield* send({ t: "reauthenticate", by: deadline })
      yield* Queue.take(renewed)
    }
  }).pipe(Effect.catchTag("SocketError", () => gone))

  yield* opening.pipe(
    Effect.andThen(Effect.raceAll([outbound, inbound, reauthenticate])),
    Effect.catchTag("SocketError", () => gone),
  )
})
