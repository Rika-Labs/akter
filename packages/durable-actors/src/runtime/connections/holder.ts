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
import { type ConnectionCommands, connectionSecret } from "../../identity/command.ts"
import { FrameworkClock } from "../turn/admission.ts"
import { BUCKETS } from "../turn/outbox.ts"
import { ClientMessage, type Deliver, type Delivered, HolderItem } from "./protocol.ts"
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
    request: Address & { readonly after?: string | undefined },
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
  readonly placement: "tenant" | "actor"
  readonly hasResync: (member: string) => boolean
  readonly hasMember: (member: string) => boolean
  readonly channel: OwnerChannel
  readonly routingKey: (ref: ActorRef) => bigint
}

export interface HolderOptions {
  readonly transport: () => Transport
  readonly actorType: (name: string) => HeldActorType | undefined
  readonly authorize: (request: {
    readonly caller: Caller
    readonly ref: ActorRef
    readonly command: string
    readonly kind: "open" | "reauthorize"
  }) => Effect.Effect<boolean>
}

interface Held {
  readonly id: string
  readonly ref: ActorRef
  readonly key: string
  readonly member: string
  readonly caller: Caller
  readonly type: HeldActorType
  readonly outbound: Queue.Queue<ClientMessage, ActorError | Cause.Done>
  readonly secret: string
  readonly inbound: Array<{ readonly frame: string; readonly issuedAt: number }>
  readonly wake: Queue.Queue<void>
  open: boolean
  ended: boolean
  outFrames: number
  outBytes: number
  inBytes: number
  nextSeq: number
  lastAuthorized: number
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
}

interface HeldActor {
  generation: bigint
  seq: number
  sealed: boolean
  through: string
  owner: string
  ownerEpoch: string
  lastCheck: number
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
    held.delete(connection.id)
    const actor = actors.get(connection.key)
    actor?.connections.delete(connection.id)

    if (actor !== undefined && actor.connections.size === 0) actors.delete(connection.key)
  }

  // Ends one connection once: its buffers are dropped and its client sees `error`.
  const end = (connection: Held, error: ActorError, deleteOwnRow: boolean) =>
    Effect.gen(function* () {
      if (connection.ended) return
      connection.ended = true
      connection.open = false
      release(connection)

      // A revoked client gets nothing more from the actor, including frames already queued.
      if (Predicate.isTagged(error.reason, "Unauthorized"))
        yield* Effect.ignore(Queue.clear(connection.outbound))
      yield* Queue.fail(connection.outbound, error)
      yield* Queue.offer(connection.wake, undefined)

      if (deleteOwnRow) yield* deleteRow(connection)
    })

  const push = (connection: Held, message: ClientMessage, control: boolean) =>
    Effect.gen(function* () {
      if (connection.ended) return
      const bytes = ClientMessage.guards.Frame(message) ? utf8.encode(message.frame).byteLength : 0

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

  const taken = (connection: Held, message: ClientMessage) =>
    Effect.sync(() => {
      if (connection.ended) return
      const bytes = ClientMessage.guards.Frame(message) ? utf8.encode(message.frame).byteLength : 0
      connection.outFrames -= 1
      connection.outBytes -= bytes
      heldBytes -= bytes
    })

  // The owner of `actor` died without sealing: every connection resyncs in place.
  const ownerLost = (actor: HeldActor) =>
    Effect.gen(function* () {
      if (actor.sealed) return
      actor.sealed = true
      const at = yield* now

      for (const connection of actor.connections.values()) {
        if (connection.open) yield* resync(actor, connection, at)
      }
    })

  // Asks one connection's client to resync in place from its last proven cursor.
  const resync = (actor: HeldActor, connection: Held, at: number, fromStart = false) =>
    Effect.gen(function* () {
      connection.resyncs = connection.resyncs.filter((time) => at - time < RESYNC_WINDOW_MS)
      connection.resyncs.push(at)

      if (connection.resyncs.length >= 3) {
        const retryAfterMs = yield* Random.nextIntBetween(1_000, 5_000)
        yield* end(connection, ended("OwnerLost", true, retryAfterMs), true)

        return
      }

      // A loss during a resync starts it again from the same cursor, keeping the frames it deferred.
      const previous = connection.resync
      const after =
        previous?.after ?? (fromStart || actor.through === "0" ? undefined : actor.through)
      connection.resync = {
        after,
        replayed: false,
        sent: false,
        answered: false,
        // Until the new owner answers, this bounds the takeover; then the client's acknowledgment.
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

  // Records the answering owner; a newer generation over an unsealed older one means the old owner died.
  const observe = (actor: HeldActor, owner: Owner) =>
    Effect.gen(function* () {
      const generation = BigInt(owner.generation)

      if (generation < actor.generation) return false

      if (generation > actor.generation) {
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

      // Late messages from a dead or superseded generation are dropped.
      if (!(yield* observe(actor, message))) return { wrongEpoch: false, unknown }

      // A redelivered message was already applied.
      if (message.seq <= actor.seq) return { wrongEpoch: false, unknown }

      if (message.seq !== actor.seq + 1) {
        // A gap means frames were lost: every connection must replay from its cursor.
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

                // Nothing reaches a client past its authorization bound.
                if (at >= authorizedUntil(connection)) return end(connection, unauthorized, true)

                const out = ClientMessage.cases.Frame.make({
                  frame: frame.frame,
                  cursor: frame.stamp ? message.through : undefined,
                  event: frame.stamp ? frame.event : undefined,
                })

                const pending = connection.resync

                // Live frames wait until the resync's replay is acknowledged, so replay always comes first.
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
        })

      return { wrongEpoch: false, unknown }
    })

  const retried = <A>(connection: Held, effect: Effect.Effect<A, ActorError>) =>
    effect.pipe(
      Effect.retry({
        while: (error) => error.isRetryable && !connection.ended,
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
    connection.lastAuthorized + connection.type.reauthorizeMs

  const unauthorized = ActorError.make({
    reason: Unauthorized.make({ code: "reauthorization_unavailable" }),
  })

  // Nothing reaches the owner once the connection's authorization has lapsed.
  const expired = (connection: Held) =>
    Effect.gen(function* () {
      if ((yield* now) < authorizedUntil(connection)) return false
      yield* end(connection, unauthorized, true)

      return true
    })

  const commandsOf = (connection: Held, seq: number, issuedAt: number): ConnectionCommands => ({
    secret: connection.secret,
    seq,
    issuedAt,
    expiresAt: issuedAt + connection.type.retryWindowMs,
  })

  // Delivers a connection's inbound frames one at a time, after any pending resync.
  const inboundLoop = (connection: Held) =>
    Effect.gen(function* () {
      while (!connection.ended) {
        const pending = connection.resync

        if (pending !== undefined && !pending.sent) {
          if (yield* expired(connection)) return
          pending.sent = true

          const answer = yield* retrying(
            connection,
            connection.type.channel.resync({ ...address(connection), after: pending.after }),
            Math.max(0, Math.min(authorizedUntil(connection), pending.deadline) - (yield* now)),
          ).pipe(Effect.exit)

          if (connection.ended) return

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

  const reauthorize = (connection: Held, at: number) =>
    Effect.gen(function* () {
      connection.checking = true

      const allowed = yield* options
        .authorize({
          caller: connection.caller,
          ref: connection.ref,
          command: connection.member,
          kind: "reauthorize",
        })
        .pipe(Effect.exit)

      connection.checking = false

      if (connection.ended) return

      if (Exit.isSuccess(allowed) && allowed.value) connection.lastAuthorized = at
      else if (Exit.isSuccess(allowed))
        yield* end(
          connection,
          ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
          true,
        )
    })

  // An owner that could not reach this holder dropped the rows of the
  // connections it held; each such connection ends so its client reconnects.
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

  // Reauthorization, resync deadlines, and owner liveness, checked on one clock.
  const tick = Effect.gen(function* () {
    const at = yield* now

    for (const connection of held.values()) {
      if (!connection.open) continue
      const every = connection.type.reauthorizeMs

      // A holder that cannot confirm its rows for a whole bound stops serving them.
      if (livenessFailedSince !== undefined && at - livenessFailedSince >= every) {
        yield* end(connection, ended("ActorUnavailable", true), false)

        continue
      }

      if (at >= connection.lastAuthorized + every) {
        yield* end(
          connection,
          ActorError.make({
            reason: Unauthorized.make({ code: "reauthorization_unavailable" }),
          }),
          true,
        )

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

      // A ping answered after a newer owner was observed says nothing about that owner.
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

    const allowed = yield* options.authorize({
      caller: request.caller,
      ref: request.ref,
      command: request.member,
      kind: "open",
    })

    if (!allowed)
      return yield* ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })

    const connection: Held = {
      id: yield* crypto.randomUUIDv7.pipe(Effect.orDie),
      ref: request.ref,
      key: actorKey(request.ref),
      member: request.member,
      caller: request.caller,
      type,
      outbound: yield* Queue.unbounded<ClientMessage, ActorError | Cause.Done>(),
      secret: connectionSecret(yield* crypto.randomBytes(32).pipe(Effect.orDie)),
      inbound: [],
      wake: yield* Queue.sliding<void>(1),
      open: false,
      ended: false,
      outFrames: 0,
      outBytes: 0,
      inBytes: 0,
      nextSeq: 0,
      lastAuthorized: yield* now,
      checking: false,
      resync: undefined,
      resyncs: [],
      loop: undefined,
    }

    // Registered before the owner commits, so frames flushed after that commit find it.
    const actor = actorOf(request.ref)
    actor.connections.set(connection.id, connection)
    held.set(connection.id, connection)

    const openCall = type.channel.open({
      ...address(connection),
      member: request.member,
      caller: request.caller,
      params: request.params,
      commands: {
        secret: connection.secret,
        seq: 0,
        issuedAt: (yield* now) - COMMAND_SKEW_MS,
        expiresAt: (yield* now) - COMMAND_SKEW_MS + type.retryWindowMs,
      },
    })

    // The owner may still commit an open this holder gave up on; such a late row is closed again.
    const attempt = yield* retried(connection, openCall).pipe(Effect.forkIn(scope))

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

    // An open handler that closed the connection leaves it already ended with `ServerClosed`.
    if (!connection.ended) {
      connection.open = true

      // Its opening frames and any broadcasts the lost owner never flushed may be gone.
      if (answer.recovered === true) yield* resync(actor, connection, yield* now, true)
      connection.loop = yield* inboundLoop(connection).pipe(Effect.forkIn(scope))
    }

    const held_: HeldConnection = {
      connectionId: connection.id,
      cursor: answer.baseline,
      messages: Stream.fromQueue(connection.outbound).pipe(
        Stream.tap((message) => taken(connection, message)),
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

        // An acknowledgment before the new owner answered, or before the member's replay finished, is ignored.
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
      close: Effect.gen(function* () {
        if (connection.ended) return
        const cause = SessionEnded.make({ cause: "ClientClosed", resync: false })
        yield* end(connection, ActorError.make({ reason: cause }), false)
        // The owner runs `close` and deletes the row; if it cannot, the holder deletes its own row.
        yield* retrying(
          connection,
          type.channel.close({ ...address(connection), cause }),
          type.deliveryMs,
        ).pipe(Effect.catch(() => deleteRow(connection)))
      }),
    }

    return held_
  })

  // A graceful shutdown ends every connection with a resync hint and deletes its rows.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...held.values()],
      (connection) => end(connection, ended("HolderShutdown", true), true),
      {
        discard: true,
      },
    ),
  )

  return { open, deliver, size: () => held.size }
})

export type Holder = Effect.Success<ReturnType<typeof connectionHolder>>

export type { Scope }
