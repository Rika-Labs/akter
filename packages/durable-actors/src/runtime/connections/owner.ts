import { Cause, Effect, Exit, Option, Schema, Semaphore } from "effect"
import { Entity } from "effect/unstable/cluster"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError, ActorUnavailable, NotCreated, SessionEnded } from "../../errors/actor.ts"
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
import { type ActivationCache, emptyActivationCache } from "../turn/execute.ts"
import { type Deliver, HolderItem } from "./protocol.ts"
import { HolderUnreachable, type Transport } from "./transport.ts"

/** Encoded bytes one connection's session may hold. */
export const MAX_SESSION_BYTES = 16_384

/** Open connections one actor may have per connection member. */
export const MAX_MEMBER_CONNECTIONS = 10_000

const utf8 = new TextEncoder()

const encodeCaller = Schema.encodeEffect(Schema.fromJsonString(Caller))

const decodeCaller = Schema.decodeEffect(Schema.fromJsonString(Caller))

interface Row {
  readonly connectionId: string
  readonly member: string
  readonly holder: string
  readonly holderEpoch: string
  readonly caller: Caller
  session: string | undefined
  frameSeq: number
}

interface Channel {
  readonly holder: string
  readonly epoch: string
  seq: number
}

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
  /** The highest commit whose frames all went out to their holders. */
  through: string
  readonly channels: Map<string, Channel>
  readonly flush: Semaphore.Semaphore
  /** Serializes the first load of `rows`, which opens may race to start. */
  readonly loading: Semaphore.Semaphore
  readonly locks: Map<string, Semaphore.Semaphore>
  /** Connections this activation opened itself; every other one is resumed. */
  readonly opened: Set<string>
  keptAwake: boolean
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
}: {
  readonly registration: Registration
  readonly transport: Transport
}) => {
  const activations = new Map<string, Activation>()
  const hasConnections = registration.connections.size > 0

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
          through: "0",
          channels: new Map(),
          flush: Semaphore.makeUnsafe(1),
          loading: Semaphore.makeUnsafe(1),
          locks: new Map(),
          opened: new Set(),
          keptAwake: false,
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

      for (const id of ids) activation.rows?.delete(id)
      yield* sql`DELETE FROM actor_connections WHERE ${actor} AND connection_id IN ${sql.in(ids)}`
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

      yield* dropRows(activation, answer.value.unknown)
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

  /** Fences this activation's generation and loads committed state, as a command turn would. */
  const acquire = (activation: Activation) =>
    Effect.gen(function* () {
      if (activation.cache.generation !== undefined && activation.cache.state !== undefined) return
      const sql = yield* SqlClient.SqlClient
      const actor = yield* where(activation)
      const { ref, key } = activation

      yield* sql.withTransaction(
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
            activation.cache.generation = undefined
            activation.cache.state = undefined

            return yield* unavailable("Stale actor generation")
          }

          const state = yield* sql<{ key: string; value: Uint8Array }>`
            SELECT key, value FROM actor_state WHERE ${actor}`

          activation.cache.generation = row!.generation
          activation.cache.state = new Map(state.map(({ key, value }) => [key, decompress(value)]))
          activation.head = row!.head
          activation.through = row!.head
        }),
      )
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
      }>`SELECT connection_id, member, holder, holder_epoch, caller, session, frame_seq::text AS frame_seq
        FROM actor_connections WHERE ${actor}`

      const rows = new Map<string, Row>()

      for (const row of stored)
        rows.set(row.connection_id, {
          connectionId: row.connection_id,
          member: row.member,
          holder: row.holder,
          holderEpoch: row.holder_epoch,
          caller: yield* decodeCaller(row.caller).pipe(Effect.orDie),
          session: row.session === null ? undefined : decompress(row.session),
          frameSeq: Number(row.frame_seq),
        })

      activation.rows = rows

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
        .filter((row) => row.member === member)
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
    },
  ) =>
    activation.flush.withPermit(
      Effect.gen(function* () {
        if (activation.rows === undefined || (broadcasts.length === 0 && own === undefined)) {
          activation.head = head
          activation.through = head

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
            last.event === item.event
          )
            perChannel.set(channel, [
              ...items.slice(0, -1),
              { ...last, to: [...last.to, ...item.to] },
            ])
          else perChannel.set(channel, [...items, item])
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
              }),
            )
        }

        for (const [channel, items] of perChannel)
          yield* send(
            activation,
            channel,
            head === activation.through
              ? items
              : [...items, HolderItem.cases.Flushed.make({ through: head })],
          )

        activation.head = head
        activation.through = head
      }),
    )

  const lockOf = (activation: Activation, connectionId: string) => {
    const found = activation.locks.get(connectionId)

    if (found !== undefined) return found
    const created = Semaphore.makeUnsafe(1)
    activation.locks.set(connectionId, created)

    return created
  }

  const events =
    (activation: Activation, sql: SqlClient.SqlClient) =>
    (tag: string, after: string | undefined, limit: number) =>
      replayEvents(activation.ref, activation.key, tag, after, BigInt(activation.head), limit).pipe(
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
    result.session !== undefined && utf8.encode(result.session).byteLength > MAX_SESSION_BYTES
      ? Effect.die(new Error("Connection session exceeds 16 KiB"))
      : Effect.void

  const setKeepAwake = (activation: Activation) =>
    Effect.gen(function* () {
      if (registration.policy.connections !== "keepAwake") return
      const open = (activation.rows?.size ?? 0) > 0

      if (open === activation.keptAwake) return
      activation.keptAwake = open
      yield* Entity.keepAlive(open)
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
    lockOf(activation, request.connectionId).withPermit(
      Effect.gen(function* () {
        const connection = registration.connections.get(request.member)

        if (connection === undefined)
          return yield* Effect.die(new Error(`Unregistered connection ${request.member}`))

        yield* acquire(activation)
        yield* load(activation)
        const existing = activation.rows!.get(request.connectionId)

        if (existing !== undefined && existing.holderEpoch === request.holderEpoch)
          return { _tag: "Opened" as const, ...identity(activation), baseline: activation.through }

        if (
          [...activation.rows!.values()].filter((row) => row.member === request.member).length >=
          MAX_MEMBER_CONNECTIONS
        )
          return yield* unavailable("Actor is at its connection limit for this member")

        const sql = yield* SqlClient.SqlClient
        const actor = yield* where(activation)

        if (registration.policy.createdBy !== undefined) {
          const [created] = yield* sql<{ created: boolean }>`
            SELECT created FROM actor_generations WHERE ${actor}`

          if (created?.created !== true)
            return yield* ActorError.make({ reason: NotCreated.make({}) })
        }

        const row = {
          connectionId: request.connectionId,
          member: request.member,
          holder: request.holder,
          holderEpoch: request.holderEpoch,
          caller: request.caller,
          session: undefined,
        }

        const baseline = activation.through

        const result = yield* run(
          activation,
          row,
          ConnectionPhase.cases.Open.make({ params: request.params }),
          request.commands,
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
            member, holder, holder_epoch, caller, session, opened_at_ms)
          SELECT routing_key, ${request.connectionId}, (routing_key >> 56)::integer, tenant_id, actor_type, actor_id,
            ${request.member}, ${request.holder}, ${request.holderEpoch}, ${caller},
            ${result.session === undefined ? null : compress(result.session)},
            floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
          FROM actor_generations WHERE ${actor} AND generation = ${activation.cache.generation!}
          RETURNING connection_id`

        if (inserted.length === 0) {
          activation.cache.generation = undefined
          activation.cache.state = undefined

          return yield* unavailable("Stale actor generation")
        }

        activation.rows!.set(request.connectionId, { ...row, session: result.session, frameSeq: 0 })
        activation.opened.add(request.connectionId)
        yield* setKeepAwake(activation)
        yield* flush(activation, result.broadcasts, activation.head, {
          connectionId: request.connectionId,
          member: request.member,
          frames: result.sends,
        })

        if (result.close)
          yield* closeRow(activation, request.connectionId, ended("ServerClosed", false))

        return { _tag: "Opened" as const, ...identity(activation), baseline }
      }).pipe(
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
      readonly commands: ConnectionCommands
    },
  ) =>
    lockOf(activation, request.connectionId).withPermit(
      Effect.gen(function* () {
        yield* acquire(activation)
        yield* load(activation)
        // The owner runs frames only from the connection's stored holder.
        const row = owned(activation, request)

        if (row === undefined)
          return { _tag: "Closed" as const, ended: ended("ServerClosed", true) }

        if (request.seq <= row.frameSeq) return { _tag: "Acked" as const, ...identity(activation) }

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
              FROM actor_generations g
              WHERE c.routing_key = ${activation.key} AND c.tenant_id = ${activation.ref.tenant}
                AND c.actor_type = ${activation.ref.actor} AND c.actor_id = ${activation.ref.id}
                AND c.connection_id = ${request.connectionId} AND c.frame_seq < ${request.seq}
                AND g.routing_key = c.routing_key AND g.tenant_id = c.tenant_id AND g.actor_type = c.actor_type
                AND g.actor_id = c.actor_id AND g.generation = ${activation.cache.generation!}
              RETURNING c.connection_id`

            if (written.length === 0) {
              activation.cache.generation = undefined
              activation.cache.state = undefined
              activation.rows = undefined

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
    lockOf(activation, request.connectionId).withPermit(
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
    request: Address & { readonly after?: string | undefined },
  ) =>
    lockOf(activation, request.connectionId).withPermit(
      Effect.gen(function* () {
        yield* acquire(activation)
        yield* load(activation)
        const row = owned(activation, request)

        if (row === undefined) return { _tag: "Closed" as const, ended: ended("OwnerLost", true) }

        if (!registration.connections.get(row.member)!.hasResync)
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
          })

          return { _tag: "Replayed" as const, ...identity(activation) }
        }).pipe(Effect.catchDefect(closeOnDefect(activation, request.connectionId)))
      }).pipe(
        Effect.catchIf(SqlError.isSqlError, (cause) =>
          Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
        ),
      ),
    )

  // Ends an activation as idle expiry would: holders get a seal, and whatever
  // runs next re-acquires the generation and sees `resumed === true`.
  const hibernate = (entityId: string) =>
    Effect.gen(function* () {
      const activation = activations.get(entityId)

      if (activation === undefined) return
      yield* seal(activation)
      activation.cache.generation = undefined
      activation.cache.state = undefined
      activation.rows = undefined
      activation.channels.clear()
      activation.opened.clear()
      activation.head = "0"
      activation.through = "0"
    })

  return {
    activations,
    hasConnections,
    hibernate,
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
