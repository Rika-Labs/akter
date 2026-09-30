import type { NodeInspectSymbol, Unify } from "../../../actor/definition.ts"
import { Cause, Effect, Exit, Layer, Option, Predicate, Schedule, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorError } from "../../../errors/actor.ts"
import { type ActorRef, System } from "../../../identity/caller.ts"
import {
  connectionHolder,
  type HeldActorType,
  type HeldConnection,
  type OwnerChannel,
  RESYNC_DEADLINE_MS,
} from "../../../runtime/connections/holder.ts"
import { ClientMessage, type Deliver, HolderItem } from "../../../runtime/connections/protocol.ts"
import { FrameworkClock } from "../../../runtime/turn/admission.ts"
import { ActorTest, type TestConnection, type TestMessage } from "../../actor-test.ts"
import { ActorCluster, type RunnerServices } from "../../cluster.ts"
import type { ConformanceEnvironment } from "../../conformance.ts"
import { type ConnectionsFixture, Live, Room, connectionsLayer } from "./actors.ts"

type LiveMessage = TestMessage<typeof Live.server.Type>

type LiveFrame = Extract<LiveMessage, { readonly _tag: "Frame" }>

export const isFrame = (message: LiveMessage | undefined): message is LiveFrame =>
  Predicate.isTagged(message, "Frame")

export const frameOf = (message: LiveMessage | undefined) =>
  isFrame(message) ? message.frame : undefined

export const cursorOf = (message: LiveMessage | undefined) =>
  isFrame(message) ? message.cursor : undefined

/** Reads the next `count` envelopes, control frames included. */
export const next = (connection: TestConnection<typeof Live>, count = 1) =>
  connection.messages.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((chunk): ReadonlyArray<LiveMessage> => [...chunk]),
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.die(new Error("No connection frame arrived")),
    }),
  )

/** Drains envelopes until the session ends and returns how it ended. */
export const endOf = (connection: TestConnection<typeof Live>) =>
  connection.messages.pipe(
    Stream.runDrain,
    Effect.exit,
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.die(new Error("The session did not end")),
    }),
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
    ),
  )

export const reasonOf = (error: ActorError | undefined) => error?.reason

export const rows = Effect.fnUntraced(function* (ref: ActorRef) {
  const sql = yield* SqlClient.SqlClient

  return yield* sql<{ member: string; frame_seq: string; session: Uint8Array | null }>`
    SELECT member, frame_seq::text AS frame_seq, session FROM actor_connections
    WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`
}, Effect.orDie)

export const connect = (id: string, name = "alice") =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const room = yield* Room.get(id)
    const connection = yield* test.connect(room.ref, Live, { name })

    return { test, room, connection }
  })

/** The `Echo` executor, which every cluster runner builds. */
const connectionsEffects = (fixture: ConnectionsFixture) =>
  Room.toJobLayer(
    Effect.succeed({
      LiveEcho: ({ text }: { readonly text: string }) =>
        Effect.suspend(() => fixture.echo).pipe(Effect.as(text)),
    }),
  ) as Layer.Layer<never, never, RunnerServices>

/** Reports whether no envelope arrives within one second. */
export const quiet = (connection: TestConnection<typeof Live>) =>
  connection.messages.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.timeout("1 second"),
    Effect.option,
    Effect.map(Option.isNone),
  )

/** Reads envelopes through the next `ResyncReplayed`. */
export const throughReplayed = (connection: TestConnection<typeof Live>) =>
  connection.messages.pipe(
    Stream.takeUntil((message) => Predicate.isTagged(message, "ResyncReplayed")),
    Stream.runCollect,
    Effect.map((chunk): ReadonlyArray<LiveMessage> => [...chunk]),
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.die(new Error("No ResyncReplayed arrived")),
    }),
  )

/** Collects envelopes until the session ends and returns them with how it ended. */
export const untilEnd = (connection: TestConnection<typeof Live>) =>
  Effect.gen(function* () {
    const seen: Array<LiveMessage> = []

    const exit = yield* connection.messages.pipe(
      Stream.runForEach((message) => Effect.sync(() => seen.push(message))),
      Effect.exit,
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.die(new Error("The session did not end")),
      }),
    )

    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

    return { seen, ended: reasonOf(Option.getOrUndefined(failure)) }
  })

export const posts = (ref: ActorRef) =>
  ActorTest.use((test) => test.inspect(ref)).pipe(
    Effect.map(({ state }) => (state as { readonly posts?: number }).posts ?? 0),
  )

const EXPIRATION_SECONDS = 3

export const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: ConnectionsFixture,
  options: { readonly runners: number; readonly holdersOnly?: ReadonlyArray<number> },
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners: options.runners,
          holdersOnly: options.holdersOnly,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: connectionsLayer(fixture),
          runnerActors: () => connectionsEffects(fixture),
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const OWNER = { generation: "1", owner: "owner", ownerEpoch: "owner-epoch" } as const

/**
 * A holder on its own transport whose owner side is `channel`, for cases that
 * need an owner answer the real one never gives. Unless `channel.open` says
 * otherwise, opening copies the row of the real connection `template`, so the
 * holder's liveness check keeps the session.
 */
export const fakeHolder = Effect.fnUntraced(function* (options: {
  readonly name: string
  readonly template: string
  /** Overrides owner calls; `copyRow` is the default open. */
  readonly channel?: (copyRow: OwnerChannel["open"]) => Partial<OwnerChannel>
  readonly type?: Partial<Omit<HeldActorType, "channel">>
  readonly alive?: () => boolean
  readonly offset?: () => number
}) {
  const sql = yield* SqlClient.SqlClient
  const holderName = `${options.name}-holder`
  const epoch = `${options.name}-epoch`

  const copyRow: OwnerChannel["open"] = (request) =>
    sql`
      INSERT INTO actor_connections (
        routing_key, connection_id, bucket, tenant_id, actor_type, actor_id, member,
        holder, holder_epoch, caller, session, opened_at_ms, opened_through
      )
      SELECT routing_key, ${request.connectionId}, bucket, tenant_id, actor_type, actor_id,
        member, ${request.holder}, ${request.holderEpoch}, caller, NULL, opened_at_ms, 0
      FROM actor_connections WHERE connection_id = ${options.template}`.pipe(
      Effect.orDie,
      Effect.as({ _tag: "Opened" as const, ...OWNER, baseline: "0" }),
    )

  const type: HeldActorType = {
    deliveryMs: 1_000,
    takeoverMs: 5_000,
    reauthorizeMs: 60_000,
    retryWindowMs: 60_000,
    placement: "actor",
    hasResync: () => true,
    hasMember: () => true,
    routingKey: () => 0n,
    ...options.type,
    channel: {
      open: copyRow,
      frame: () => Effect.die(new Error("No frame is sent")),
      close: () => Effect.void,
      resync: () => Effect.never,
      ...options.channel?.(copyRow),
    },
  }

  const holder = yield* connectionHolder({
    transport: () => ({
      holder: holderName,
      epoch,
      deliver: () => Effect.die(new Error("No owner delivers")),
      ping: () => Effect.sync(() => options.alive?.() ?? true),
    }),
    actorType: () => type,
    authorize: () => Effect.succeed(true),
  }).pipe(Effect.provideService(FrameworkClock, { offsetMillis: () => options.offset?.() ?? 0 }))

  const open = (ref: ActorRef) =>
    holder.open({ ref, member: Live.tag, caller: System.make({ source: "actor" }), params: "{}" })

  /** An owner message on the generation's channel carrying `items`. */
  const message = (
    ref: ActorRef,
    generation: string,
    seq: number,
    items: Deliver["items"],
  ): Deliver => ({ epoch, ...OWNER, ref, generation, seq, through: "0", items })

  return { holder, open, message }
})

/** An owner frame to `to`; the fake holder never decodes it. */
export const rawFrame = (to: ReadonlyArray<string>, frame: string) =>
  HolderItem.cases.Frame.make({ member: Live.tag, to, frame, stamp: true })

/** Collects a held connection's messages until it ends and returns them with how it ended. */
export const heldUntilEnd = (held: HeldConnection) =>
  Effect.gen(function* () {
    const seen: Array<ClientMessage> = []

    const exit = yield* held.messages.pipe(
      Stream.runForEach((message) => Effect.sync(() => seen.push(message))),
      Effect.exit,
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.die(new Error("The held session did not end")),
      }),
    )

    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

    return { seen, ended: reasonOf(Option.getOrUndefined(failure)) }
  })

/** The `Resync` a holder sends when an owner is lost, proving continuity through `after`. */
export const resyncFrom = (after: string | undefined) =>
  ClientMessage.cases.Resync.make({ after, reason: "OwnerLost", deadlineMs: RESYNC_DEADLINE_MS })

/** Polls `check` until it holds. */
export const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

export type { NodeInspectSymbol, Unify }
