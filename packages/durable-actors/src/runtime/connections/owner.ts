import {
  Cause,
  Clock,
  type Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { Entity, type Sharding } from "effect/unstable/cluster"
import { SqlClient, SqlError } from "effect/unstable/sql"
import {
  ActorError,
  ActorUnavailable,
  NotCreated,
  RunnerAtCapacity,
  SessionEnded,
  Unauthorized,
} from "../../errors/actor.ts"
import {
  type Broadcast,
  ConnectionPhase,
  type ConnectionResult,
  type OpenConnection,
  type Registration,
} from "../../handles/actors.ts"
import { type ActorRef, Caller } from "../../identity/caller.ts"
import type { ConnectionCommands } from "../../identity/command.ts"
import { replayEvents } from "../events/replay.ts"
import { compress, decompress } from "../storage/codec.ts"
import { FrameworkClock } from "../turn/admission.ts"
import {
  type ActivationCache,
  type CommittedEvents,
  emptyActivationCache,
} from "../turn/execute.ts"
import {
  type Deliver,
  FEED_MEMBER,
  FeedFrame,
  HolderItem,
  StreamFailed,
  StreamItem,
} from "./protocol.ts"
import { HolderUnreachable, type Transport } from "./transport.ts"

/** Encoded bytes one connection's session may hold. */
export const MAX_SESSION_BYTES = 16_384

/** Open connections one actor may have per connection member. */
export const MAX_MEMBER_CONNECTIONS = 10_000

/** Open stream subscriptions one actor may have. */
export const MAX_ACTOR_STREAMS = 256

/** Stream elements the owner holds for one subscriber before the handler waits. */
export const STREAM_WINDOW = 256

/** How long a stream's window may stay full before the subscription ends. */
export const STREAM_STALL_MS = 30_000

/** Events one `read.follow` page reads at most. */
const FOLLOW_PAGE = 1_000

/** How often the owner checks its subscriptions' authorization and windows. */
const STREAM_TICK = "100 millis"

const utf8 = new TextEncoder()

/** A session is stored inside its codec's `{"value":…}` envelope, which the limit does not count. */
const SESSION_ENVELOPE_BYTES =
  utf8.encode(JSON.stringify({ value: null })).byteLength - utf8.encode("null").byteLength

const encodeCaller = Schema.encodeEffect(Schema.fromJsonString(Caller))

const decodeCaller = Schema.decodeEffect(Schema.fromJsonString(Caller))

interface Row {
  readonly connectionId: string
  readonly member: string
  readonly holder: string
  readonly holderEpoch: string
  readonly caller: Caller
  /** The event cursor the connection opened at. */
  readonly baseline: string
  session: string | undefined
  frameSeq: number
  /** Broadcasts committed while the connection is still opening, sent after its open frames. */
  buffered?: Array<{ readonly frame: string; readonly event?: string | undefined }>
}

interface Channel {
  readonly holder: string
  readonly epoch: string
  seq: number
}

/** One open stream subscription, run by the owner for as long as its subscriber reads. */
interface Subscription {
  readonly member: string
  readonly caller: Caller
  /** When the subscriber's authorization last succeeded, on the framework clock. */
  lastAuthorized: number
  checking: boolean
  /** Since when the handler has waited on a full window, if it is waiting. */
  stalledSince: number | undefined
  readonly end: (error: ActorError, discard: boolean) => Effect.Effect<void>
}

export type Authorize = (request: {
  readonly caller: Caller
  readonly ref: ActorRef
  readonly command: string
  readonly kind: "stream" | "reauthorize"
  /** What a reauthorization renews, so a stream tag is never read as a feed's event tag. */
  readonly of?: "stream"
}) => Effect.Effect<boolean>

/**
 * One actor's activation on this runner, shared by its command entity and its
 * connection entity so both run under one generation fence. `rows` mirrors the
 * actor's committed `actor_connections` rows once loaded.
 */
export interface Activation {
  readonly ref: ActorRef
  readonly key: bigint
  readonly cache: ActivationCache
  presence: number
  rows: Map<string, Row> | undefined
  /** The committed event head this activation last read or wrote. */
  head: string
  /** Completed, and replaced, each time `head` advances; followers wait on it. */
  advanced: Deferred.Deferred<void>
  /** Open stream subscriptions, which end with this activation. */
  readonly streams: Set<Subscription>
  /** The highest commit whose frames all went out to their holders. */
  through: string
  readonly channels: Map<string, Channel>
  readonly flush: Semaphore.Semaphore
  /** Serializes the first load of `rows`, which opens may race to start. */
  readonly loading: Semaphore.Semaphore
  readonly locks: Map<string, Semaphore.Semaphore>
  /** Connections this activation opened itself; every other one is resumed. */
  readonly opened: Set<string>
  /** The entity that holds this activation awake, released through its own context. */
  keptAwake: Context.Context<Sharding.Sharding | Entity.CurrentAddress> | undefined
  /** Serializes generation acquisition across the command and connection entities. */
  readonly acquiring: Semaphore.Semaphore
}

const emptyResult: ConnectionResult = {
  session: undefined,
  changed: false,
  sends: [],
  broadcasts: [],
  close: false,
}

const ended = (cause: SessionEnded["cause"], resync: boolean) =>
  SessionEnded.make({ cause, resync })

const unavailable = (message: string) =>
  ActorError.make({ reason: ActorUnavailable.make({ cause: new Error(message) }) })

type Address = {
  readonly ref: ActorRef
  readonly connectionId: string
  readonly holder: string
  readonly holderEpoch: string
}

/**
 * The owner side of connections for one actor type: the activation registry
 * shared with commands, the fenced `actor_connections` writes, and ordered,
 * post-commit delivery of frames to every holder.
 */
export const activationOwner = ({
  registration,
  transport,
  authorize,
  clock,
}: {
  readonly registration: Registration
  readonly transport: Transport
  readonly authorize: Authorize
  readonly clock: { readonly offsetMillis: () => number }
}) => {
  const activations = new Map<string, Activation>()
  // Feeds are framework connections, so an actor type with feeds loads its rows like one with members.
  const hasConnections = registration.connections.size > 0 || registration.feeds.size > 0

  const hasStreams = registration.streams.size > 0

  const now = Effect.map(Clock.currentTimeMillis, (millis) => millis + clock.offsetMillis())

  // Followers wait on `advanced`; a new head wakes every one of them.
  const advance = (activation: Activation, head: string) => {
    if (BigInt(head) <= BigInt(activation.head)) return
    activation.head = head
    const previous = activation.advanced
    activation.advanced = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(previous, Exit.void)
  }

  const encodeFeedFrame = Schema.encodeEffect(Schema.fromJsonString(FeedFrame))

  /** A committed turn's feed events, broadcast to every open feed of the actor. */
  const feedBroadcasts = (committed: CommittedEvents) =>
    Effect.forEach(
      committed.events.flatMap((event, index) =>
        registration.feeds.has(event.tag)
          ? [{ event, cursor: String(BigInt(committed.after) + BigInt(index) + 1n) }]
          : [],
      ),
      ({ event, cursor }) =>
        encodeFeedFrame({
          tag: event.tag,
          value: event.value,
          commandId: committed.commandId,
          timestampMs: committed.emittedAtMs,
        }).pipe(
          Effect.orDie,
          Effect.map((frame): Broadcast => ({ member: FEED_MEMBER, frame, event: cursor })),
        ),
    )

  const where = (activation: Activation) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return sql`routing_key = ${activation.key} AND tenant_id = ${activation.ref.tenant}
          AND actor_type = ${activation.ref.actor} AND actor_id = ${activation.ref.id}`
    })

  const enter = (entityId: string, ref: ActorRef, key: bigint) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const found = activations.get(entityId)

        if (found !== undefined) {
          found.presence += 1

          return found
        }

        const created: Activation = {
          ref,
          key,
          cache: emptyActivationCache(),
          presence: 1,
          rows: undefined,
          head: "0",
          advanced: Deferred.makeUnsafe<void>(),
          streams: new Set(),
          through: "0",
          channels: new Map(),
          flush: Semaphore.makeUnsafe(1),
          loading: Semaphore.makeUnsafe(1),
          locks: new Map(),
          opened: new Set(),
          keptAwake: undefined,
          acquiring: Semaphore.makeUnsafe(1),
        }

        activations.set(entityId, created)

        return created
      }),
      (activation) =>
        Effect.gen(function* () {
          activation.presence -= 1

          if (activation.presence > 0) return
          activations.delete(entityId)
          // Holders learn the generation ended cleanly, so they do not resync.
          yield* seal(activation)
        }),
    )

  const channelOf = (activation: Activation, holder: string, epoch: string) => {
    const name = `${holder}|${epoch}`
    const found = activation.channels.get(name)

    if (found !== undefined) return found
    const created = { holder, epoch, seq: 0 }
    activation.channels.set(name, created)

    return created
  }

  const dropRows = (activation: Activation, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (ids.length === 0) return
      const sql = yield* SqlClient.SqlClient
      const actor = yield* where(activation)

      yield* sql`DELETE FROM actor_connections WHERE ${actor} AND connection_id IN ${sql.in(ids)}`

      for (const id of ids) activation.rows?.delete(id)
      const holder = activation.keptAwake

      if (holder !== undefined && (activation.rows?.size ?? 0) === 0) {
        activation.keptAwake = undefined
        yield* Entity.keepAlive(false).pipe(Effect.provideContext(holder))
      }
    })

  const send = (activation: Activation, channel: Channel, items: ReadonlyArray<HolderItem>) =>
    Effect.gen(function* () {
      channel.seq += 1

      const message: Deliver = {
        epoch: channel.epoch,
        owner: transport.holder,
        ownerEpoch: transport.epoch,
        ref: activation.ref,
        generation: activation.cache.generation ?? "0",
        seq: channel.seq,
        through: activation.through,
        items,
      }

      const held = [...(activation.rows?.values() ?? [])].flatMap((row) =>
        row.holder === channel.holder && row.holderEpoch === channel.epoch
          ? [row.connectionId]
          : [],
      )

      const answer = yield* transport
        .deliver(channel.holder, channel.epoch, message)
        .pipe(Effect.exit)

      if (Exit.isFailure(answer)) {
        // An unreachable holder is excluded: its rows go, and it ends those connections itself.
        if (Option.isSome(Cause.findErrorOption(answer.cause)))
          return yield* dropRows(activation, held)

        return yield* Effect.die(HolderUnreachable.make({ message: "Holder delivery failed" }))
      }

      if (answer.value.wrongEpoch) return yield* dropRows(activation, held)

      const mine = new Set(held)
      yield* dropRows(
        activation,
        answer.value.unknown.filter((id) => mine.has(id)),
      )
    }).pipe(Effect.catchIf(SqlError.isSqlError, () => Effect.void))

  const seal = (activation: Activation) =>
    activation.flush
      .withPermit(
        Effect.forEach(
          new Set([
            ...activation.channels.values(),
            ...[...(activation.rows?.values() ?? [])].map((row) =>
              channelOf(activation, row.holder, row.holderEpoch),
            ),
          ]),
          (channel) => send(activation, channel, [HolderItem.cases.Seal.make({})]),
          { discard: true },
        ),
      )
      .pipe(Effect.timeout("2 seconds"), Effect.ignore)

  // Drops what belongs to a generation: whatever runs next acquires a new one,
  // reloads the rows, and numbers each holder's messages from 1 again, which a
  // holder requires of every new generation.
  const forget = (activation: Activation) => {
    activation.cache.generation = undefined
    activation.cache.state = undefined
    activation.rows = undefined
    activation.channels.clear()
  }

  /** Fences this activation's generation and loads committed state, as a command turn would. */
  const acquire = (activation: Activation) =>
    activation.cache.generation !== undefined && activation.cache.state !== undefined
      ? Effect.void
      : activation.acquiring.withPermit(acquireOnce(activation))

  const acquireOnce = (activation: Activation) =>
    Effect.gen(function* () {
      if (activation.cache.generation !== undefined && activation.cache.state !== undefined) return
      const sql = yield* SqlClient.SqlClient
      const actor = yield* where(activation)
      const { ref, key } = activation

      const acquired = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}) ON CONFLICT DO NOTHING`

          const [row] =
            activation.cache.generation === undefined
              ? yield* sql<{ generation: string; head: string }>`
                  UPDATE actor_generations SET generation = generation + 1 WHERE ${actor}
                  RETURNING generation::text AS generation, event_sequence::text AS head`
              : yield* sql<{ generation: string; head: string }>`
                  SELECT generation::text AS generation, event_sequence::text AS head
                  FROM actor_generations WHERE ${actor}`

          if (
            activation.cache.generation !== undefined &&
            activation.cache.generation !== row!.generation
          ) {
            forget(activation)

            return yield* unavailable("Stale actor generation")
          }

          const state = yield* sql<{ key: string; value: Uint8Array }>`
            SELECT key, value FROM actor_state WHERE ${actor}`

          return { row: row!, state }
        }),
      )

      activation.cache.generation = acquired.row.generation
      activation.cache.state = new Map(
        acquired.state.map(({ key, value }) => [key, decompress(value)]),
      )
      advance(activation, acquired.row.head)
      activation.through = acquired.row.head
    })

  /** Loads the actor's connection rows once per activation, excluding holders that are gone. */
  const load = (activation: Activation) =>
    activation.rows !== undefined || !hasConnections
      ? Effect.void
      : activation.loading.withPermit(loadOnce(activation))

  const loadOnce = (activation: Activation) =>
    Effect.gen(function* () {
      if (activation.rows !== undefined) return
      const sql = yield* SqlClient.SqlClient
      const actor = yield* where(activation)

      const stored = yield* sql<{
        connection_id: string
        member: string
        holder: string
        holder_epoch: string
        caller: string
        session: Uint8Array | null
        frame_seq: string
        opened_through: string
      }>`SELECT connection_id, member, holder, holder_epoch, caller, session, frame_seq::text AS frame_seq,
          opened_through::text AS opened_through
        FROM actor_connections WHERE ${actor}`

      const rows = new Map<string, Row>()

      for (const row of stored)
        rows.set(row.connection_id, {
          connectionId: row.connection_id,
          member: row.member,
          holder: row.holder,
          holderEpoch: row.holder_epoch,
          caller: yield* decodeCaller(row.caller).pipe(Effect.orDie),
          baseline: row.opened_through,
          session: row.session === null ? undefined : decompress(row.session),
          frameSeq: Number(row.frame_seq),
        })

      activation.rows = rows
      yield* setKeepAwake(activation)

      // Every holder learns this owner before any of its broadcasts, so it can resync if this owner dies.
      yield* activation.flush.withPermit(
        Effect.forEach(
          new Set([...rows.values()].map((row) => `${row.holder}|${row.holderEpoch}`)),
          (name) => {
            const [holder, epoch] = name.split("|") as [string, string]

            return send(activation, channelOf(activation, holder, epoch), [])
          },
          { discard: true },
        ),
      )
    }).pipe(Effect.catchIf(SqlError.isSqlError, Effect.die))

  /** Readies an activation that is about to run a turn: fenced, with its connection rows. */
  const prepare = (activation: Activation) =>
    hasConnections
      ? Effect.andThen(acquire(activation), load(activation)).pipe(Effect.orDie)
      : Effect.void

  const list = (activation: Activation) => (member: string) =>
    Effect.sync((): ReadonlyArray<OpenConnection> =>
      [...(activation.rows?.values() ?? [])]
        .filter((row) => row.member === member && row.buffered === undefined)
        .slice(0, 1_000)
        .map((row) => ({
          connectionId: row.connectionId,
          caller: row.caller,
          session: row.session,
        })),
    )

  /** Sends committed frames to their holders in order and advances the flushed-through cursor. */
  const flush = (
    activation: Activation,
    broadcasts: ReadonlyArray<Broadcast>,
    head: string,
    own?: {
      readonly connectionId: string
      readonly member: string
      readonly frames: ConnectionResult["sends"]
      readonly replay?: boolean
    },
  ) =>
    activation.flush.withPermit(
      Effect.gen(function* () {
        if (activation.rows === undefined || (broadcasts.length === 0 && own === undefined)) {
          advance(activation, head)

          if (BigInt(head) > BigInt(activation.through)) activation.through = head

          return
        }

        const perChannel = new Map<Channel, Array<HolderItem>>()

        const add = (row: Row, item: Extract<HolderItem, { _tag: "Frame" }>) => {
          const channel = channelOf(activation, row.holder, row.holderEpoch)
          const items = perChannel.get(channel) ?? []
          const last = items.at(-1)

          if (
            last?._tag === "Frame" &&
            last.frame === item.frame &&
            last.member === item.member &&
            last.event === item.event &&
            !last.to.includes(item.to[0]!)
          )
            perChannel.set(channel, [
              ...items.slice(0, -1),
              { ...last, to: [...last.to, ...item.to] },
            ])
          else perChannel.set(channel, [...items, item])
        }

        const self = own === undefined ? undefined : activation.rows.get(own.connectionId)

        if (own !== undefined && self !== undefined) {
          const stamp = registration.connections.get(own.member)?.stampCursor ?? true

          for (const frame of own.frames)
            add(
              self,
              HolderItem.cases.Frame.make({
                member: own.member,
                to: [own.connectionId],
                frame: frame.frame,
                event: frame.event,
                stamp,
                replay: own.replay === true,
              }),
            )
        }

        for (const broadcast of broadcasts) {
          const stamp = registration.connections.get(broadcast.member)?.stampCursor ?? true
          const to = broadcast.to === undefined ? undefined : new Set(broadcast.to)
          const except = new Set(broadcast.except ?? [])

          for (const row of activation.rows.values())
            if (
              row.member === broadcast.member &&
              (to === undefined || to.has(row.connectionId)) &&
              !except.has(row.connectionId)
            )
              if (row.buffered !== undefined)
                row.buffered.push({ frame: broadcast.frame, event: broadcast.event })
              else
                add(
                  row,
                  HolderItem.cases.Frame.make({
                    member: row.member,
                    to: [row.connectionId],
                    frame: broadcast.frame,
                    event: broadcast.event,
                    stamp,
                  }),
                )
        }

        // A flush that read an older head than a concurrent one never moves the cursor back.
        const advanced = BigInt(head) > BigInt(activation.through)

        for (const [channel, items] of perChannel)
          yield* send(
            activation,
            channel,
            advanced ? [...items, HolderItem.cases.Flushed.make({ through: head })] : items,
          )

        advance(activation, head)

        if (advanced) activation.through = head
      }),
    )

  const lockOf = (activation: Activation, connectionId: string) => {
    const found = activation.locks.get(connectionId)

    if (found !== undefined) return found
    const created = Semaphore.makeUnsafe(1)
    activation.locks.set(connectionId, created)

    return created
  }

  // A connection's lock lives only as long as its row.
  const withLock = <A, E, R>(
    activation: Activation,
    connectionId: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    lockOf(activation, connectionId)
      .withPermit(effect)
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (activation.rows?.has(connectionId) !== true) activation.locks.delete(connectionId)
          }),
        ),
      )

  const events =
    (activation: Activation, sql: SqlClient.SqlClient) =>
    (tag: string, after: string | undefined, limit: number) =>
      replayEvents(
        activation.ref,
        activation.key,
        [tag],
        after,
        BigInt(activation.head),
        limit,
      ).pipe(
        Effect.catchIf(SqlError.isSqlError, Effect.die),
        Effect.provideService(SqlClient.SqlClient, sql),
      )

  const run = (
    activation: Activation,
    row: Omit<Row, "frameSeq">,
    phase: ConnectionPhase,
    commands?: ConnectionCommands,
  ) =>
    Effect.gen(function* () {
      const connection = registration.connections.get(row.member)!
      const sql = yield* SqlClient.SqlClient

      return yield* connection.run(
        {
          ref: activation.ref,
          connectionId: row.connectionId,
          member: row.member,
          caller: row.caller,
          resumed: !ConnectionPhase.guards.Open(phase) && !activation.opened.has(row.connectionId),
          cursor: activation.through,
          state: [...(activation.cache.state ?? new Map<string, string>())],
          session: row.session,
          connections: list(activation),
          events: events(activation, sql),
          commands,
        },
        phase,
      )
    })

  const checkSession = (result: ConnectionResult) =>
    result.session !== undefined &&
    utf8.encode(result.session).byteLength - SESSION_ENVELOPE_BYTES > MAX_SESSION_BYTES
      ? Effect.die(new Error("Connection session exceeds 16 KiB"))
      : Effect.void

  const setKeepAwake = (activation: Activation) =>
    Effect.gen(function* () {
      if (registration.policy.connections !== "keepAwake") return
      const open = (activation.rows?.size ?? 0) > 0

      if (open === (activation.keptAwake !== undefined)) return

      if (open) {
        activation.keptAwake = yield* Effect.context<Sharding.Sharding | Entity.CurrentAddress>()
        yield* Entity.keepAlive(true)

        return
      }

      const holder = activation.keptAwake!
      activation.keptAwake = undefined
      yield* Entity.keepAlive(false).pipe(Effect.provideContext(holder))
    })

  // A defect in a handler closes only its connection; the activation stays resident.
  const closeOnDefect = (activation: Activation, connectionId: string) => (cause: unknown) =>
    Effect.gen(function* () {
      yield* Effect.logError("Connection handler defect", Cause.die(cause))
      yield* dropRows(activation, [connectionId])

      return { _tag: "Closed" as const, ended: ended("Defect", false) }
    })

  const identity = (activation: Activation) => ({
    generation: activation.cache.generation!,
    owner: transport.holder,
    ownerEpoch: transport.epoch,
  })

  const open = (
    activation: Activation,
    request: Address & {
      readonly member: string
      readonly caller: Caller
      readonly params: string
      readonly commands: ConnectionCommands
    },
  ) =>
    withLock(
      activation,
      request.connectionId,
      Effect.gen(function* () {
        const feed = request.member === FEED_MEMBER

        if (feed ? registration.feeds.size === 0 : !registration.connections.has(request.member))
          return yield* Effect.die(new Error(`Unregistered connection ${request.member}`))

        yield* acquire(activation)
        yield* load(activation)
        const existing = activation.rows!.get(request.connectionId)

        // A retried open cannot know whether its opening frames reached the holder.
        if (existing !== undefined && existing.holderEpoch === request.holderEpoch)
          return {
            _tag: "Opened" as const,
            ...identity(activation),
            baseline: existing.baseline,
            recovered: true,
          }

        if (
          [...activation.rows!.values()].filter((row) => row.member === request.member).length >=
          MAX_MEMBER_CONNECTIONS
        )
          return yield* feed
            ? ActorError.make({ reason: RunnerAtCapacity.make({}) })
            : unavailable("Actor is at its connection limit for this member")

        const sql = yield* SqlClient.SqlClient
        const actor = yield* where(activation)

        if (registration.policy.createdBy !== undefined) {
          const [created] = yield* sql<{ created: boolean }>`
            SELECT created FROM actor_generations WHERE ${actor}`

          if (created?.created !== true)
            return yield* ActorError.make({ reason: NotCreated.make({}) })
        }

        const baseline = activation.through

        const row = {
          connectionId: request.connectionId,
          member: request.member,
          holder: request.holder,
          holderEpoch: request.holderEpoch,
          caller: request.caller,
          baseline,
          session: undefined,
        }

        activation.rows!.set(request.connectionId, { ...row, frameSeq: 0, buffered: [] })

        // A feed has no handler: its open only inserts the row and fixes its baseline.
        const result = yield* (
          feed
            ? Effect.succeed<ConnectionResult>(emptyResult)
            : run(
                activation,
                row,
                ConnectionPhase.cases.Open.make({ params: request.params }),
                request.commands,
              )
        ).pipe(
          Effect.catchDefect((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("Connection open defect", Cause.die(cause))

              return yield* ActorError.make({ reason: ended("Defect", false) })
            }),
          ),
          Effect.catchIf(
            (error) => "failure" in error,
            (error) => Effect.succeed({ failure: error.failure }),
          ),
        )

        if ("failure" in result) return { _tag: "Failed" as const, value: result.failure }

        yield* checkSession(result).pipe(
          Effect.catchDefect(() => ActorError.make({ reason: ended("Defect", false) })),
        )

        const caller = yield* encodeCaller(request.caller).pipe(Effect.orDie)

        const inserted = yield* sql<{ connection_id: string }>`
          INSERT INTO actor_connections (routing_key, connection_id, bucket, tenant_id, actor_type, actor_id,
            member, holder, holder_epoch, caller, session, opened_at_ms, opened_through)
          SELECT routing_key, ${request.connectionId}, (routing_key >> 56)::integer, tenant_id, actor_type, actor_id,
            ${request.member}, ${request.holder}, ${request.holderEpoch}, ${caller},
            ${result.session === undefined ? null : compress(result.session)},
            floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint, ${baseline}::bigint
          FROM actor_generations WHERE ${actor} AND generation = ${activation.cache.generation!}
          RETURNING connection_id`

        if (inserted.length === 0) {
          forget(activation)

          return yield* unavailable("Stale actor generation")
        }

        const buffered = activation.rows!.get(request.connectionId)?.buffered ?? []
        activation.rows!.set(request.connectionId, { ...row, session: result.session, frameSeq: 0 })
        activation.opened.add(request.connectionId)
        yield* setKeepAwake(activation)
        yield* flush(activation, result.broadcasts, activation.head, {
          connectionId: request.connectionId,
          member: request.member,
          frames: [...result.sends, ...buffered],
        })

        if (result.close)
          yield* closeRow(activation, request.connectionId, ended("ServerClosed", false))

        return { _tag: "Opened" as const, ...identity(activation), baseline }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (activation.rows?.get(request.connectionId)?.buffered !== undefined)
              activation.rows.delete(request.connectionId)
          }),
        ),
        Effect.catchIf(SqlError.isSqlError, (cause) =>
          Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
        ),
      ),
    )

  // Deletes a connection's row and tells its holder, after any frames already sent.
  const closeRow = (activation: Activation, connectionId: string, cause: SessionEnded) =>
    Effect.gen(function* () {
      const row = activation.rows?.get(connectionId)

      if (row === undefined) return
      yield* activation.flush.withPermit(
        Effect.gen(function* () {
          yield* dropRows(activation, [connectionId])
          yield* send(activation, channelOf(activation, row.holder, row.holderEpoch), [
            HolderItem.cases.End.make({ connectionId, ended: cause }),
          ])
        }),
      )
      yield* setKeepAwake(activation)
    })

  const owned = (activation: Activation, request: Address) => {
    const row = activation.rows?.get(request.connectionId)

    return row !== undefined &&
      row.holder === request.holder &&
      row.holderEpoch === request.holderEpoch
      ? row
      : undefined
  }

  const frame = (
    activation: Activation,
    request: Address & {
      readonly seq: number
      readonly frame: string
      readonly authorizedUntil: number
      readonly commands: ConnectionCommands
    },
  ) =>
    withLock(
      activation,
      request.connectionId,
      Effect.gen(function* () {
        yield* acquire(activation)
        yield* load(activation)
        // The owner runs frames only from the connection's stored holder.
        const row = owned(activation, request)

        if (row === undefined)
          return { _tag: "Closed" as const, ended: ended("ServerClosed", true) }

        if (request.seq <= row.frameSeq) return { _tag: "Acked" as const, ...identity(activation) }

        // A frame that reaches the owner past its session's authorization bound never runs.
        const clock = yield* FrameworkClock

        if ((yield* Clock.currentTimeMillis) + clock.offsetMillis() >= request.authorizedUntil) {
          yield* dropRows(activation, [request.connectionId])
          yield* setKeepAwake(activation)

          return { _tag: "Closed" as const, ended: ended("ServerClosed", false) }
        }

        return yield* Effect.gen(function* () {
          const result = yield* run(
            activation,
            row,
            ConnectionPhase.cases.Frame.make({ frame: request.frame }),
            request.commands,
          ).pipe(Effect.catch(() => Effect.die(new Error("A frame handler cannot fail"))))

          yield* checkSession(result)

          if (result.changed) {
            const sql = yield* SqlClient.SqlClient

            const written = yield* sql<{ connection_id: string }>`
              UPDATE actor_connections c SET session = ${result.session === undefined ? null : compress(result.session)},
                frame_seq = ${request.seq}
              FROM (
                SELECT routing_key, tenant_id, actor_type, actor_id FROM actor_generations
                WHERE routing_key = ${activation.key} AND tenant_id = ${activation.ref.tenant}
                  AND actor_type = ${activation.ref.actor} AND actor_id = ${activation.ref.id}
                  AND generation = ${activation.cache.generation!}
                FOR SHARE
              ) g
              WHERE c.routing_key = g.routing_key AND c.tenant_id = g.tenant_id
                AND c.actor_type = g.actor_type AND c.actor_id = g.actor_id
                AND c.connection_id = ${request.connectionId} AND c.frame_seq < ${request.seq}
              RETURNING c.connection_id`

            if (written.length === 0) {
              forget(activation)

              return yield* unavailable("Stale actor generation")
            }

            row.session = result.session
          }

          row.frameSeq = request.seq
          yield* flush(activation, result.broadcasts, activation.head, {
            connectionId: request.connectionId,
            member: row.member,
            frames: result.sends,
          })

          if (result.close) {
            yield* dropRows(activation, [request.connectionId])
            yield* setKeepAwake(activation)

            return { _tag: "Closed" as const, ended: ended("ServerClosed", false) }
          }

          return { _tag: "Acked" as const, ...identity(activation) }
        }).pipe(Effect.catchDefect(closeOnDefect(activation, request.connectionId)))
      }).pipe(
        Effect.catchIf(SqlError.isSqlError, (cause) =>
          Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
        ),
      ),
    )

  const close = (activation: Activation, request: Address & { readonly cause: SessionEnded }) =>
    withLock(
      activation,
      request.connectionId,
      Effect.gen(function* () {
        yield* acquire(activation)
        yield* load(activation)
        const row = owned(activation, request)

        if (row === undefined) return

        const result = yield* run(
          activation,
          row,
          ConnectionPhase.cases.Close.make({ reason: request.cause.cause }),
        ).pipe(
          Effect.catchDefect((cause) =>
            Effect.as(Effect.logError("Connection close defect", Cause.die(cause)), undefined),
          ),
          Effect.orElseSucceed(() => undefined),
        )

        yield* dropRows(activation, [request.connectionId])
        activation.opened.delete(request.connectionId)
        activation.locks.delete(request.connectionId)
        yield* setKeepAwake(activation)

        if (result !== undefined) yield* flush(activation, result.broadcasts, activation.head)
      }).pipe(
        Effect.catchIf(SqlError.isSqlError, (cause) =>
          Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
        ),
      ),
    )

  const resync = (
    activation: Activation,
    request: Address & { readonly after?: string | undefined; readonly authorizedUntil: number },
  ) =>
    withLock(
      activation,
      request.connectionId,
      Effect.gen(function* () {
        yield* acquire(activation)
        yield* load(activation)
        const row = owned(activation, request)

        if (row === undefined) return { _tag: "Closed" as const, ended: ended("OwnerLost", true) }

        const clock = yield* FrameworkClock

        if ((yield* Clock.currentTimeMillis) + clock.offsetMillis() >= request.authorizedUntil) {
          yield* dropRows(activation, [request.connectionId])
          yield* setKeepAwake(activation)

          return { _tag: "Closed" as const, ended: ended("ServerClosed", false) }
        }

        // A feed's holder rereads the events itself once the new owner answers.
        if (row.member === FEED_MEMBER || !registration.connections.get(row.member)!.hasResync)
          return { _tag: "Replayed" as const, ...identity(activation) }

        return yield* Effect.gen(function* () {
          const result = yield* run(
            activation,
            row,
            ConnectionPhase.cases.Resync.make({ after: request.after }),
          ).pipe(Effect.catch(() => Effect.die(new Error("A resync handler cannot fail"))))

          yield* flush(activation, result.broadcasts, activation.head, {
            connectionId: request.connectionId,
            member: row.member,
            frames: result.sends,
            replay: true,
          })

          if (result.close) {
            yield* dropRows(activation, [request.connectionId])
            yield* setKeepAwake(activation)

            return { _tag: "Closed" as const, ended: ended("ServerClosed", false) }
          }

          return { _tag: "Replayed" as const, ...identity(activation) }
        }).pipe(Effect.catchDefect(closeOnDefect(activation, request.connectionId)))
      }).pipe(
        Effect.catchIf(SqlError.isSqlError, (cause) =>
          Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
        ),
      ),
    )

  // Replays after `after` up to the head, then waits for each commit that
  // advances it. The head only moves after a commit, and each page starts
  // where the previous one stopped, so nothing is skipped or read twice.
  const follow =
    (activation: Activation, sql: SqlClient.SqlClient) =>
    (tag: string, after: string | undefined) =>
      Stream.paginate({ cursor: after, first: true }, ({ cursor, first }) =>
        Effect.gen(function* () {
          const signal = activation.advanced
          const head = activation.head

          if (!first && BigInt(head) <= BigInt(cursor ?? "0")) {
            yield* Deferred.await(signal)

            return [[], Option.some({ cursor, first: false })] as const
          }

          const page = yield* replayEvents(
            activation.ref,
            activation.key,
            [tag],
            cursor,
            BigInt(head),
            FOLLOW_PAGE,
          ).pipe(
            Effect.catchIf(SqlError.isSqlError, Effect.die),
            Effect.provideService(SqlClient.SqlClient, sql),
          )

          const next = page.length === FOLLOW_PAGE ? page.at(-1)!.cursor : head

          return [page, Option.some({ cursor: next, first: false })] as const
        }),
      )

  const unauthorized = (code: "access_denied" | "reauthorization_unavailable") =>
    ActorError.make({ reason: Unauthorized.make({ code }) })

  /**
   * Runs one subscription's handler on this activation. The subscriber reads
   * `Started` first, then elements through a window of `STREAM_WINDOW`; a
   * handler that ends by itself ends with `Done`, and every other end is an
   * error, so an ended activation is never a silent completion.
   */
  const subscribe = (
    activation: Activation,
    request: {
      readonly member: string
      readonly caller: Caller
      readonly input: string
      readonly authorizedUntil: number
    },
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stream = registration.streams.get(request.member)

        if (stream === undefined)
          return yield* Effect.die(new Error(`Unregistered stream ${request.member}`))

        // A subscription that reaches the owner past its bound never runs.
        if ((yield* now) >= request.authorizedUntil)
          return yield* unauthorized("reauthorization_unavailable")

        const allowed = yield* authorize({
          caller: request.caller,
          ref: activation.ref,
          command: request.member,
          kind: "stream",
        })

        if (!allowed) return yield* unauthorized("access_denied")

        if (activation.streams.size >= MAX_ACTOR_STREAMS)
          return yield* ActorError.make({ reason: RunnerAtCapacity.make({}) })

        yield* acquire(activation).pipe(
          Effect.catchIf(SqlError.isSqlError, (cause) =>
            Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
          ),
        )

        const sql = yield* SqlClient.SqlClient

        const queue = yield* Queue.bounded<
          StreamItem,
          ActorError | typeof StreamFailed.Type | Cause.Done
        >(STREAM_WINDOW)

        let producer: Fiber.Fiber<void> | undefined
        let closed = false

        const subscription: Subscription = {
          member: request.member,
          caller: request.caller,
          lastAuthorized: yield* now,
          checking: false,
          stalledSince: undefined,
          end: (error, discard) =>
            Effect.gen(function* () {
              if (closed) return
              closed = true
              activation.streams.delete(subscription)

              if (producer !== undefined) yield* Fiber.interrupt(producer)

              if (discard) yield* Queue.clear(queue).pipe(Effect.ignore)
              yield* Queue.fail(queue, error)
            }),
        }

        activation.streams.add(subscription)

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closed = true
            activation.streams.delete(subscription)

            if (producer !== undefined) yield* Fiber.interrupt(producer)
          }),
        )

        const offer = (item: StreamItem) =>
          Effect.gen(function* () {
            if (Queue.offerUnsafe(queue, item)) return
            subscription.stalledSince = yield* now
            yield* Queue.offer(queue, item)
            subscription.stalledSince = undefined
          })

        producer = yield* stream
          .run(request.input, {
            ref: activation.ref,
            caller: request.caller,
            cursor: activation.head,
            state: [...(activation.cache.state ?? new Map<string, string>())],
            events: events(activation, sql),
            follow: follow(activation, sql),
          })
          .pipe(
            Stream.runForEach((value) => offer(StreamItem.cases.Element.make({ value }))),
            Effect.andThen(offer(StreamItem.cases.Done.make({}))),
            Effect.andThen(Queue.end(queue)),
            Effect.catch(({ failure }) => Queue.fail(queue, StreamFailed.make({ value: failure }))),
            Effect.catchDefect((cause) =>
              Effect.andThen(
                Effect.logError("Stream handler defect", Cause.die(cause)),
                Queue.fail(queue, ActorError.make({ reason: ended("Defect", false) })),
              ),
            ),
            Effect.asVoid,
            Effect.ensuring(
              Effect.sync(() => {
                closed = true
                activation.streams.delete(subscription)
              }),
            ),
            Effect.forkDetach,
          )

        return Stream.succeed(
          StreamItem.cases.Started.make({ owner: transport.holder, ownerEpoch: transport.epoch }),
        ).pipe(Stream.concat(Stream.fromQueue(queue)))
      }),
    )

  /** Ends every subscription of an activation that is ending. */
  const endStreams = (activation: Activation) =>
    Effect.forEach(
      [...activation.streams],
      (subscription) =>
        subscription.end(ActorError.make({ reason: ended("ActivationEnded", false) }), false),
      { discard: true },
    )

  const reauthorizeStream = (activation: Activation, subscription: Subscription, at: number) =>
    Effect.gen(function* () {
      subscription.checking = true

      const every = registration.policy.reauthorizeMs

      // A hook that hangs is retried at the next tick; the bound still ends the session.
      const allowed = yield* authorize({
        caller: subscription.caller,
        ref: activation.ref,
        command: subscription.member,
        kind: "reauthorize",
        of: "stream",
      }).pipe(Effect.timeout(Math.min(10_000, every / 2)), Effect.exit)

      subscription.checking = false
      const bound = subscription.lastAuthorized + every

      // An answer that arrives past the bound cannot extend it.
      if (Exit.isSuccess(allowed) && allowed.value && (yield* now) >= bound)
        yield* subscription.end(unauthorized("reauthorization_unavailable"), true)
      else if (Exit.isSuccess(allowed) && allowed.value) subscription.lastAuthorized = at
      else if (Exit.isSuccess(allowed)) yield* subscription.end(unauthorized("access_denied"), true)
    })

  /**
   * Reauthorizes each subscriber within `reauthorizeEvery` and ends a
   * subscription whose window stayed full for `STREAM_STALL_MS`, on the
   * owner's clock. Revocation discards the elements not yet delivered.
   */
  const watchStreams = Effect.gen(function* () {
    const at = yield* now
    const every = registration.policy.reauthorizeMs

    // Ends run on their own fibers, so one slow handler never holds up the rest.
    for (const activation of activations.values())
      for (const subscription of activation.streams) {
        if (at >= subscription.lastAuthorized + every) {
          yield* subscription
            .end(unauthorized("reauthorization_unavailable"), true)
            .pipe(Effect.forkDetach)

          continue
        }

        if (
          subscription.stalledSince !== undefined &&
          at - subscription.stalledSince >= STREAM_STALL_MS
        ) {
          yield* subscription
            .end(ActorError.make({ reason: ended("SlowConsumer", true) }), true)
            .pipe(Effect.forkDetach)

          continue
        }

        if (
          !subscription.checking &&
          at >= subscription.lastAuthorized + every - Math.min(10_000, every / 2)
        )
          yield* reauthorizeStream(activation, subscription, at).pipe(Effect.forkDetach)
      }
  }).pipe(Effect.repeat(Schedule.spaced(STREAM_TICK)), Effect.asVoid)

  // Ends an activation as idle expiry would: holders get a seal, and whatever
  // runs next re-acquires the generation and sees `resumed === true`.
  const hibernate = (entityId: string) =>
    Effect.gen(function* () {
      const activation = activations.get(entityId)

      if (activation === undefined) return
      yield* endStreams(activation)
      yield* seal(activation)
      forget(activation)
      activation.opened.clear()
      activation.head = "0"
      activation.through = "0"
    })

  return {
    activations,
    hasConnections,
    hasStreams,
    feedBroadcasts,
    hibernate,
    subscribe,
    endStreams,
    watchStreams,
    enter,
    prepare,
    list,
    flush,
    open,
    frame,
    close,
    resync,
  }
}

export type Owner = ReturnType<typeof activationOwner>
