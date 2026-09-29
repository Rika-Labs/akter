import {
  Cause,
  Clock,
  Crypto,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Queue,
  Random,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, ActorUnavailable, SessionEnded, Unauthorized } from "../../errors/actor.ts"
import type { ActorRef, Caller } from "../../identity/caller.ts"
import type { Placement } from "../storage/codec.ts"
import { type ConnectionCommands, connectionSecret } from "../../identity/command.ts"
import { FrameworkClock } from "../turn/admission.ts"
import { BUCKETS } from "../turn/outbox.ts"
import {
  ClientMessage,
  type Deliver,
  type Delivered,
  HolderItem,
  isWatchMember,
  watchedQuery,
} from "./protocol.ts"
import type { Transport } from "./transport.ts"

/** The largest encoded inbound frame or open params a holder accepts. */
export const MAX_INBOUND_BYTES = 65_536

/** Open connections one holder keeps at once. */
export const MAX_HELD_CONNECTIONS = 50_000

/** Bytes buffered across one holder's connections, both directions. */
export const MAX_HELD_BYTES = 268_435_456

/** Outbound frames one connection may have waiting for its client. */
export const MAX_OUTBOUND_FRAMES = 1_024

/** Outbound bytes one connection may have waiting for its client. */
export const MAX_OUTBOUND_BYTES = 1_048_576

/** How long a client has to answer `Resync` with `ResyncDone`. */
export const RESYNC_DEADLINE_MS = 30_000

/** A third owner loss within this window ends the connection instead of resyncing again. */
export const RESYNC_WINDOW_MS = 300_000

/** Inbound frames a connection may have in flight before its transport stops reading. */
export const MAX_INFLIGHT_FRAMES = 32

const TICK = "100 millis"

const OWNER_CHECK_MS = 1_000

const LIVENESS_MS = 10_000

const MAX_INBOUND_FRAMES = 1_024

const COMMAND_SKEW_MS = 1_000

const utf8 = new TextEncoder()

/** One socket as its transport sees it. */
export interface HeldConnection {
  readonly connectionId: string
  /** The flushed-through cursor when the connection opened: replay events after it. */
  readonly cursor: string
  readonly messages: Stream.Stream<ClientMessage, ActorError>
  readonly send: (frame: string) => Effect.Effect<void, ActorError>
  /** Tells the holder the client finished its replay after `Resync`. */
  readonly resyncDone: Effect.Effect<void>
  /** Whether the session is open and inside its authorization bound now, so a result read for it may still be released. */
  readonly authorized: Effect.Effect<boolean>
  /** Waits until fewer than `MAX_INFLIGHT_FRAMES` inbound frames are in flight, or the session ended. */
  readonly writable: Effect.Effect<void>
  /**
   * Renews the session's authorization for the same caller, as a fresh
   * credential does: `authorize` runs again, and the credential's own expiry,
   * if any, becomes the session's new cap.
   */
  readonly reauthenticate: (expiresAt: number | undefined) => Effect.Effect<void, ActorError>
  readonly close: Effect.Effect<void>
}

/** The declared failure an `open` handler returned, still encoded. */
export class OpenRejected extends Schema.TaggedError<OpenRejected>()("OpenRejected", {
  value: Schema.String,
}) {}

type Owner = { readonly generation: string; readonly owner: string; readonly ownerEpoch: string }

type Address = {
  readonly ref: ActorRef
  readonly connectionId: string
  readonly holder: string
  readonly holderEpoch: string
}

/** The owner-side connection RPCs a holder calls for one actor. */
export interface OwnerChannel {
  readonly open: (
    request: Address & {
      readonly member: string
      readonly caller: Caller
      readonly params: string
      readonly commands: ConnectionCommands
    },
  ) => Effect.Effect<
    | ({ readonly _tag: "Opened"; readonly baseline: string; readonly recovered?: boolean } & Owner)
    | { readonly _tag: "Failed"; readonly value: string },
    ActorError
  >
  readonly frame: (
    request: Address & {
      readonly seq: number
      readonly frame: string
      readonly authorizedUntil: number
      readonly commands: ConnectionCommands
    },
  ) => Effect.Effect<
    | ({ readonly _tag: "Acked" } & Owner)
    | { readonly _tag: "Closed"; readonly ended: SessionEnded },
    ActorError
  >
  readonly close: (
    request: Address & { readonly cause: SessionEnded },
  ) => Effect.Effect<void, ActorError>
  readonly resync: (
    request: Address & { readonly after?: string | undefined; readonly authorizedUntil: number },
  ) => Effect.Effect<
    | ({ readonly _tag: "Replayed" } & Owner)
    | { readonly _tag: "Closed"; readonly ended: SessionEnded },
    ActorError
  >
}

/** What a holder needs to know about an actor type it holds connections to. */
export interface HeldActorType {
  readonly deliveryMs: number
  /** How long a new owner may take to answer a resync: the dead owner's lock plus a wake. */
  readonly takeoverMs: number
  readonly reauthorizeMs: number
  readonly retryWindowMs: number
  readonly placement: Placement
  readonly hasResync: (member: string) => boolean
  readonly hasMember: (member: string) => boolean
  readonly channel: OwnerChannel
  readonly routingKey: (ref: ActorRef) => bigint
}

/** What a holder needs from its runner: the transport to owners, the actor types it serves, and the authorization hook. */
export interface HolderOptions {
  readonly transport: () => Transport
  readonly actorType: (name: string) => HeldActorType | undefined
  readonly authorize: (request: {
    readonly caller: Caller
    readonly ref: ActorRef
    readonly command: string
    readonly kind: "open" | "feed" | "watch" | "reauthorize"
    readonly of?: "open" | "feed" | "watch"
  }) => Effect.Effect<boolean>
}

interface Held {
  readonly id: string
  readonly ref: ActorRef
  readonly key: string
  readonly member: string
  /** A feed's event tags, each authorized on its own; `undefined` for a connection member. */
  readonly feed: ReadonlyArray<string> | undefined
  readonly caller: Caller
  readonly type: HeldActorType
  readonly outbound: Queue.Queue<ClientMessage, ActorError | Cause.Done>
  readonly secret: string
  readonly inbound: Array<{ readonly frame: string; readonly issuedAt: number }>
  readonly wake: Queue.Queue<void>
  /** Signalled whenever an inbound frame leaves the queue or the session ends. */
  readonly drained: Queue.Queue<void>
  /** The credential's own expiry, which caps authorization regardless of `reauthorizeEvery`. */
  expiresAt: number | undefined
  open: boolean
  ended: boolean
  outFrames: number
  outBytes: number
  inBytes: number
  nextSeq: number
  lastAuthorized: number
  /** When the owner acknowledged the open, which proved the connection's row. */
  openedAt: number
  checking: boolean
  resync:
    | {
        readonly after: string | undefined
        replayed: boolean
        sent: boolean
        answered: boolean
        deadline: number
        deferredBytes: number
        readonly deferred: Array<ClientMessage>
        readonly replayedEvents: Set<string>
      }
    | undefined
  resyncs: Array<number>
  loop: Fiber.Fiber<void> | undefined
  /**
   * The undelivered progress frame of each effect, newest only. Its place in
   * `outbound` is a marker that takes whatever frame is here when the client
   * reaches it, so newer frames replace older ones in place.
   */
  readonly progress: Map<string, { message: ProgressMessage; bytes: number }>
}

type ProgressMessage = Extract<ClientMessage, { readonly _tag: "Progress" }>

interface HeldActor {
  generation: bigint
  seq: number
  sealed: boolean
  through: string
  owner: string
  ownerEpoch: string
  lastCheck: number
  /**
   * No owner message applied yet. A holder forgets an actor once it holds no
   * connection to it, while the owner's channel keeps counting, so the first
   * message after that sets the position instead of reading as a gap.
   */
  fresh: boolean
  readonly connections: Map<string, Held>
}

const actorKey = (ref: ActorRef) => `${ref.tenant}\u0000${ref.actor}\u0000${ref.id}`

const ended = (cause: SessionEnded["cause"], resync: boolean, retryAfterMs?: number) =>
  ActorError.make({
    reason: SessionEnded.make({
      cause,
      resync,
      retryAfterMs,
    }),
  })

/**
 * The socket side of connections on one runner: it holds each connection's
 * buffers, caller, and authorization clock, orders inbound frames, applies the
 * owner's ordered messages, and resyncs its connections in place when their
 * owner dies. Actor activations never hold a socket.
 *
 * Authorization: nothing reaches a client or an owner past the connection's
 * authorization bound. A session past its credential's expiry reports that;
 * otherwise its last check is too old. A credential's expiry caps the session and
 * its buffered frames go with it. An answer that arrives past the bound never
 * extends it, and a credential that expired while `authorize` ran opens nothing.
 * A holder that cannot confirm its rows for a whole bound stops serving them; a
 * connection opened since the checks began failing counts from its open. A
 * revoked client receives nothing more, including frames already queued.
 *
 * Buffering: a member frame evicts buffered progress oldest first before the
 * connection counts as a slow consumer. A newer progress frame that would not fit
 * is dropped and the waiting one stays. A progress marker delivers the newest
 * frame of its effect, or nothing if it was discarded.
 *
 * Owner ordering: an owner acknowledges each message before sending the next, so
 * the first message a record sees follows everything its connections could have
 * missed. Redelivered messages were already applied, and late messages from a
 * dead or superseded generation are dropped. A gap makes every connection replay
 * from its cursor. A newer generation over an unsealed older one means the older
 * owner died, and every connection resyncs in place; a loss during a resync
 * restarts it from the same cursor and keeps the frames it deferred. An older
 * owner's progress never reaches a client after a newer owner's messages, and a
 * ping answered after a newer owner was observed says nothing about that owner.
 * Live frames wait until a resync's replay is acknowledged, and inbound frames are
 * delivered one at a time after any pending resync. Acknowledgments before the new
 * owner answered, or before the member's replay finished, are ignored. Until the
 * new owner answers, the resync deadline bounds the takeover; then the client's
 * acknowledgment does.
 *
 * Opening and closing: a connection registers before the owner commits so frames
 * flushed after that commit find it. The owner may still commit an open the holder
 * gave up on; such a late row is closed again. A lost owner's opening frames and
 * unflushed broadcasts may be gone. An open handler that closed the connection
 * leaves it ended with `ServerClosed`. On close the owner deletes the row, and the
 * holder deletes its own if the owner cannot. Rows an unreachable owner dropped
 * end their connections so clients reconnect. A graceful shutdown ends every
 * connection with a resync hint and deletes its rows. A feed connection is
 * authorized as each event tag it reads, all of which must pass.
 */
export const connectionHolder = Effect.fnUntraced(function* (options: HolderOptions) {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const clock = yield* FrameworkClock
  const scope = yield* Effect.scope
  const actors = new Map<string, HeldActor>()
  const held = new Map<string, Held>()
  let heldBytes = 0
  let lastLiveness = 0
  let livenessFailedSince: number | undefined = undefined
  let checkingLiveness = false

  const now = Effect.map(Clock.currentTimeMillis, (millis) => millis + clock.offsetMillis())

  const address = (connection: Held): Address => {
    const transport = options.transport()

    return {
      ref: connection.ref,
      connectionId: connection.id,
      holder: transport.holder,
      holderEpoch: transport.epoch,
    }
  }

  const actorOf = (ref: ActorRef) => {
    const key = actorKey(ref)
    const found = actors.get(key)

    if (found !== undefined) return found

    const created: HeldActor = {
      generation: 0n,
      seq: 0,
      sealed: true,
      through: "0",
      owner: "",
      ownerEpoch: "",
      lastCheck: 0,
      fresh: true,
      connections: new Map(),
    }

    actors.set(key, created)

    return created
  }

  const deleteRow = (connection: Held) =>
    sql`DELETE FROM actor_connections WHERE routing_key = ${connection.type.routingKey(connection.ref)}
      AND tenant_id = ${connection.ref.tenant} AND actor_type = ${connection.ref.actor}
      AND actor_id = ${connection.ref.id} AND connection_id = ${connection.id}
      AND holder_epoch = ${options.transport().epoch}`.pipe(Effect.ignore)

  const release = (connection: Held) => {
    heldBytes -= connection.outBytes + connection.inBytes + (connection.resync?.deferredBytes ?? 0)

    if (connection.resync !== undefined) connection.resync.deferredBytes = 0
    connection.outBytes = 0
    connection.inBytes = 0
    connection.inbound.length = 0
    connection.progress.clear()
    held.delete(connection.id)
    const actor = actors.get(connection.key)
    actor?.connections.delete(connection.id)

    if (actor !== undefined && actor.connections.size === 0) actors.delete(connection.key)
  }

  const end = (connection: Held, error: ActorError, deleteOwnRow: boolean) =>
    Effect.gen(function* () {
      if (connection.ended) return
      connection.ended = true
      connection.open = false
      release(connection)

      if (Predicate.isTagged(error.reason, "Unauthorized"))
        yield* Effect.ignore(Queue.clear(connection.outbound))
      yield* Queue.fail(connection.outbound, error)
      yield* Queue.offer(connection.wake, undefined)
      yield* Queue.offer(connection.drained, undefined)

      if (deleteOwnRow) yield* deleteRow(connection)
    })

  const discardProgress = (connection: Held, effectId: string) => {
    const pending = connection.progress.get(effectId)

    if (pending === undefined) return
    connection.progress.delete(effectId)
    connection.outFrames -= 1
    connection.outBytes -= pending.bytes
    heldBytes -= pending.bytes
  }

  const fits = (connection: Held, bytes: number) =>
    connection.outFrames + 1 <= MAX_OUTBOUND_FRAMES &&
    connection.outBytes + bytes <= MAX_OUTBOUND_BYTES &&
    heldBytes + bytes <= MAX_HELD_BYTES

  /**
   * Buffers a progress frame. A newer frame of the same effect replaces the
   * waiting one in place; one that does not fit is dropped. Progress never
   * ends a session.
   */
  const pushProgress = (connection: Held, message: ProgressMessage) =>
    Effect.gen(function* () {
      if (connection.ended || connection.resync !== undefined) return
      const bytes = utf8.encode(message.frame).byteLength
      const waiting = connection.progress.get(message.effectId)

      if (waiting !== undefined) {
        if (
          connection.outBytes - waiting.bytes + bytes > MAX_OUTBOUND_BYTES ||
          heldBytes - waiting.bytes + bytes > MAX_HELD_BYTES
        )
          return
        connection.outBytes += bytes - waiting.bytes
        heldBytes += bytes - waiting.bytes
        waiting.message = message
        waiting.bytes = bytes

        return
      }

      if (!fits(connection, bytes)) return
      connection.progress.set(message.effectId, { message, bytes })
      connection.outFrames += 1
      connection.outBytes += bytes
      heldBytes += bytes
      yield* Queue.offer(connection.outbound, message)
    })

  const push = (connection: Held, message: ClientMessage, control: boolean) =>
    Effect.gen(function* () {
      if (connection.ended) return
      const bytes = ClientMessage.guards.Frame(message) ? utf8.encode(message.frame).byteLength : 0

      if (!control)
        for (const effectId of connection.progress.keys()) {
          if (fits(connection, bytes)) break
          discardProgress(connection, effectId)
        }

      if (
        !control &&
        (connection.outFrames + 1 > MAX_OUTBOUND_FRAMES ||
          connection.outBytes + bytes > MAX_OUTBOUND_BYTES ||
          heldBytes + bytes > MAX_HELD_BYTES)
      )
        return yield* end(connection, ended("SlowConsumer", true), true)

      connection.outFrames += 1
      connection.outBytes += bytes
      heldBytes += bytes
      yield* Queue.offer(connection.outbound, message)
    })

  const takenProgress = (connection: Held, marker: ProgressMessage) =>
    Effect.sync((): Option.Option<ClientMessage> => {
      const pending = connection.progress.get(marker.effectId)

      if (connection.ended || pending === undefined) return Option.none()
      discardProgress(connection, marker.effectId)

      return Option.some(pending.message)
    })

  const taken = (connection: Held, message: ClientMessage) =>
    Effect.sync(() => {
      if (connection.ended) return
      const bytes = ClientMessage.guards.Frame(message) ? utf8.encode(message.frame).byteLength : 0
      connection.outFrames -= 1
      connection.outBytes -= bytes
      heldBytes -= bytes
    })

  const ownerLost = (actor: HeldActor) =>
    Effect.gen(function* () {
      if (actor.sealed) return
      actor.sealed = true
      const at = yield* now

      for (const connection of actor.connections.values()) {
        if (connection.open) yield* resync(actor, connection, at)
      }
    })

  const resync = (actor: HeldActor, connection: Held, at: number, from?: string) =>
    Effect.gen(function* () {
      connection.resyncs = connection.resyncs.filter((time) => at - time < RESYNC_WINDOW_MS)
      connection.resyncs.push(at)

      if (connection.resyncs.length >= 3) {
        const retryAfterMs = yield* Random.nextIntBetween(1_000, 5_000)
        yield* end(connection, ended("OwnerLost", true, retryAfterMs), true)

        return
      }

      const previous = connection.resync

      const after =
        previous !== undefined
          ? previous.after
          : (from ?? actor.through) === "0"
            ? undefined
            : (from ?? actor.through)

      connection.resync = {
        after,
        replayed: false,
        sent: false,
        answered: false,
        deadline: at + connection.type.takeoverMs,
        deferred: previous?.deferred ?? [],
        deferredBytes: previous?.deferredBytes ?? 0,
        replayedEvents: previous?.replayedEvents ?? new Set(),
      }
      yield* push(
        connection,
        ClientMessage.cases.Resync.make({
          after,
          reason: "OwnerLost",
          deadlineMs: RESYNC_DEADLINE_MS,
        }),
        true,
      )
      yield* Queue.offer(connection.wake, undefined)
    })

  const observe = (actor: HeldActor, owner: Owner) =>
    Effect.gen(function* () {
      const generation = BigInt(owner.generation)

      if (generation < actor.generation) return false

      if (generation > actor.generation) {
        for (const connection of actor.connections.values())
          for (const effectId of connection.progress.keys()) discardProgress(connection, effectId)

        if (actor.generation > 0n) yield* ownerLost(actor)
        actor.generation = generation
        actor.seq = 0
        actor.sealed = false
      }

      actor.owner = owner.owner
      actor.ownerEpoch = owner.ownerEpoch

      return true
    })

  const deliver = (message: Deliver): Effect.Effect<Delivered> =>
    Effect.gen(function* () {
      const actor = actors.get(actorKey(message.ref))
      const unknown: Array<string> = []

      if (actor === undefined) {
        for (const item of message.items)
          if (HolderItem.guards.Frame(item)) unknown.push(...item.to)

        return { wrongEpoch: false, unknown }
      }

      if (!(yield* observe(actor, message))) return { wrongEpoch: false, unknown }

      if (actor.fresh) {
        actor.fresh = false
        actor.seq = message.seq - 1
      }

      if (message.seq <= actor.seq) return { wrongEpoch: false, unknown }

      if (message.seq !== actor.seq + 1) {
        for (const connection of actor.connections.values())
          yield* end(connection, ended("SlowConsumer", true), true)
        actor.seq = message.seq

        return { wrongEpoch: false, unknown }
      }

      actor.seq = message.seq
      const at = yield* now

      for (const item of message.items)
        yield* HolderItem.match(item, {
          Frame: (frame) =>
            Effect.forEach(
              frame.to,
              (id) => {
                const connection = actor.connections.get(id)

                if (connection === undefined || connection.member !== frame.member) {
                  unknown.push(id)

                  return Effect.void
                }

                if (at >= authorizedUntil(connection))
                  return end(connection, lapsed(connection, at), true)

                const out = ClientMessage.cases.Frame.make({
                  frame: frame.frame,
                  cursor: frame.stamp ? message.through : undefined,
                  event: frame.stamp ? frame.event : undefined,
                })

                const pending = connection.resync

                if (pending !== undefined && frame.replay !== true) {
                  const bytes = utf8.encode(out.frame).byteLength

                  if (
                    pending.deferred.length + connection.outFrames >= MAX_OUTBOUND_FRAMES ||
                    pending.deferredBytes + connection.outBytes + bytes > MAX_OUTBOUND_BYTES ||
                    heldBytes + bytes > MAX_HELD_BYTES
                  )
                    return end(connection, ended("SlowConsumer", true), true)
                  pending.deferred.push(out)
                  pending.deferredBytes += bytes
                  heldBytes += bytes

                  return Effect.void
                }

                if (pending !== undefined && frame.event !== undefined)
                  pending.replayedEvents.add(frame.event)

                return push(connection, out, false)
              },
              { discard: true },
            ),
          Flushed: (flushed) =>
            Effect.sync(() => {
              actor.through = flushed.through
            }),
          End: (item) => {
            const connection = actor.connections.get(item.connectionId)

            return connection === undefined
              ? Effect.void
              : end(connection, ActorError.make({ reason: item.ended }), false)
          },
          Seal: () =>
            Effect.sync(() => {
              actor.sealed = true
            }),
          Progress: (item) =>
            Effect.forEach(
              item.to,
              (id) => {
                const connection = actor.connections.get(id)

                if (connection === undefined || connection.member !== item.member) {
                  unknown.push(id)

                  return Effect.void
                }

                if (at >= authorizedUntil(connection))
                  return end(connection, lapsed(connection, at), true)

                return pushProgress(
                  connection,
                  ClientMessage.cases.Progress.make({
                    effect: item.effect,
                    effectId: item.effectId,
                    attempt: item.attempt,
                    seq: item.seq,
                    frame: item.frame,
                  }),
                )
              },
              { discard: true },
            ),
          ProgressEnd: (item) =>
            Effect.sync(() => {
              for (const connection of actor.connections.values())
                discardProgress(connection, item.effectId)
            }),
        })

      return { wrongEpoch: false, unknown }
    })

  const retried = <A>(
    connection: Held,
    effect: Effect.Effect<A, ActorError>,
    refused: (error: ActorError) => boolean = () => false,
  ) =>
    effect.pipe(
      Effect.retry({
        while: (error) => error.isRetryable && !connection.ended && !refused(error),
        schedule: Schedule.min([
          Schedule.exponential("10 millis", 2),
          Schedule.spaced("250 millis"),
        ]),
      }),
    )

  const retrying = <A>(
    connection: Held,
    effect: Effect.Effect<A, ActorError>,
    deadlineMs: number,
  ) =>
    retried(connection, effect).pipe(
      Effect.timeoutOrElse({
        duration: deadlineMs,
        orElse: () => Effect.fail(ended("ActorUnavailable", true)),
      }),
    )

  const authorizedUntil = (connection: Held) =>
    Math.min(
      connection.lastAuthorized + connection.type.reauthorizeMs,
      connection.expiresAt ?? Number.POSITIVE_INFINITY,
    )

  const unauthorized = ActorError.make({
    reason: Unauthorized.make({ code: "reauthorization_unavailable" }),
  })

  const credentialExpired = ActorError.make({ reason: Unauthorized.make({ code: "expired" }) })

  const lapsed = (connection: Held, at: number) =>
    connection.expiresAt !== undefined && at >= connection.expiresAt
      ? credentialExpired
      : unauthorized

  const expired = (connection: Held) =>
    Effect.gen(function* () {
      const at = yield* now

      if (at < authorizedUntil(connection)) return false
      yield* end(connection, lapsed(connection, at), true)

      return true
    })

  const commandsOf = (connection: Held, seq: number, issuedAt: number): ConnectionCommands => ({
    secret: connection.secret,
    seq,
    issuedAt,
    expiresAt: issuedAt + connection.type.retryWindowMs,
  })

  const inboundLoop = (connection: Held) =>
    Effect.gen(function* () {
      while (!connection.ended) {
        const pending = connection.resync

        if (pending !== undefined && !pending.sent) {
          if (yield* expired(connection)) return
          pending.sent = true

          const answer = yield* retrying(
            connection,
            connection.type.channel.resync({
              ...address(connection),
              after: pending.after,
              authorizedUntil: authorizedUntil(connection),
            }),
            Math.max(0, Math.min(authorizedUntil(connection), pending.deadline) - (yield* now)),
          ).pipe(Effect.exit)

          if (connection.ended) return

          if (yield* expired(connection)) return

          if (Exit.isFailure(answer)) {
            yield* end(connection, ended("OwnerLost", true), true)

            return
          }

          if (Predicate.isTagged(answer.value, "Closed")) {
            yield* end(connection, ActorError.make({ reason: answer.value.ended }), true)

            return
          }

          yield* observe(actorOf(connection.ref), answer.value)
          pending.answered = true
          pending.deadline = (yield* now) + RESYNC_DEADLINE_MS

          if (connection.type.hasResync(connection.member)) {
            pending.replayed = true
            yield* push(connection, ClientMessage.cases.ResyncReplayed.make({}), true)
          }

          continue
        }

        if (pending !== undefined || connection.inbound.length === 0) {
          yield* Queue.take(connection.wake)
          continue
        }

        if (yield* expired(connection)) return
        const { frame, issuedAt } = connection.inbound.shift()!
        const bytes = utf8.encode(frame).byteLength
        connection.inBytes -= bytes
        heldBytes -= bytes
        yield* Queue.offer(connection.drained, undefined)
        connection.nextSeq += 1
        const seq = connection.nextSeq

        const answer = yield* retrying(
          connection,
          connection.type.channel.frame({
            ...address(connection),
            seq,
            frame,
            authorizedUntil: authorizedUntil(connection),
            commands: commandsOf(connection, seq, issuedAt),
          }),
          Math.min(connection.type.deliveryMs, authorizedUntil(connection) - (yield* now)),
        ).pipe(Effect.exit)

        if (connection.ended) return

        if (yield* expired(connection)) return

        if (Exit.isFailure(answer)) {
          const failure = Cause.findErrorOption(answer.cause)
          yield* end(
            connection,
            Option.isSome(failure) ? failure.value : ended("ActorUnavailable", true),
            true,
          )

          return
        }

        if (Predicate.isTagged(answer.value, "Closed")) {
          yield* end(connection, ActorError.make({ reason: answer.value.ended }), false)

          return
        }

        yield* observe(actorOf(connection.ref), answer.value)
      }
    })

  const check = (
    session: { readonly caller: Caller; readonly ref: ActorRef; readonly member: string },
    feed: ReadonlyArray<string> | undefined,
    kind: "first" | "reauthorize",
  ) =>
    isWatchMember(session.member)
      ? options.authorize({
          caller: session.caller,
          ref: session.ref,
          command: watchedQuery(session.member),
          kind: kind === "first" ? "watch" : "reauthorize",
          of: kind === "first" ? undefined : "watch",
        })
      : feed === undefined
        ? options.authorize({
            caller: session.caller,
            ref: session.ref,
            command: session.member,
            kind: kind === "first" ? "open" : "reauthorize",
            of: kind === "first" ? undefined : "open",
          })
        : Effect.forEach(feed, (tag) =>
            options.authorize({
              caller: session.caller,
              ref: session.ref,
              command: tag,
              kind: kind === "first" ? "feed" : "reauthorize",
              of: kind === "first" ? undefined : "feed",
            }),
          ).pipe(Effect.map((answers) => answers.every(Boolean)))

  const reauthorize = (connection: Held, at: number) =>
    Effect.gen(function* () {
      connection.checking = true

      const allowed = yield* check(connection, connection.feed, "reauthorize").pipe(Effect.exit)

      connection.checking = false

      if (connection.ended) return

      const answered = yield* now

      if (Exit.isSuccess(allowed) && allowed.value && answered >= authorizedUntil(connection))
        yield* end(connection, lapsed(connection, answered), true)
      else if (Exit.isSuccess(allowed) && allowed.value) connection.lastAuthorized = at
      else if (Exit.isSuccess(allowed))
        yield* end(
          connection,
          ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
          true,
        )
    })

  const liveness = (at: number) =>
    Effect.gen(function* () {
      const transport = options.transport()
      const checked = [...held.values()].filter((connection) => connection.open)

      const rows = yield* sql<{ connection_id: string }>`
        SELECT c.connection_id
        FROM generate_series(${BUCKETS.first}::int, ${BUCKETS.last}::int) AS b(bucket)
        CROSS JOIN LATERAL (
          SELECT connection_id FROM actor_connections
          WHERE actor_connections.bucket = b.bucket AND holder = ${transport.holder}
            AND holder_epoch = ${transport.epoch}
        ) c`

      lastLiveness = at
      livenessFailedSince = undefined
      const present = new Set(rows.map((row) => row.connection_id))

      for (const connection of checked)
        if (!present.has(connection.id)) yield* end(connection, ended("ServerClosed", true), false)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.andThen(
          Effect.sync(() => (livenessFailedSince ??= at)),
          Effect.logWarning("Holder liveness check failed", cause),
        ),
      ),
    )

  const tick = Effect.gen(function* () {
    const at = yield* now

    for (const connection of held.values()) {
      if (!connection.open) continue
      const every = connection.type.reauthorizeMs

      if (
        livenessFailedSince !== undefined &&
        at - Math.max(livenessFailedSince, connection.openedAt) >= every
      ) {
        yield* end(connection, ended("ActorUnavailable", true), false)

        continue
      }

      if (connection.expiresAt !== undefined && at >= connection.expiresAt) {
        yield* end(connection, credentialExpired, true)

        continue
      }

      if (at >= connection.lastAuthorized + every) {
        yield* end(connection, unauthorized, true)

        continue
      }

      if (
        !connection.checking &&
        at >= connection.lastAuthorized + every - Math.min(10_000, every / 2)
      )
        yield* reauthorize(connection, at).pipe(Effect.forkIn(scope))

      if (connection.resync !== undefined && at >= connection.resync.deadline)
        yield* end(connection, ended("OwnerLost", true), true)
    }

    const transport = options.transport()

    const every = Math.min(
      LIVENESS_MS,
      ...[...held.values()].map((connection) => connection.type.reauthorizeMs),
    )

    if (!checkingLiveness && held.size > 0 && at - lastLiveness >= every) {
      checkingLiveness = true
      yield* liveness(at).pipe(
        Effect.ensuring(Effect.sync(() => (checkingLiveness = false))),
        Effect.forkIn(scope),
      )
    }

    for (const actor of actors.values()) {
      if (actor.sealed || actor.owner === "" || at - actor.lastCheck < OWNER_CHECK_MS) continue
      actor.lastCheck = at

      if (actor.owner === transport.holder && actor.ownerEpoch === transport.epoch) continue

      const { owner, ownerEpoch, generation } = actor

      yield* transport.ping(owner, ownerEpoch).pipe(
        Effect.flatMap((alive) =>
          alive ||
          actor.generation !== generation ||
          actor.owner !== owner ||
          actor.ownerEpoch !== ownerEpoch
            ? Effect.void
            : ownerLost(actor),
        ),
        Effect.forkIn(scope),
      )
    }
  })

  yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkIn(scope))

  const open = Effect.fnUntraced(function* (request: {
    readonly ref: ActorRef
    readonly member: string
    readonly caller: Caller
    readonly params: string
    /** The credential's own expiry, if it has one; the session never outlives it. */
    readonly expiresAt?: number | undefined
    /** The event tags of a feed, which opens the framework feed member. */
    readonly feed?: ReadonlyArray<string> | undefined
  }) {
    const type = options.actorType(request.ref.actor)

    if (type === undefined)
      return yield* ActorError.make({
        reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
      })

    if (!type.hasMember(request.member))
      return yield* ActorError.make({
        reason: ActorUnavailable.make({ cause: new Error("Connection not declared") }),
      })

    if (utf8.encode(request.params).byteLength > MAX_INBOUND_BYTES)
      return yield* Effect.die(new Error("Connection params exceed 64 KiB"))

    if (held.size >= MAX_HELD_CONNECTIONS)
      return yield* ActorError.make({
        reason: ActorUnavailable.make({ cause: new Error("Holder is at its connection limit") }),
      })

    if (request.expiresAt !== undefined && (yield* now) >= request.expiresAt)
      return yield* credentialExpired

    const allowed = yield* check(request, request.feed, "first")

    if (!allowed)
      return yield* ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })

    if (request.expiresAt !== undefined && (yield* now) >= request.expiresAt)
      return yield* credentialExpired

    const connection: Held = {
      id: yield* crypto.randomUUIDv7.pipe(Effect.orDie),
      ref: request.ref,
      key: actorKey(request.ref),
      member: request.member,
      feed: request.feed,
      caller: request.caller,
      type,
      outbound: yield* Queue.unbounded<ClientMessage, ActorError | Cause.Done>(),
      secret: connectionSecret(yield* crypto.randomBytes(32).pipe(Effect.orDie)),
      inbound: [],
      wake: yield* Queue.sliding<void>(1),
      drained: yield* Queue.sliding<void>(1),
      expiresAt: request.expiresAt,
      open: false,
      ended: false,
      outFrames: 0,
      outBytes: 0,
      inBytes: 0,
      nextSeq: 0,
      lastAuthorized: yield* now,
      openedAt: 0,
      checking: false,
      resync: undefined,
      resyncs: [],
      loop: undefined,
      progress: new Map(),
    }

    const actor = actorOf(request.ref)
    actor.connections.set(connection.id, connection)
    held.set(connection.id, connection)

    const issuedAt = (yield* now) - COMMAND_SKEW_MS

    const openCall = type.channel.open({
      ...address(connection),
      member: request.member,
      caller: request.caller,
      params: request.params,
      commands: {
        secret: connection.secret,
        seq: 0,
        issuedAt,
        expiresAt: issuedAt + type.retryWindowMs,
      },
    })

    const attempt = yield* retried(
      connection,
      openCall,
      (error) =>
        isWatchMember(request.member) && Predicate.isTagged(error.reason, "RunnerAtCapacity"),
    ).pipe(Effect.forkIn(scope))

    const abandon = Effect.gen(function* () {
      connection.ended = true
      release(connection)
      yield* deleteRow(connection)

      yield* Fiber.await(attempt).pipe(
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit) && Predicate.isTagged(exit.value, "Opened")
            ? retrying(
                connection,
                type.channel.close({
                  ...address(connection),
                  cause: SessionEnded.make({ cause: "ActorUnavailable", resync: true }),
                }),
                type.deliveryMs,
              ).pipe(Effect.catch(() => deleteRow(connection)))
            : Effect.void,
        ),
        Effect.forkIn(scope),
      )
    })

    const answer = yield* Fiber.join(attempt).pipe(
      Effect.timeoutOrElse({
        duration: type.deliveryMs,
        orElse: () => Effect.fail(ended("ActorUnavailable", true)),
      }),
      Effect.onError(() => abandon),
    )

    if (Predicate.isTagged(answer, "Failed")) {
      release(connection)

      return yield* OpenRejected.make({ value: answer.value })
    }

    yield* observe(actor, answer)

    if (BigInt(answer.baseline) > BigInt(actor.through)) actor.through = answer.baseline

    if (!connection.ended) {
      connection.openedAt = yield* now
      connection.open = true

      if (answer.recovered === true) yield* resync(actor, connection, yield* now, answer.baseline)
      connection.loop = yield* inboundLoop(connection).pipe(Effect.forkIn(scope))
    }

    const held_: HeldConnection = {
      connectionId: connection.id,
      cursor: answer.baseline,
      messages: Stream.fromQueue(connection.outbound).pipe(
        Stream.mapEffect((message) =>
          ClientMessage.guards.Progress(message)
            ? takenProgress(connection, message)
            : Effect.as(taken(connection, message), Option.some(message)),
        ),
        Stream.filter(Option.isSome),
        Stream.map((message) => message.value),
      ),
      send: (frame) =>
        Effect.gen(function* () {
          if (connection.ended) return yield* ended("ClientClosed", false)
          const bytes = utf8.encode(frame).byteLength

          if (bytes > MAX_INBOUND_BYTES)
            return yield* Effect.die(new Error("Connection frame exceeds 64 KiB"))

          if (heldBytes + bytes > MAX_HELD_BYTES || connection.inbound.length >= MAX_INBOUND_FRAMES)
            return yield* end(connection, ended("SlowConsumer", true), true)

          connection.inbound.push({ frame, issuedAt: (yield* now) - COMMAND_SKEW_MS })
          connection.inBytes += bytes
          heldBytes += bytes
          yield* Queue.offer(connection.wake, undefined)
        }),
      resyncDone: Effect.gen(function* () {
        const pending = connection.resync

        if (
          pending === undefined ||
          !pending.answered ||
          (type.hasResync(connection.member) && !pending.replayed)
        )
          return
        connection.resync = undefined
        heldBytes -= pending.deferredBytes
        pending.deferredBytes = 0

        for (const message of pending.deferred)
          if (
            !ClientMessage.guards.Frame(message) ||
            message.event === undefined ||
            !pending.replayedEvents.has(message.event)
          )
            yield* push(connection, message, false)
        yield* Queue.offer(connection.wake, undefined)
      }),
      authorized: Effect.map(now, (at) => !connection.ended && at < authorizedUntil(connection)),
      writable: Effect.gen(function* () {
        while (!connection.ended && connection.inbound.length >= MAX_INFLIGHT_FRAMES)
          yield* Queue.take(connection.drained)
      }),
      reauthenticate: (expiresAt) =>
        Effect.gen(function* () {
          const fail = (error: ActorError) =>
            Effect.andThen(end(connection, error, true), Effect.fail(error))

          if (connection.ended) return yield* ended("ClientClosed", false)
          const at = yield* now

          if (expiresAt !== undefined && at >= expiresAt) return yield* fail(credentialExpired)

          const allowed = yield* check(connection, connection.feed, "reauthorize")

          if (connection.ended) return yield* ended("ClientClosed", false)
          const answered = yield* now

          if (answered >= authorizedUntil(connection))
            return yield* fail(lapsed(connection, answered))

          if (!allowed)
            return yield* fail(
              ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
            )

          if (expiresAt !== undefined && answered >= expiresAt)
            return yield* fail(credentialExpired)

          connection.lastAuthorized = at
          connection.expiresAt = expiresAt
        }),
      close: Effect.gen(function* () {
        if (connection.ended) return
        const cause = SessionEnded.make({ cause: "ClientClosed", resync: false })
        yield* end(connection, ActorError.make({ reason: cause }), false)
        yield* retrying(
          connection,
          type.channel.close({ ...address(connection), cause }),
          type.deliveryMs,
        ).pipe(Effect.catch(() => deleteRow(connection)))
      }),
    }

    return held_
  })

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...held.values()],
      (connection) => end(connection, ended("HolderShutdown", true), true),
      {
        discard: true,
      },
    ),
  )

  return {
    open,
    deliver,
    size: () => held.size,
    /** The clock authorization and credential expiry are measured on, in epoch milliseconds. */
    now,
  }
})

/** The holder service `connectionHolder` builds. */
export type Holder = Effect.Success<ReturnType<typeof connectionHolder>>

export type { Scope }
