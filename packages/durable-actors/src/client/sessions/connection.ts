import { Data, Deferred, Effect, Match, Option, Predicate, Queue, Schema, Stream } from "effect"
import type { ServedConnection } from "../../actor/served.ts"
import { ActorError, SessionEnded } from "../../errors/actor.ts"
import type { ValueSchema } from "../../members/command.ts"
import type { AnyConnection } from "../../members/connection.ts"
import type { ProgressEffect } from "../../members/effect.ts"
import { ClientWireMessage, ServerWireMessage, SUBPROTOCOL } from "../../serve/frames.ts"
import { decodeFailure, type Failure, undecodableFailure } from "../transport.ts"

/**
 * One effect's progress as its client receives it: the effect's tag and a
 * frame decoded by that effect's `progress` schema. Unions over the effects a
 * connection member lists, so narrowing on `effect` types `frame`.
 */
export type ProgressUpdate<E extends ProgressEffect = ProgressEffect> = E extends ProgressEffect
  ? { readonly effect: E["tag"]; readonly frame: E["progress"]["Type"] }
  : never

/** The progress a connection member's client receives: one update per effect the member lists. */
export type ProgressOfConnection<M extends AnyConnection> = ProgressUpdate<
  NonNullable<M["progress"]>["effects"][number]
>

type Messages<Frame> = Data.TaggedEnum<{
  Frame: {
    readonly frame: Frame
    /** The flushed-through event cursor the frame was sent above; absent under `stampCursor: false`. */
    readonly cursor: string | undefined
    /** The cursor of the event the frame was sent from, to deduplicate on after a resync. */
    readonly event: string | undefined
  }
  /** The actor's owner died; frames since `after` may be lost. Replay events after it, or reload state. */
  Resync: {
    readonly after: string | undefined
    readonly reason: "OwnerLost"
    /** Milliseconds the client has to resynchronize before the connection closes. */
    readonly deadline: number
  }
  ResyncReplayed: {}
  Progress: ProgressUpdate & {
    readonly effectId: string
    readonly attempt: number
    readonly seq: number
  }
}>

/**
 * An executor's progress on an effect the member lists: display-only, lossy,
 * and never replayed after a resync. `frame` is decoded by that effect's
 * `progress` schema; `seq` counts the attempt's reports, so a gap is a dropped one.
 */
export type ProgressMessage<Progress extends ProgressUpdate = ProgressUpdate> = Extract<
  Messages<never>,
  { readonly _tag: "Progress" }
> &
  Progress

/**
 * What a connection's client receives, in order: member frames, the holder's
 * resync notices, and executor progress for a member that lists effects.
 * `Progress` is the member's `ProgressUpdate`, so its messages narrow by `effect`.
 */
export type ConnectionMessage<Frame, Progress extends ProgressUpdate = ProgressUpdate> =
  | Exclude<Messages<Frame>, { readonly _tag: "Progress" }>
  | ProgressMessage<Progress>

interface ConnectionMessageDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Messages<this["A"]>
}

const ConnectionMessage = Data.taggedEnum<ConnectionMessageDefinition>()

type FrameMessage<Frame> = Extract<Messages<Frame>, { readonly _tag: "Frame" }>

/** Options of one `connect` call. */
export interface ConnectOptions {
  /** Stops waiting for the connection to open. */
  readonly signal?: AbortSignal
  /**
   * Resynchronizes after an owner loss: replay events after `after`, or reload
   * state. The connection acknowledges the resync once this settles; without
   * it, the resync is acknowledged at once and only seen in `messages`. A
   * callback that throws, at once or later, still settles the acknowledgment.
   */
  readonly onResync?: (resync: { readonly after: string | undefined }) => void | Promise<void>
}

/** An open connection: typed frames both ways. */
export interface ClientConnection<
  Server,
  Client,
  Progress extends ProgressUpdate = ProgressUpdate,
> {
  /** The server's id for this connection. */
  readonly connectionId: string
  /** The flushed-through event cursor when it opened: replay events after it to catch up. */
  readonly cursor: string | undefined
  /**
   * Every message in order. The iteration ends when this client closes the
   * connection and throws its `ActorError` otherwise: `SessionEnded`
   * `ServerClosed` when the actor closed it, and `HolderLost` with
   * `resync: true` for a dropped socket. Consume either this or `frames`, not both.
   */
  readonly messages: AsyncIterable<ConnectionMessage<Server, Progress>>
  /** The member frames of `messages`, without the resync notices or progress. */
  readonly frames: AsyncIterable<Server>
  /** Sends one frame; rejects with `SessionEnded` `HolderLost` once the session ended or its socket stopped being open. */
  readonly send: (frame: Client) => Promise<void>
  /** Closes the connection. The `messages` iteration then ends without an error. */
  readonly close: () => Promise<void>
}

interface SocketSource {
  readonly member: ServedConnection
  readonly url: string
  /** The `authorization` credential to send in `hello` and `reauthenticate`, read afresh each time. */
  readonly authorization: Effect.Effect<string | undefined>
  readonly params: ValueSchema["Type"]
  readonly options: ConnectOptions
}

const encodeClient = Schema.encodeEffect(Schema.fromJsonString(ClientWireMessage))

const decodeServer = Schema.decodeUnknownOption(Schema.fromJsonString(ServerWireMessage))

const decodeTagged = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ t: Schema.String })),
)

const KNOWN: ReadonlySet<string> = new Set(
  ServerWireMessage.members.map((member) => member.fields.t.literal),
)

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

/** A frame's event cursor as a position, or `undefined` for text that isn't one. */
const eventPosition = (cursor: string) =>
  Option.getOrUndefined(Schema.decodeOption(Schema.BigIntFromString)(cursor))

const ended = (cause: SessionEnded["cause"], resync: boolean) =>
  ActorError.make({ reason: SessionEnded.make({ cause, resync }) })

const holderLost = ended("HolderLost", true)

const isClientClosed = (failure: Failure) =>
  Schema.is(ActorError)(failure) &&
  Schema.is(SessionEnded)(failure.reason) &&
  failure.reason.cause === "ClientClosed"

/** Ends the message stream without an error. */
const DONE = "done"

/**
 * Opens one connection over WebSocket: `hello` with the credential and
 * params, then member frames both ways. It resolves once the server sent
 * `open`, and rejects with the declared `open` failure or the `ActorError`
 * that refused it.
 *
 * The credential is read before the socket opens, so a provider that throws
 * or rejects fails `connect` with its own error; it is read again for each
 * renewal, and a provider that fails then leaves the old credential to expire,
 * which the server ends the session at. Incoming messages are handled one at
 * a time, in arrival order, with the socket's close after them. A message
 * with a `t` this client doesn't know is ignored, as the protocol says; one
 * that is broken ends the session, as does a frame cursor that isn't a
 * position. Nothing reads the socket once the session ends, so a failure this
 * client detected closes it too. After a resync, a frame whose event the
 * client already had is a duplicate and is dropped. Progress is lossy by
 * design: one this client can't read is dropped and the session goes on. The
 * holder ignores a resync acknowledgment before the member's own replay; a
 * second one after it is harmless.
 */
export const connect = <Server, Client>({
  member,
  url,
  authorization,
  params,
  options,
}: SocketSource): Promise<ClientConnection<Server, Client>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Effect.context<never>()
      const run = Effect.runForkWith(services)
      const encodeParams = Schema.encodeUnknownEffect(Schema.toCodecJson(member.params))
      const encodeFrame = Schema.encodeUnknownEffect(Schema.toCodecJson(member.client))
      const decodeFrame = Schema.decodeUnknownEffect(Schema.toCodecJson(member.server))

      const progressDecoders = new Map(
        [...member.progress].map(([tag, schema]) => [
          tag,
          Schema.decodeUnknownEffect(Schema.toCodecJson(schema)),
        ]),
      )

      const declared: (body: Schema.Json) => Option.Option<Failure> =
        member.errors.length === 0
          ? () => Option.none()
          : Schema.decodeUnknownOption(Schema.toCodecJson(Schema.Union(member.errors)))

      const failureOf = (error: Schema.Json | undefined) =>
        error === undefined
          ? Effect.succeed<Failure>(ended("ServerClosed", false))
          : encodeJson(error).pipe(
              Effect.orDie,
              Effect.map((text) =>
                decodeFailure(declared)({ status: 0, headers: new Headers(), text, sentAt: 0 }),
              ),
            )

      const hello = yield* encodeParams(params).pipe(Effect.mapError(undecodableFailure))
      const messages = yield* Queue.unbounded<ConnectionMessage<Server>, Failure | typeof DONE>()
      const inbox = yield* Queue.unbounded<string>()

      const opened = yield* Deferred.make<
        { readonly connectionId: string; readonly baseline: string | undefined },
        Failure
      >()

      const credential = yield* authorization
      const ws = new WebSocket(url, SUBPROTOCOL)
      let finished = false
      let highest = -1n
      let resync: { settled: boolean } | undefined = undefined

      const write = (message: ClientWireMessage) =>
        encodeClient(message).pipe(
          Effect.orDie,
          Effect.map((text) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(text)
          }),
        )

      const finish = (failure: Failure) =>
        Effect.gen(function* () {
          if (finished) return
          finished = true

          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
            ws.close(1000)

          yield* Queue.fail(messages, isClientClosed(failure) ? DONE : failure)
          yield* Deferred.fail(opened, failure)
        })

      const acknowledge = Effect.suspend(() =>
        resync?.settled === true ? write({ t: "resyncDone" }) : Effect.void,
      )

      const frame = (message: Extract<ServerWireMessage, { readonly t: "frame" }>) =>
        decodeFrame(message.frame).pipe(
          Effect.flatMap((decoded) =>
            Effect.suspend(() => {
              if (message.event !== undefined) {
                const event = eventPosition(message.event)

                if (event === undefined) return finish(undecodableFailure())

                if (event <= highest) return Effect.void

                highest = event
              }

              return Queue.offer(
                messages,
                ConnectionMessage.Frame<Server>({
                  frame: decoded as Server,
                  cursor: message.cursor,
                  event: message.event,
                }),
              )
            }),
          ),
          Effect.catch(() => finish(undecodableFailure())),
          Effect.asVoid,
        )

      const progress = (message: Extract<ServerWireMessage, { readonly t: "progress" }>) =>
        Option.match(Option.fromNullishOr(progressDecoders.get(message.effect)), {
          onNone: () => Effect.void,
          onSome: (decode) =>
            decode(message.frame).pipe(
              Effect.flatMap((frame) =>
                Queue.offer(
                  messages,
                  ConnectionMessage.Progress<Server>({
                    effect: message.effect,
                    effectId: message.effectId,
                    attempt: message.attempt,
                    seq: message.seq,
                    frame,
                  }),
                ),
              ),
              Effect.catch(() => Effect.void),
              Effect.asVoid,
            ),
        })

      const resyncing = (message: Extract<ServerWireMessage, { readonly t: "resync" }>) => {
        const state = { settled: false }
        resync = state

        const settle = Effect.promise(() =>
          Promise.resolve()
            .then(() => options.onResync?.({ after: message.after }))
            .catch(() => undefined),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.settled = true
            }),
          ),
          Effect.andThen(acknowledge),
        )

        return Queue.offer(
          messages,
          ConnectionMessage.Resync<Server>({
            after: message.after,
            reason: message.reason,
            deadline: message.deadline,
          }),
        ).pipe(Effect.andThen(Effect.sync(() => run(settle))), Effect.asVoid)
      }

      const handle = Match.type<ServerWireMessage>().pipe(
        Match.discriminatorsExhaustive("t")({
          open: (message) =>
            Deferred.succeed(opened, {
              connectionId: message.connectionId,
              baseline: message.baseline,
            }).pipe(Effect.asVoid),
          frame,
          resync: resyncing,
          resyncReplayed: () =>
            Queue.offer(messages, ConnectionMessage.ResyncReplayed<Server>()).pipe(
              Effect.andThen(acknowledge),
            ),
          progress,
          reauthenticate: () =>
            authorization.pipe(
              Effect.flatMap((fresh) =>
                fresh === undefined
                  ? Effect.void
                  : write({ t: "reauthenticate", authorization: fresh }),
              ),
              Effect.ignoreCause,
            ),
          reauthenticated: () => Effect.void,
          end: (message) => failureOf(message.error).pipe(Effect.flatMap(finish)),
        }),
      )

      ws.onopen = () =>
        run(
          write(
            credential === undefined
              ? { t: "hello", params: hello }
              : { t: "hello", authorization: credential, params: hello },
          ),
        )

      ws.onmessage = (event) => Queue.offerUnsafe(inbox, String(event.data))

      ws.onclose = () => Queue.offerUnsafe(inbox, DONE)

      run(
        Queue.take(inbox).pipe(
          Effect.flatMap((text) =>
            text === DONE
              ? finish(holderLost)
              : Option.match(decodeTagged(text), {
                  onNone: () => finish(undecodableFailure()),
                  onSome: ({ t }) =>
                    KNOWN.has(t)
                      ? Option.match(decodeServer(text), {
                          onNone: () => finish(undecodableFailure()),
                          onSome: handle,
                        })
                      : Effect.void,
                }),
          ),
          Effect.forever,
        ),
      )

      const aborted = Effect.callback<never, Failure>((resume) => {
        const signal = options.signal

        if (signal === undefined) return

        const onAbort = () => {
          ws.close(1000)
          resume(Effect.fail(ended("ClientClosed", false)))
        }

        if (signal.aborted) return onAbort()

        signal.addEventListener("abort", onAbort, { once: true })

        return Effect.sync(() => signal.removeEventListener("abort", onAbort))
      })

      const open = yield* Effect.raceFirst(Deferred.await(opened), aborted)

      const stream = Stream.fromQueue(messages).pipe(
        Stream.catch((failure) => (failure === DONE ? Stream.empty : Stream.fail(failure))),
      )

      const connection: ClientConnection<Server, Client> = {
        connectionId: open.connectionId,
        cursor: open.baseline,
        messages: Stream.toAsyncIterable(stream),
        frames: Stream.toAsyncIterable(
          stream.pipe(
            Stream.filter((message): message is FrameMessage<Server> =>
              Predicate.isTagged(message, "Frame"),
            ),
            Stream.map((message) => message.frame),
          ),
        ),
        send: (value) =>
          Effect.runPromiseWith(services)(
            encodeFrame(value).pipe(
              Effect.mapError(undecodableFailure),
              Effect.flatMap((json) =>
                finished || ws.readyState !== WebSocket.OPEN
                  ? Effect.fail(holderLost)
                  : write({ t: "frame", frame: json }),
              ),
            ),
          ),
        close: () =>
          Effect.runPromiseWith(services)(
            Effect.sync(() => ws.close(1000)).pipe(
              Effect.andThen(finish(ended("ClientClosed", false))),
            ),
          ),
      }

      return connection
    }),
  )
