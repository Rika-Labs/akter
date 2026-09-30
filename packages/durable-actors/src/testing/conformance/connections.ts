import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Intent, User } from "../../index.ts"
import { ActorError, ActorUnavailable, SessionEnded, Unauthorized } from "../../errors/actor.ts"
import { type ActorRef, CurrentCaller, System, Tenant } from "../../identity/caller.ts"
import {
  connectionHolder,
  type HeldActorType,
  type HeldConnection,
  MAX_OUTBOUND_BYTES,
  MAX_OUTBOUND_FRAMES,
  type OwnerChannel,
  RESYNC_DEADLINE_MS,
} from "../../runtime/connections/holder.ts"
import { MAX_SESSION_BYTES } from "../../runtime/connections/owner.ts"
import { ClientMessage, type Deliver, HolderItem } from "../../runtime/connections/protocol.ts"
import { decompress } from "../../runtime/storage/codec.ts"
import { FrameworkClock } from "../../runtime/turn/admission.ts"
import { ActorTest, type TestConnection, type TestMessage } from "../actor-test.ts"
import { ActorCluster, type RunnerServices } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

class Said extends Actor.Event<Said>()("Said", { text: Schema.String }) {}

class Hello extends Schema.TaggedClass<Hello>()("Hello", {
  name: Schema.String,
  resumed: Schema.Boolean,
  frames: Schema.Finite,
}) {}

class Say extends Schema.TaggedClass<Say>()("Say", { text: Schema.String }) {}

/** A server frame with an event entry's shape whose `event` is no server frame. */
class Receipted extends Schema.TaggedClass<Receipted>()("Receipted", {
  cursor: Schema.String,
  event: Schema.String,
  commandId: Schema.String,
  timestamp: Schema.DateTimeUtc,
}) {}

const receipted = Receipted.make({
  cursor: "7",
  event: "not a frame",
  commandId: "command",
  timestamp: DateTime.makeUnsafe(0),
})

class Banned extends Schema.TaggedError<Banned>()("Banned", { name: Schema.String }) {}

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const LiveSession = Schema.Struct({ name: Schema.String, frames: Schema.Finite })

/** A session's own encoded JSON, which the 16 KiB limit measures. */
const sessionJson = (session: typeof LiveSession.Type) =>
  Schema.encodeEffect(Schema.fromJsonString(LiveSession))(session).pipe(Effect.orDie)

/** A stored session: its encoded JSON inside the codec's `value` envelope. */
const storedSession = (stored: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ value: LiveSession })))(stored).pipe(
    Effect.orDie,
  )

const Live = Actor.connection("Live", {
  params: Schema.Struct({ name: Schema.String }),
  server: Schema.Union([Said, Hello, Receipted]),
  client: Say,
  session: LiveSession,
  errors: [Banned],
})

/** A connection member `LiveRoom` does not declare. */
const Undeclared = Actor.connection("Undeclared", {
  params: Schema.Struct({}),
  server: Said,
  client: Say,
})

const Post = Actor.command("Post", { input: Schema.String, errors: [Refused] })

/** Stages `Post(text)` to the room `to`, or to itself, as an intent delayed by `afterMs` when given. */
const Forward = Actor.command("Forward", {
  input: Schema.Struct({
    to: Schema.optional(Schema.String),
    text: Schema.String,
    afterMs: Schema.optional(Schema.Int),
  }),
})

/** Performs `Echo`, whose success routes back to the room as `Echoed`. */
const Shout = Actor.command("Shout", { input: Schema.String })

const Echoed = Actor.command("Echoed", { input: Schema.String })

class Echo extends Actor.effect<Echo>()("LiveEcho", {
  input: { text: Schema.String },
  success: Schema.String,
}) {}

const Room = Actor.make("LiveRoom", {
  key: Schema.String,
  state: Actor.state({ posts: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Said],
  effects: [Echo],
  api: { Live, Post, Forward, Shout },
  internal: { Echoed },
  policy: { effects: { LiveEcho: { onSuccess: Echoed } } },
})

/** Frames a `flood` sends in one handler, past the 1,024-frame outbound limit. */
const FLOOD = 1_100

/** Controls the connection cases share with the room's handlers; a case restores what it changes. */
export interface ConnectionsFixture {
  /** Where an open for `held` or a `hold` frame waits, once; it then resets to nothing. */
  hold: Effect.Effect<void>
  /** What the `Echo` executor does before it succeeds. */
  echo: Effect.Effect<void>
}

export const connectionsFixture = (): ConnectionsFixture => ({
  hold: Effect.void,
  echo: Effect.void,
})

const takeHold = (fixture: ConnectionsFixture) =>
  Effect.suspend(() => {
    const hold = fixture.hold
    fixture.hold = Effect.void

    return hold
  })

/** Makes the next handler that reaches `hold` wait until the case releases it. */
const holdNext = (fixture: ConnectionsFixture) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    fixture.hold = Deferred.succeed(reached, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    )

    return {
      reached: Deferred.await(reached),
      release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
    }
  })

const said = Effect.fnUntraced(function* (text: string) {
  const turn = yield* Room.Turn
  yield* turn.emit(Said.make({ text }))
  yield* turn.broadcast(Live, Said.make({ text }))
})

export const connectionsLayer = (fixture: ConnectionsFixture) =>
  Room.toLayer(
    Effect.succeed({
      Post: Effect.fnUntraced(function* (text: string) {
        const turn = yield* Room.Turn
        yield* said(text)

        if (text === "refuse") return yield* Refused.make({})

        yield* turn.state.set({ posts: turn.state.posts + 1 })
      }),
      Forward: Effect.fnUntraced(function* ({ to, text, afterMs }) {
        const turn = yield* Room.Turn
        const intent = (yield* Room.intents(to ?? turn.id)).Post(text)

        yield* afterMs === undefined ? intent : intent.pipe(Intent.after(Duration.millis(afterMs)))
      }),
      Shout: Effect.fnUntraced(function* (text: string) {
        const turn = yield* Room.Turn
        yield* turn.perform(Echo.make({ text }))
      }),
      Echoed: said,
      Live: {
        open: Effect.fnUntraced(function* ({ name }: { readonly name: string }) {
          const conn = yield* Room.Connection

          if (name === "mallory") return yield* Banned.make({ name })

          if (name === "leaver") return yield* conn.close

          if (name === "held") yield* takeHold(fixture)

          yield* conn.session.set({ name, frames: 0 })
          yield* conn.send(Hello.make({ name, resumed: conn.resumed, frames: 0 }))
        }),
        frame: Effect.fnUntraced(function* (frame: Say) {
          const conn = yield* Room.Connection
          const session = Option.getOrElse(yield* conn.session.get, () => ({ name: "", frames: 0 }))
          const frames = session.frames + 1
          yield* conn.session.set({ frames })

          if (frame.text === "hold") {
            yield* takeHold(fixture)

            return yield* conn.send(
              Hello.make({ name: session.name, resumed: conn.resumed, frames }),
            )
          }

          if (frame.text === "leave") return yield* conn.close

          if (frame.text === "receipted") return yield* conn.send(receipted)

          if (frame.text.startsWith("grow:")) {
            const length = Number(frame.text.slice("grow:".length))
            yield* conn.session.set({ name: "x".repeat(length), frames })

            return yield* conn.send(
              Hello.make({ name: `${length}`, resumed: conn.resumed, frames }),
            )
          }

          if (frame.text === "whoami")
            return yield* conn.send(
              Hello.make({ name: session.name, resumed: conn.resumed, frames }),
            )

          if (frame.text === "caller") {
            const caller = yield* CurrentCaller
            const subject = Predicate.isTagged(caller, "User") ? caller.subject : ""
            const tenant = yield* Tenant

            return yield* conn.send(
              Hello.make({
                name: `${tenant}/${caller._tag}/${subject}`,
                resumed: conn.resumed,
                frames,
              }),
            )
          }

          if (frame.text === "flood") {
            for (let index = 0; index < FLOOD; index++)
              yield* conn.send(Hello.make({ name: session.name, resumed: conn.resumed, frames }))

            return
          }

          yield* (yield* Room.get(conn.id)).Post(frame.text).pipe(Effect.orDie)
        }),
        resync: Effect.fnUntraced(function* ({ after }: { readonly after: string | undefined }) {
          const conn = yield* Room.Connection
          const session = yield* conn.session.get

          if (Option.isSome(session) && session.value.name === "quitter") return yield* conn.close

          for (const entry of yield* conn.events(Said, { after }).pipe(Effect.orDie))
            yield* conn.send(entry)
        }),
      },
    }),
  )

type LiveMessage = TestMessage<typeof Live.server.Type>

type LiveFrame = Extract<LiveMessage, { readonly _tag: "Frame" }>

const isFrame = (message: LiveMessage | undefined): message is LiveFrame =>
  Predicate.isTagged(message, "Frame")

const frameOf = (message: LiveMessage | undefined) => (isFrame(message) ? message.frame : undefined)

const cursorOf = (message: LiveMessage | undefined) =>
  isFrame(message) ? message.cursor : undefined

/** Reads the next `count` envelopes, control frames included. */
const next = (connection: TestConnection<typeof Live>, count = 1) =>
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
const endOf = (connection: TestConnection<typeof Live>) =>
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

const reasonOf = (error: ActorError | undefined) => error?.reason

const rows = Effect.fnUntraced(function* (ref: ActorRef) {
  const sql = yield* SqlClient.SqlClient

  return yield* sql<{ member: string; frame_seq: string; session: Uint8Array | null }>`
    SELECT member, frame_seq::text AS frame_seq, session FROM actor_connections
    WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`
}, Effect.orDie)

const connect = (id: string, name = "alice") =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const room = yield* Room.get(id)
    const connection = yield* test.connect(room.ref, Live, { name })

    return { test, room, connection }
  })

/** The `Echo` executor, which every cluster runner builds. */
const connectionsEffects = (fixture: ConnectionsFixture) =>
  Room.toEffectLayer(
    Effect.succeed({
      LiveEcho: ({ text }: { readonly text: string }) =>
        Effect.suspend(() => fixture.echo).pipe(Effect.as(text)),
    }),
  ) as Layer.Layer<never, never, RunnerServices>

/** Reports whether no envelope arrives within one second. */
const quiet = (connection: TestConnection<typeof Live>) =>
  connection.messages.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.timeout("1 second"),
    Effect.option,
    Effect.map(Option.isNone),
  )

/** Reads envelopes through the next `ResyncReplayed`. */
const throughReplayed = (connection: TestConnection<typeof Live>) =>
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
const untilEnd = (connection: TestConnection<typeof Live>) =>
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

const posts = (ref: ActorRef) =>
  ActorTest.use((test) => test.inspect(ref)).pipe(
    Effect.map(({ state }) => (state as { readonly posts?: number }).posts ?? 0),
  )

const EXPIRATION_SECONDS = 3

const withCluster = <A, E>(
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
          as: User.make({ subject: "alice" }),
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
const fakeHolder = Effect.fnUntraced(function* (options: {
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
const rawFrame = (to: ReadonlyArray<string>, frame: string) =>
  HolderItem.cases.Frame.make({ member: Live.tag, to, frame, stamp: true })

/** Collects a held connection's messages until it ends and returns them with how it ended. */
const heldUntilEnd = (held: HeldConnection) =>
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
const resyncFrom = (after: string | undefined) =>
  ClientMessage.cases.Resync.make({ after, reason: "OwnerLost", deadlineMs: RESYNC_DEADLINE_MS })

/** Polls `check` until it holds. */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

/** Connection cases: open, ordered frames, session storage, broadcasts, and cleanup on close. */
export const connectionsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "a connection opened after every earlier one to a resident actor closed still receives broadcasts",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-reopen")
          yield* next(connection)
          yield* room.Post("first")
          expect(frameOf((yield* next(connection))[0])).toEqual(Said.make({ text: "first" }))
          yield* connection.close

          const again = yield* test.connect(room.ref, Live, { name: "bob" })
          yield* next(again)
          yield* room.Post("second")
          expect(frameOf((yield* next(again))[0])).toEqual(Said.make({ text: "second" }))
        }),
      ),
  },
  {
    name: "connection opens, answers frames in order, stores its session, and leaves no row once closed",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-open")
          const [hello] = yield* next(connection)
          expect(frameOf(hello)).toEqual(Hello.make({ name: "alice", resumed: false, frames: 0 }))

          yield* connection.send(Say.make({ text: "whoami" }))
          yield* connection.send(Say.make({ text: "whoami" }))
          const answers = yield* next(connection, 2)
          expect(answers.map(frameOf)).toEqual([
            Hello.make({ name: "alice", resumed: false, frames: 1 }),
            Hello.make({ name: "alice", resumed: false, frames: 2 }),
          ])

          const [row] = yield* rows(room.ref)
          expect(row).toMatchObject({ member: "Live", frame_seq: "2" })
          expect(row!.session === null).toBe(false)

          yield* connection.close
          yield* rows(room.ref).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (found) => found.length === 0,
            }),
            Effect.timeout("5 seconds"),
            Effect.orDie,
          )
        }),
      ),
  },
  {
    name: "runs a frame handler in the actor's tenant as the caller stored at open",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-caller")
          yield* next(connection)

          yield* connection
            .send(Say.make({ text: "caller" }))
            .pipe(
              Effect.provideService(CurrentCaller, System.make({ source: "actor" })),
              Effect.provideService(Tenant, "elsewhere"),
            )
          const [answer] = yield* next(connection)
          expect(frameOf(answer)).toEqual(
            Hello.make({ name: `${room.ref.tenant}/User/alice`, resumed: false, frames: 1 }),
          )
        }),
      ),
  },
  {
    name: "a declared open failure rejects the connection and stores nothing",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const room = yield* Room.get("connections-banned")
          const exit = yield* test.connect(room.ref, Live, { name: "mallory" }).pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject(
            Option.some(Banned.make({ name: "mallory" })),
          )
          expect(yield* rows(room.ref)).toEqual([])
        }),
      ),
  },
  {
    name: "a parked connection survives hibernation and its next frame wakes the actor with the stored session",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-park")
          yield* next(connection)
          yield* connection.send(Say.make({ text: "whoami" }))
          yield* next(connection)

          const before = (yield* test.inspect(room.ref)).generation
          yield* test.hibernate(room.ref)
          yield* connection.send(Say.make({ text: "whoami" }))
          const [woken] = yield* next(connection)
          expect(frameOf(woken)).toEqual(Hello.make({ name: "alice", resumed: true, frames: 2 }))
          expect(BigInt((yield* test.inspect(room.ref)).generation!) > BigInt(before!)).toBe(true)
        }),
      ),
  },
  {
    name: "hibernating before the owner sends anything seals the holder, so the next frame resyncs nothing",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-park-quiet")
          yield* next(connection)

          for (let round = 0; round < 3; round++) {
            yield* test.hibernate(room.ref)
            yield* connection.send(Say.make({ text: "whoami" }))
            const [woken] = yield* next(connection)
            expect(isFrame(woken)).toBe(true)
          }
        }),
      ),
  },
  {
    name: "a turn's broadcast wakes a parked actor, flushes only after commit, and carries cursor stamps",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-broadcast")
          yield* next(connection)
          yield* test.hibernate(room.ref)

          const refused = yield* room.Post("refuse").pipe(Effect.exit)
          expect(Exit.isFailure(refused)).toBe(true)
          yield* room.Post("hello")

          const [said] = yield* next(connection)
          expect(frameOf(said)).toEqual(Said.make({ text: "hello" }))
          expect(cursorOf(said)).toBe(connection.cursor)

          yield* room.Post("again")
          const [again] = yield* next(connection)
          expect(frameOf(again)).toEqual(Said.make({ text: "again" }))
          expect(BigInt(cursorOf(again) ?? "0") > BigInt(connection.cursor)).toBe(true)
        }),
      ),
  },
  {
    name: "a denied reauthorization ends the session with access_denied and never wakes the actor",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-revoked")
          yield* next(connection)
          yield* test.hibernate(room.ref)
          const generation = (yield* test.inspect(room.ref)).generation

          fixture.allowed = false
          yield* test.advance("55 seconds")

          const ended = yield* endOf(connection).pipe(
            Effect.ensuring(Effect.sync(() => (fixture.allowed = true))),
          )

          expect(reasonOf(ended)).toMatchObject(Unauthorized.make({ code: "access_denied" }))
          expect((yield* test.inspect(room.ref)).generation).toBe(generation)
          yield* rows(room.ref).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (found) => found.length === 0,
            }),
            Effect.timeout("5 seconds"),
            Effect.orDie,
          )
        }),
      ),
  },
  {
    name: "a connection whose row its owner dropped ends with ServerClosed and resync at the holder's liveness check",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-excluded")
          yield* next(connection)
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM actor_connections WHERE tenant_id = ${room.ref.tenant}
            AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id}`.pipe(Effect.orDie)
          yield* test.advance("11 seconds")
          const closed = reasonOf(yield* endOf(connection))
          expect(Schema.is(SessionEnded)(closed)).toBe(true)
          expect(closed).toMatchObject({ cause: "ServerClosed", resync: true })
        }),
      ),
  },
  {
    name: "an owner deletes the rows of an earlier holder epoch at the same address, and its live connection still receives broadcasts",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-old-epoch")
          yield* next(connection)
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            INSERT INTO actor_connections (
              routing_key, connection_id, bucket, tenant_id, actor_type, actor_id, member,
              holder, holder_epoch, caller, session, opened_at_ms, opened_through
            )
            SELECT routing_key, 'connections-old-epoch-stale', bucket, tenant_id, actor_type,
              actor_id, member, holder, 'restarted-away', caller, NULL, opened_at_ms, 0
            FROM actor_connections WHERE connection_id = ${connection.connectionId}`.pipe(
            Effect.orDie,
          )
          expect((yield* rows(room.ref)).length).toBe(2)
          yield* test.hibernate(room.ref)

          yield* room.Post("after restart")
          const [broadcast] = yield* next(connection)
          expect(frameOf(broadcast)).toEqual(Said.make({ text: "after restart" }))

          const left = yield* sql<{ connection_id: string }>`SELECT connection_id
            FROM actor_connections WHERE tenant_id = ${room.ref.tenant}
              AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id}`.pipe(Effect.orDie)

          expect(left).toEqual([{ connection_id: connection.connectionId }])
        }),
      ),
  },
  {
    name: "a connection's commands take ids another caller never holds, and each commits once under its own caller",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-preminted")
          yield* next(connection)
          yield* Room.get("connections-preminted").pipe(
            Effect.flatMap((asBob) => asBob.Post("preminted")),
            Actor.as(User.make({ subject: "bob" })),
          )
          yield* next(connection)

          yield* connection.send(Say.make({ text: "preminted" }))
          const [broadcast] = yield* next(connection)
          expect(frameOf(broadcast)).toEqual(Said.make({ text: "preminted" }))

          const sql = yield* SqlClient.SqlClient

          const receipts = yield* sql<{ command_id: string; caller_key: string }>`
            SELECT command_id, caller_key FROM actor_receipts WHERE tenant_id = ${room.ref.tenant}
              AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id}
              AND command = 'Post'`.pipe(Effect.orDie)

          expect(receipts.length).toBe(2)
          expect(new Set(receipts.map((receipt) => receipt.command_id)).size).toBe(2)
          expect(new Set(receipts.map((receipt) => receipt.caller_key)).size).toBe(2)
          expect(yield* posts(room.ref)).toBe(2)
          expect(yield* test.receiptsFor(room.ref, "Post")).toBe(2)
        }),
      ),
  },
  {
    name: "a held connection survives the holder's liveness check whatever its routing bucket",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, connection } = yield* connect("connections-liveness")
          yield* next(connection)
          const dropped = yield* connect("connections-liveness-dropped")
          yield* next(dropped.connection)
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM actor_connections WHERE tenant_id = ${dropped.room.ref.tenant}
            AND actor_type = ${dropped.room.ref.actor} AND actor_id = ${dropped.room.ref.id}`.pipe(
            Effect.orDie,
          )
          yield* test.advance("11 seconds")
          expect(reasonOf(yield* endOf(dropped.connection))).toMatchObject({
            cause: "ServerClosed",
          })

          yield* connection.send(Say.make({ text: "whoami" }))
          const [answer] = yield* next(connection)
          expect(frameOf(answer)).toEqual(Hello.make({ name: "alice", resumed: false, frames: 1 }))
        }),
      ),
  },
  {
    name: "an open handler that closes its connection leaves it ended with ServerClosed",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-leaver", "leaver")
          const closed = reasonOf(yield* endOf(connection))
          expect(Schema.is(SessionEnded)(closed)).toBe(true)
          expect(closed).toMatchObject({ cause: "ServerClosed", resync: false })
          expect(yield* rows(room.ref)).toEqual([])
        }),
      ),
  },
  {
    name: "a frame queued after the reauthorization bound never reaches its handler",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-lapsed")
          yield* next(connection)
          yield* test.advance("61 seconds")
          yield* connection.send(Say.make({ text: "late" })).pipe(Effect.ignore)
          expect(reasonOf(yield* endOf(connection))).toMatchObject(
            Unauthorized.make({ code: "reauthorization_unavailable" }),
          )
          expect((yield* test.inspect(room.ref)).state).not.toMatchObject({ posts: 1 })
        }),
      ),
  },
  {
    name: "a session with no successful reauthorization by its bound ends with reauthorization_unavailable",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, connection } = yield* connect("connections-bound")
          yield* next(connection)
          yield* test.advance("61 seconds")
          expect(reasonOf(yield* endOf(connection))).toMatchObject(
            Unauthorized.make({ code: "reauthorization_unavailable" }),
          )
        }),
      ),
  },
  {
    name: "a connection that falls 1,024 frames behind ends with SlowConsumer and resync",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-slow")
          yield* next(connection)
          yield* connection.send(Say.make({ text: "flood" }))
          yield* rows(room.ref).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (found) => found.length === 0,
            }),
            Effect.timeout("10 seconds"),
            Effect.orDie,
          )
          const slow = reasonOf(yield* endOf(connection))
          expect(Schema.is(SessionEnded)(slow)).toBe(true)
          expect(slow).toMatchObject({ cause: "SlowConsumer", resync: true })
        }),
      ),
  },
  {
    name: "an open retried after its reply was lost resyncs from the cursor it opened at",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-recovered")
          yield* next(connection)
          yield* room.Post("later")
          yield* next(connection)

          const sql = yield* SqlClient.SqlClient

          const [row] = yield* sql<{ opened_through: string }>`
            SELECT opened_through::text AS opened_through FROM actor_connections
            WHERE connection_id = ${connection.connectionId}`.pipe(Effect.orDie)

          expect(row?.opened_through).toBe(connection.cursor)

          const owner = { generation: "1", owner: "owner", ownerEpoch: "owner-epoch" }
          const resyncs: Array<string | undefined> = []
          const windows: Array<number> = []
          const bounds: Array<number> = []
          let opens = 0
          let ticks = 0

          const type: HeldActorType = {
            deliveryMs: 1_000,
            takeoverMs: 5_000,
            reauthorizeMs: 60_000,
            retryWindowMs: 60_000,
            placement: "actor",
            hasResync: () => true,
            hasMember: () => true,
            routingKey: () => 0n,
            channel: {
              open: (request) =>
                Effect.suspend(() => {
                  windows.push(request.commands.expiresAt - request.commands.issuedAt)

                  if (++opens === 1)
                    return Effect.succeed({ _tag: "Opened" as const, ...owner, baseline: "9" })

                  if (opens === 2)
                    return Effect.fail(
                      ActorError.make({
                        reason: ActorUnavailable.make({ cause: new Error("Reply lost") }),
                      }),
                    )

                  return Effect.succeed({
                    _tag: "Opened" as const,
                    ...owner,
                    baseline: "5",
                    recovered: true,
                  })
                }),
              frame: () => Effect.die(new Error("No frame is sent")),
              close: () => Effect.void,
              resync: (request) =>
                Effect.sync(() => {
                  resyncs.push(request.after)
                  bounds.push(request.authorizedUntil)

                  return { _tag: "Replayed" as const, ...owner }
                }),
            },
          }

          const holder = yield* connectionHolder({
            transport: () => ({
              holder: "recovered-holder",
              epoch: "recovered-epoch",
              deliver: () => Effect.die(new Error("No owner delivers")),
              ping: () => Effect.succeed(true),
            }),
            actorType: () => type,
            authorize: () => Effect.succeed(true),
          }).pipe(Effect.provideService(FrameworkClock, { offsetMillis: () => ticks++ }))

          const openHeld = holder.open({
            ref: { tenant: room.ref.tenant, actor: "Recovered", id: "recovered" },
            member: Live.tag,
            caller: System.make({ source: "actor" }),
            params: "{}",
          })

          const earlier = yield* openHeld
          const held = yield* openHeld

          const replay = yield* held.messages.pipe(
            Stream.takeUntil((message) => Predicate.isTagged(message, "ResyncReplayed")),
            Stream.runCollect,
            Effect.timeout("10 seconds"),
            Effect.orDie,
          )

          expect(opens).toBe(3)
          expect(windows).toEqual([60_000, 60_000, 60_000])
          const [resync] = replay

          expect(resync?._tag).toBe("Resync")
          expect(resync?._tag === "Resync" ? resync.after : undefined).toBe("5")
          expect(resyncs).toEqual(["5"])
          expect(bounds.length === 1 && bounds[0]! > 0).toBe(true)
          yield* held.close
          yield* earlier.close
        }),
      ),
  },
  {
    name: "an authorization check that answers after the session's bound ends the session",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-late-check")
          yield* next(connection)

          const sql = yield* SqlClient.SqlClient
          const owner = { generation: "1", owner: "owner", ownerEpoch: "owner-epoch" }
          let offset = 0

          const type: HeldActorType = {
            deliveryMs: 1_000,
            takeoverMs: 5_000,
            reauthorizeMs: 1_000,
            retryWindowMs: 60_000,
            placement: "actor",
            hasResync: () => false,
            hasMember: () => true,
            routingKey: () => 0n,
            channel: {
              open: (request) =>
                sql`
                  INSERT INTO actor_connections (
                    routing_key, connection_id, bucket, tenant_id, actor_type, actor_id, member,
                    holder, holder_epoch, caller, session, opened_at_ms, opened_through
                  )
                  SELECT routing_key, ${request.connectionId}, bucket, tenant_id, actor_type, actor_id,
                    member, ${request.holder}, ${request.holderEpoch}, caller, NULL, opened_at_ms, 0
                  FROM actor_connections WHERE connection_id = ${connection.connectionId}`.pipe(
                  Effect.orDie,
                  Effect.as({ _tag: "Opened" as const, ...owner, baseline: "0" }),
                ),
              frame: () => Effect.die(new Error("No frame is sent")),
              close: () => Effect.void,
              resync: () => Effect.die(new Error("No owner is lost")),
            },
          }

          const holder = yield* connectionHolder({
            transport: () => ({
              holder: "late-holder",
              epoch: "late-epoch",
              deliver: () => Effect.die(new Error("No owner delivers")),
              ping: () => Effect.succeed(true),
            }),
            actorType: () => type,
            authorize: (request) =>
              Effect.sync(() => {
                if (request.kind === "reauthorize") offset += 700

                return true
              }),
          }).pipe(Effect.provideService(FrameworkClock, { offsetMillis: () => offset }))

          const held = yield* holder.open({
            ref: room.ref,
            member: Live.tag,
            caller: System.make({ source: "actor" }),
            params: "{}",
          })

          offset = 600

          const exit = yield* held.messages.pipe(
            Stream.runDrain,
            Effect.exit,
            Effect.timeout("10 seconds"),
            Effect.orDie,
          )

          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

          expect(Option.getOrUndefined(failure)?.reason).toMatchObject({
            code: "reauthorization_unavailable",
          })
        }),
      ),
  },
  {
    name: "an open or a renewal whose credential expires while its check runs is refused with Unauthorized expired",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-late-renewal")
          yield* next(connection)

          const sql = yield* SqlClient.SqlClient
          const owner = { generation: "1", owner: "owner", ownerEpoch: "owner-epoch" }
          let offset = 0
          let slowOpen = true

          const type: HeldActorType = {
            deliveryMs: 1_000,
            takeoverMs: 5_000,
            reauthorizeMs: 60_000,
            retryWindowMs: 60_000,
            placement: "actor",
            hasResync: () => false,
            hasMember: () => true,
            routingKey: () => 0n,
            channel: {
              open: (request) =>
                sql`
                  INSERT INTO actor_connections (
                    routing_key, connection_id, bucket, tenant_id, actor_type, actor_id, member,
                    holder, holder_epoch, caller, session, opened_at_ms, opened_through
                  )
                  SELECT routing_key, ${request.connectionId}, bucket, tenant_id, actor_type, actor_id,
                    member, ${request.holder}, ${request.holderEpoch}, caller, NULL, opened_at_ms, 0
                  FROM actor_connections WHERE connection_id = ${connection.connectionId}`.pipe(
                  Effect.orDie,
                  Effect.as({ _tag: "Opened" as const, ...owner, baseline: "0" }),
                ),
              frame: () => Effect.die(new Error("No frame is sent")),
              close: () => Effect.void,
              resync: () => Effect.die(new Error("No owner is lost")),
            },
          }

          const holder = yield* connectionHolder({
            transport: () => ({
              holder: "renewal-holder",
              epoch: "renewal-epoch",
              deliver: () => Effect.die(new Error("No owner delivers")),
              ping: () => Effect.succeed(true),
            }),
            actorType: () => type,
            authorize: (request) =>
              Effect.sync(() => {
                if (request.kind === "reauthorize" || (request.kind === "open" && slowOpen))
                  offset += 1_000

                return true
              }),
          }).pipe(Effect.provideService(FrameworkClock, { offsetMillis: () => offset }))

          const late = yield* holder
            .open({
              ref: room.ref,
              member: Live.tag,
              caller: System.make({ source: "actor" }),
              params: "{}",
              expiresAt: (yield* holder.now) + 500,
            })
            .pipe(Effect.flip)

          expect(Predicate.isTagged(late, "ActorError") ? late.reason : late).toMatchObject({
            code: "expired",
          })
          slowOpen = false

          const held = yield* holder.open({
            ref: room.ref,
            member: Live.tag,
            caller: System.make({ source: "actor" }),
            params: "{}",
          })

          const renewal = yield* held.reauthenticate((yield* holder.now) + 500).pipe(Effect.flip)
          expect(renewal.reason).toMatchObject({ code: "expired" })

          const exit = yield* held.messages.pipe(
            Stream.runDrain,
            Effect.exit,
            Effect.timeout("10 seconds"),
            Effect.orDie,
          )

          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
          expect(Option.getOrUndefined(failure)?.reason).toMatchObject({ code: "expired" })
        }),
      ),
  },
  {
    name: "a resync the new owner answers after the credential expired ends the session with Unauthorized expired",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-late-resync")
          yield* next(connection)

          const sql = yield* SqlClient.SqlClient
          const owner = { generation: "1", owner: "owner", ownerEpoch: "owner-epoch" }
          let offset = 0

          const type: HeldActorType = {
            deliveryMs: 1_000,
            takeoverMs: 5_000,
            reauthorizeMs: 60_000,
            retryWindowMs: 60_000,
            placement: "actor",
            hasResync: () => false,
            hasMember: () => true,
            routingKey: () => 0n,
            channel: {
              open: (request) =>
                sql`
                  INSERT INTO actor_connections (
                    routing_key, connection_id, bucket, tenant_id, actor_type, actor_id, member,
                    holder, holder_epoch, caller, session, opened_at_ms, opened_through
                  )
                  SELECT routing_key, ${request.connectionId}, bucket, tenant_id, actor_type, actor_id,
                    member, ${request.holder}, ${request.holderEpoch}, caller, NULL, opened_at_ms, 0
                  FROM actor_connections WHERE connection_id = ${connection.connectionId}`.pipe(
                  Effect.orDie,
                  Effect.as({ _tag: "Opened" as const, ...owner, baseline: "0" }),
                ),
              frame: () => Effect.die(new Error("No frame is sent")),
              close: () => Effect.void,
              resync: () =>
                Effect.sync(() => {
                  offset += 1_000

                  return {
                    _tag: "Closed" as const,
                    ended: SessionEnded.make({ cause: "ServerClosed", resync: false }),
                  }
                }),
            },
          }

          const holder = yield* connectionHolder({
            transport: () => ({
              holder: "resync-holder",
              epoch: "resync-epoch",
              deliver: () => Effect.die(new Error("No owner delivers")),
              ping: () => Effect.succeed(true),
            }),
            actorType: () => type,
            authorize: () => Effect.succeed(true),
          }).pipe(Effect.provideService(FrameworkClock, { offsetMillis: () => offset }))

          const held = yield* holder.open({
            ref: room.ref,
            member: Live.tag,
            caller: System.make({ source: "actor" }),
            params: "{}",
            expiresAt: (yield* holder.now) + 500,
          })

          yield* holder.deliver({
            epoch: "resync-epoch",
            owner: "other",
            ownerEpoch: "other-epoch",
            ref: room.ref,
            generation: "2",
            seq: 1,
            through: "0",
            items: [],
          })

          const exit = yield* held.messages.pipe(
            Stream.runDrain,
            Effect.exit,
            Effect.timeout("10 seconds"),
            Effect.orDie,
          )

          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
          expect(Option.getOrUndefined(failure)?.reason).toMatchObject({ code: "expired" })
        }),
      ),
  },
  {
    name: "an ungraceful owner death resyncs a held connection in place from its flushed-through cursor",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.connections,
        { runners: 2 },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready

          let ref: ActorRef | undefined

          for (let index = 0; ref === undefined && index < 200; index++) {
            const candidate = (yield* cluster.on(0)(Room.get(`connections-crash-${index}`))).ref

            if ((yield* cluster.owner(candidate)) === 1) ref = candidate
          }

          if (ref === undefined)
            return yield* Effect.die(new Error("Runner 1 owns no probed actor"))
          const target = ref

          const connection = yield* cluster.on(0)(
            ActorTest.use((test) => test.connect(target, Live, { name: "alice" })),
          )

          yield* next(connection)

          const quitter = yield* cluster.on(0)(
            ActorTest.use((test) => test.connect(target, Live, { name: "quitter" })),
          )

          yield* next(quitter)
          yield* cluster.on(0)(
            Room.get(target.id).pipe(Effect.flatMap((room) => room.Post("before"))),
          )
          yield* next(quitter)
          const [before] = yield* next(connection)
          expect(frameOf(before)).toEqual(Said.make({ text: "before" }))

          yield* cluster.kill(1)

          const [resync] = yield* next(connection)
          const lost = Predicate.isTagged(resync, "Resync") ? resync : undefined
          expect(lost?.reason).toBe("OwnerLost")
          const after = lost?.after
          expect(after === undefined).toBe(false)

          const replay = yield* connection.messages.pipe(
            Stream.takeUntil((message) => Predicate.isTagged(message, "ResyncReplayed")),
            Stream.runCollect,
            Effect.timeout("60 seconds"),
            Effect.orDie,
          )

          expect([...replay].at(-1)?._tag).toBe("ResyncReplayed")
          expect([...replay].filter(isFrame)).toEqual([])

          expect(reasonOf(yield* endOf(quitter))).toMatchObject({
            cause: "ServerClosed",
            resync: false,
          })

          yield* cluster.on(0)(
            Room.get(target.id).pipe(Effect.flatMap((room) => room.Post("during"))),
          )

          const early = yield* connection.messages.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("1 second"),
            Effect.option,
          )

          expect(Option.getOrUndefined(early)).toEqual(undefined)

          yield* connection.resyncDone
          const [during] = yield* next(connection)
          expect(frameOf(during)).toEqual(Said.make({ text: "during" }))
          yield* connection.send(Say.make({ text: "whoami" }))
          const [resumed] = yield* next(connection)
          expect(frameOf(resumed)).toEqual(Hello.make({ name: "alice", resumed: true, frames: 1 }))
          expect(yield* cluster.owner(target)).toBe(0)
        }),
      ),
  },
  {
    name: "rejects a session above 16 KiB as a defect, closes the connection, and stores nothing of it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-session-limit")
          yield* next(connection)

          const fits = MAX_SESSION_BYTES - (yield* sessionJson({ name: "", frames: 1 })).length
          yield* connection.send(Say.make({ text: `grow:${fits}` }))
          const [grown] = yield* next(connection)
          expect(frameOf(grown)).toEqual(Hello.make({ name: `${fits}`, resumed: false, frames: 1 }))

          const [stored] = yield* rows(room.ref)
          expect(stored?.frame_seq).toBe("1")

          const session = (yield* storedSession(decompress(stored!.session!))).value
          const json = yield* sessionJson(session)
          expect(new TextEncoder().encode(json).byteLength).toBe(MAX_SESSION_BYTES)

          yield* connection.send(Say.make({ text: `grow:${fits + 1}` }))
          const { seen, ended } = yield* untilEnd(connection)
          expect(seen).toEqual([])
          expect(Schema.is(SessionEnded)(ended)).toBe(true)
          expect(ended).toMatchObject({ cause: "Defect", resync: false })
          expect(yield* rows(room.ref)).toEqual([])
        }),
      ),
  },
  {
    name: "sends a broadcast committed while open runs after the open's own frames",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const room = yield* Room.get("connections-opening")
          const hold = yield* holdNext(fixture.connections)

          const opening = yield* test
            .connect(room.ref, Live, { name: "held" })
            .pipe(Effect.forkChild({ startImmediately: true }))

          yield* hold.reached
          yield* room.Post("during open")
          yield* hold.release
          const connection = yield* Fiber.join(opening)
          const opened = yield* next(connection, 2)

          expect(opened.map(frameOf)).toEqual([
            Hello.make({ name: "held", resumed: false, frames: 0 }),
            Said.make({ text: "during open" }),
          ])
        }),
      ),
  },
  {
    name: "a failed row delete keeps the connection open and still reached by broadcasts",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const { room, connection } = yield* connect("connections-undeletable")
          yield* next(connection)

          yield* sql`CREATE FUNCTION connections_keep_row() RETURNS trigger LANGUAGE plpgsql
            AS $$ BEGIN RAISE EXCEPTION 'row delete refused'; END $$`.pipe(Effect.orDie)

          yield* sql`CREATE TRIGGER connections_keep_row BEFORE DELETE ON actor_connections
            FOR EACH ROW WHEN (OLD.actor_id = 'connections-undeletable')
            EXECUTE FUNCTION connections_keep_row()`.pipe(Effect.orDie)

          yield* Effect.gen(function* () {
            yield* connection.send(Say.make({ text: "leave" }))
            yield* room.Post("still here")
            const [still] = yield* next(connection)
            expect(frameOf(still)).toEqual(Said.make({ text: "still here" }))
            expect((yield* rows(room.ref)).length).toBe(1)
          }).pipe(
            Effect.ensuring(
              Effect.all([
                sql`DROP TRIGGER connections_keep_row ON actor_connections`,
                sql`DROP FUNCTION connections_keep_row()`,
              ]).pipe(Effect.orDie),
            ),
          )
        }),
      ),
  },
  {
    name: "a connection queues at most 1,024 inbound frames and never runs the queue it dropped",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-inbound")
          yield* next(connection)
          const hold = yield* holdNext(fixture.connections)
          yield* connection.send(Say.make({ text: "hold" }))
          yield* hold.reached

          for (let index = 0; index <= 1_024; index++)
            yield* connection.send(Say.make({ text: "queued" })).pipe(Effect.ignore)

          const { ended } = yield* untilEnd(connection)
          expect(Schema.is(SessionEnded)(ended)).toBe(true)
          expect(ended).toMatchObject({ cause: "SlowConsumer", resync: true })

          yield* hold.release
          yield* Effect.sleep("500 millis")
          expect(yield* posts(room.ref)).toBe(0)
        }),
      ),
  },
  {
    name: "a revoked connection drops its unread outbound frames and its queued inbound frames",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-revoked-queue")
          yield* next(connection)

          yield* room.Post("unread")
          const hold = yield* holdNext(fixture.connections)
          yield* connection.send(Say.make({ text: "hold" }))
          yield* hold.reached
          yield* connection.send(Say.make({ text: "queued" }))

          fixture.allowed = false

          const { seen, ended } = yield* test.advance("55 seconds").pipe(
            Effect.andThen(
              eventually(
                Effect.map(rows(room.ref), (found) => found.length === 0),
                "the revoked row to go",
              ),
            ),
            Effect.andThen(untilEnd(connection)),
            Effect.ensuring(Effect.sync(() => (fixture.allowed = true))),
          )

          expect(ended).toMatchObject(Unauthorized.make({ code: "access_denied" }))
          expect(seen).toEqual([])

          yield* hold.release
          yield* Effect.sleep("500 millis")
          expect(yield* posts(room.ref)).toBe(1)
        }),
      ),
  },
  {
    name: "rejects an open for a member the actor does not declare before authorizing it",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const room = yield* Room.get("connections-undeclared")
          fixture.allowed = false

          const exit = yield* test
            .connect(room.ref, Undeclared, {})
            .pipe(Effect.exit, Effect.ensuring(Effect.sync(() => (fixture.allowed = true))))

          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
          expect(Schema.is(ActorUnavailable)(Option.getOrUndefined(failure)?.reason)).toBe(true)
          expect(yield* rows(room.ref)).toEqual([])
        }),
      ),
  },
  {
    name: "a command and a frame that wake one parked actor together acquire one generation",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, room, connection } = yield* connect("connections-together")
          yield* next(connection)
          yield* test.hibernate(room.ref)
          const parked = BigInt((yield* test.inspect(room.ref)).generation!)

          yield* Effect.all(
            [room.Post("together"), connection.send(Say.make({ text: "whoami" }))],
            { concurrency: "unbounded", discard: true },
          )

          const woken = (yield* next(connection, 2)).map(frameOf)
          const said = woken.find((frame) => Predicate.isTagged(frame, "Said"))
          const hello = woken.find((frame) => Predicate.isTagged(frame, "Hello"))
          expect(said).toEqual(Said.make({ text: "together" }))
          expect(hello).toEqual(Hello.make({ name: "alice", resumed: true, frames: 1 }))
          expect(BigInt((yield* test.inspect(room.ref)).generation!)).toBe(parked + 1n)
        }),
      ),
  },
  {
    name: "a holder whose liveness check fails for a whole reauthorization bound ends its sessions, and later opens are not blamed for it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const { test, connection } = yield* connect("connections-blind")
          yield* next(connection)

          yield* sql`ALTER TABLE actor_connections RENAME TO actor_connections_hidden`.pipe(
            Effect.orDie,
          )

          const { ended } = yield* Effect.gen(function* () {
            yield* test.advance("11 seconds")
            yield* Effect.sleep("500 millis")
            yield* test.advance("40 seconds")
            yield* Effect.sleep("500 millis")
            yield* test.advance("21 seconds")

            return yield* untilEnd(connection)
          }).pipe(
            Effect.ensuring(
              sql`ALTER TABLE actor_connections_hidden RENAME TO actor_connections`.pipe(
                Effect.orDie,
              ),
            ),
          )

          expect(Schema.is(SessionEnded)(ended)).toBe(true)
          expect(ended).toMatchObject({ cause: "ActorUnavailable", resync: true })

          const after = yield* connect("connections-sighted")
          yield* next(after.connection)
          yield* Effect.sleep("300 millis")
          yield* after.connection.send(Say.make({ text: "whoami" }))
          const [answer] = yield* next(after.connection)
          expect(frameOf(answer)).toEqual(Hello.make({ name: "alice", resumed: false, frames: 1 }))
        }),
      ),
  },
  {
    name: "a holder applies a redelivered owner message once and counts resync-deferred frames against the outbound limits",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-redelivered")
          yield* next(connection)
          let alive = true

          const fake = yield* fakeHolder({
            name: "redelivered",
            template: connection.connectionId,
            alive: () => alive,
            type: { takeoverMs: 60_000 },
          })

          const frames = yield* fake.open(room.ref)
          const bytes = yield* fake.open(room.ref)
          const once = fake.message(room.ref, "1", 1, [rawFrame([frames.connectionId], "once")])
          yield* fake.holder.deliver(once)
          expect(yield* fake.holder.deliver(once)).toEqual({ wrongEpoch: false, unknown: [] })

          yield* fake.holder.deliver(
            fake.message(room.ref, "1", 2, [rawFrame([frames.connectionId], "twice")]),
          )

          const delivered = yield* frames.messages.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.timeout("5 seconds"),
            Effect.orDie,
          )

          expect(
            [...delivered].map((message) =>
              ClientMessage.guards.Frame(message) ? message.frame : undefined,
            ),
          ).toEqual(["once", "twice"])

          alive = false

          for (const held of [frames, bytes]) {
            const [resync] = yield* held.messages.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.timeout("10 seconds"),
              Effect.orDie,
            )

            expect(resync?._tag).toBe("Resync")
          }

          const half = "x".repeat(MAX_OUTBOUND_BYTES / 2 + 1)

          yield* fake.holder.deliver(
            fake.message(room.ref, "2", 1, [
              ...Array.from({ length: MAX_OUTBOUND_FRAMES + 1 }, (_, index) =>
                rawFrame([frames.connectionId], `deferred ${index}`),
              ),
              rawFrame([bytes.connectionId], half),
              rawFrame([bytes.connectionId], half),
            ]),
          )

          for (const held of [frames, bytes]) {
            const { seen, ended } = yield* heldUntilEnd(held)
            expect(seen).toEqual([])
            expect(ended).toMatchObject({ cause: "SlowConsumer", resync: true })
          }
        }),
      ),
  },
  {
    name: "a holder never delivers a broadcast that arrives past the session's authorization bound",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-late-broadcast")
          yield* next(connection)
          let offset = 0

          const fake = yield* fakeHolder({
            name: "late-broadcast",
            template: connection.connectionId,
            offset: () => offset,
          })

          const held = yield* fake.open(room.ref)
          offset = 60_001
          yield* fake.holder.deliver(
            fake.message(room.ref, "1", 1, [rawFrame([held.connectionId], "late")]),
          )
          const { seen, ended } = yield* heldUntilEnd(held)
          expect(seen).toEqual([])
          expect(ended).toMatchObject(Unauthorized.make({ code: "reauthorization_unavailable" }))
        }),
      ),
  },
  {
    name: "a holder closes a connection again when its owner commits the open after the holder gave up",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-late-open")
          yield* next(connection)
          const closes: Array<SessionEnded> = []

          const fake = yield* fakeHolder({
            name: "late-open",
            template: connection.connectionId,
            type: { deliveryMs: 200 },
            channel: (copyRow) => ({
              open: (request) => copyRow(request).pipe(Effect.delay("600 millis")),
              close: (request) => Effect.sync(() => closes.push(request.cause)),
            }),
          })

          const exit = yield* fake.open(room.ref).pipe(Effect.exit)
          const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

          const reason = Option.filter(failure, Schema.is(ActorError)).pipe(
            Option.map((error) => error.reason),
            Option.getOrUndefined,
          )

          expect(reason).toMatchObject({ cause: "ActorUnavailable", resync: true })

          yield* eventually(
            Effect.sync(() => closes.length > 0),
            "the late open to be closed",
          )

          expect(closes).toMatchObject([{ cause: "ActorUnavailable", resync: true }])
        }),
      ),
  },
  {
    name: "a resync whose new owner never answers within the takeover bound closes with OwnerLost",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { room, connection } = yield* connect("connections-unanswered")
          yield* next(connection)
          const requests: Array<string | undefined> = []

          const fake = yield* fakeHolder({
            name: "unanswered",
            template: connection.connectionId,
            type: { takeoverMs: 300 },
            channel: (copyRow) => ({
              open: (request) =>
                copyRow(request).pipe(
                  Effect.map((opened) => ({ ...opened, baseline: "4", recovered: true })),
                ),
              resync: (request) =>
                Effect.sync(() => requests.push(request.after)).pipe(Effect.andThen(Effect.never)),
            }),
          })

          const held = yield* fake.open(room.ref)
          const { seen, ended } = yield* heldUntilEnd(held)
          expect(seen).toMatchObject([resyncFrom("4")])
          expect(requests).toEqual(["4"])
          expect(ended).toMatchObject({ cause: "OwnerLost", resync: true })
        }),
      ),
  },
  {
    name: "sends a server frame shaped like an event entry as the frame itself when its event is no server frame",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { connection } = yield* connect("connections-receipted")
          yield* next(connection)
          yield* connection.send(Say.make({ text: "receipted" }))
          const [sent] = yield* next(connection)
          expect(frameOf(sent)).toEqual(receipted)
          expect(isFrame(sent) ? sent.event : "stamped").toBe(undefined)
        }),
      ),
  },
  {
    name: "a failed generation acquisition caches nothing, so the retried frame acquires once and resumes the session",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const { test, room, connection } = yield* connect("connections-unacquired")
          yield* next(connection)
          yield* test.hibernate(room.ref)
          const parked = BigInt((yield* test.inspect(room.ref)).generation!)

          yield* sql`CREATE FUNCTION connections_refuse_generation() RETURNS trigger LANGUAGE plpgsql
            AS $$ BEGIN RAISE EXCEPTION 'generation refused'; END $$`.pipe(Effect.orDie)

          yield* sql`CREATE TRIGGER connections_refuse_generation BEFORE UPDATE ON actor_generations
            FOR EACH ROW WHEN (OLD.actor_id = 'connections-unacquired')
            EXECUTE FUNCTION connections_refuse_generation()`.pipe(Effect.orDie)

          const dropped = Effect.all([
            sql`DROP TRIGGER IF EXISTS connections_refuse_generation ON actor_generations`,
            sql`DROP FUNCTION IF EXISTS connections_refuse_generation()`,
          ]).pipe(Effect.orDie)

          yield* Effect.gen(function* () {
            yield* connection.send(Say.make({ text: "whoami" }))
            yield* Effect.sleep("300 millis")
            yield* dropped
            const [woken] = yield* next(connection)
            expect(frameOf(woken)).toEqual(Hello.make({ name: "alice", resumed: true, frames: 1 }))
          }).pipe(Effect.ensuring(dropped))

          expect(BigInt((yield* test.inspect(room.ref)).generation!)).toBe(parked + 1n)
        }),
      ),
  },
  {
    name: "a session write that races a takeover waits for it, writes nothing, and the redelivered frame applies once",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const { room, connection } = yield* connect("connections-takeover")
          yield* next(connection)
          const hold = yield* holdNext(fixture.connections)
          yield* connection.send(Say.make({ text: "hold" }))
          yield* hold.reached

          const takeover = yield* environment.connect!
          yield* takeover.query("BEGIN")

          const bumped = (yield* takeover.query(
            `UPDATE actor_generations SET generation = generation + 1
             WHERE tenant_id = $1 AND actor_type = $2 AND actor_id = $3
             RETURNING generation::text AS generation`,
            [room.ref.tenant, room.ref.actor, room.ref.id],
          )) as ReadonlyArray<{ readonly generation: string }>

          yield* hold.release

          yield* eventually(
            Effect.map(
              sql<{
                waiting: number
              }>`SELECT count(*)::int AS waiting FROM pg_locks
                JOIN pg_stat_activity USING (pid)
                WHERE NOT granted AND datname = current_database()`,
              ([row]) => row!.waiting > 0,
            ).pipe(Effect.orDie),
            "the session write to wait on the takeover",
          )

          yield* takeover.query("COMMIT")

          const replay = yield* throughReplayed(connection)
          expect(replay.map((message) => message._tag)).toEqual(["Resync", "ResyncReplayed"])
          expect(replay[0]).toMatchObject({
            after: connection.cursor === "0" ? undefined : connection.cursor,
          })
          yield* connection.resyncDone
          const [answer] = yield* next(connection)
          const hello = frameOf(answer)

          expect(
            Predicate.isTagged(hello, "Hello") ? { name: hello.name, frames: hello.frames } : hello,
          ).toEqual({ name: "alice", frames: 1 })
          expect(yield* quiet(connection)).toBe(true)
          const [row] = yield* rows(room.ref)
          expect(row?.frame_seq).toBe("1")

          const test = yield* ActorTest

          expect(BigInt((yield* test.inspect(room.ref)).generation!)).toBe(
            BigInt(bumped[0]!.generation) + 1n,
          )
        }),
      ),
  },
  {
    name: "an owner deletes a dead holder's connection rows at its next delivery, and its turns still commit",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.connections,
        { runners: 2, holdersOnly: [0] },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const id = "connections-dead-holder"
          const ref = (yield* cluster.on(0)(Room.get(id))).ref

          const connection = yield* cluster.on(0)(
            ActorTest.use((test) => test.connect(ref, Live, { name: "alice" })),
          )

          yield* next(connection)

          const rows = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            return (yield* sql<{ count: number }>`SELECT count(*)::int AS count
              FROM actor_connections WHERE tenant_id = ${ref.tenant} AND actor_id = ${ref.id}`)[0]!
              .count
          }).pipe(Effect.orDie)

          expect(yield* cluster.on(1)(rows)).toBe(1)
          yield* cluster.kill(0)

          yield* cluster.on(1)(Room.get(id).pipe(Effect.flatMap((room) => room.Post("after"))))

          yield* cluster
            .on(1)(rows)
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("50 millis"),
                until: (count) => count === 0,
              }),
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => Effect.die(new Error("The dead holder's row was never deleted")),
              }),
            )
          expect(yield* cluster.on(1)(posts(ref))).toBe(1)
        }),
      ),
  },
  {
    name: "an intent, a timer, and an effect route each wake a parked actor on another runner, and its broadcast reaches the held connection",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.connections,
        { runners: 3, holdersOnly: [0] },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const holder = cluster.on(0)
          const id = "connections-woken"
          const ref = (yield* holder(Room.get(id))).ref

          const connection = yield* holder(
            ActorTest.use((test) => test.connect(ref, Live, { name: "alice" })),
          )

          yield* next(connection)
          const generation = holder(ActorTest.use((test) => test.inspect(ref)))

          const park = Effect.gen(function* () {
            const owner = yield* cluster.owner(ref)
            expect(owner === undefined || owner === 0).toBe(false)
            yield* cluster.on(owner!)(ActorTest.use((test) => test.hibernate(ref)))

            return BigInt((yield* generation).generation!)
          })

          const woken = Effect.fnUntraced(function* (text: string, parked: bigint) {
            const [broadcast] = yield* next(connection)
            expect(frameOf(broadcast)).toEqual(Said.make({ text }))
            expect(BigInt((yield* generation).generation!) > parked).toBe(true)
          })

          let parked = yield* park

          yield* holder(
            Room.get("connections-dispatcher").pipe(
              Effect.flatMap((dispatcher) => dispatcher.Forward({ to: id, text: "by intent" })),
            ),
          )

          yield* woken("by intent", parked)

          yield* holder(
            Room.get(id).pipe(
              Effect.flatMap((room) => room.Forward({ text: "by timer", afterMs: 30_000 })),
            ),
          )

          parked = yield* park
          expect(yield* quiet(connection)).toBe(true)
          yield* holder(ActorTest.use((test) => test.advance("31 seconds")))
          yield* woken("by timer", parked)

          const executed = yield* Deferred.make<void>()
          fixture.connections.echo = Deferred.await(executed)

          yield* holder(Room.get(id).pipe(Effect.flatMap((room) => room.Shout("by effect route"))))

          parked = yield* park
          yield* Deferred.succeed(executed, undefined)
          yield* woken("by effect route", parked).pipe(
            Effect.ensuring(Effect.sync(() => (fixture.connections.echo = Effect.void))),
          )
        }),
      ),
  },
  {
    name: "an owner killed between a turn's commit and its broadcast flush resyncs from the open's cursor, and the resync handler delivers the lost event",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.connections,
        { runners: 3, holdersOnly: [0] },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const holder = cluster.on(0)
          const id = "connections-unflushed"

          const post = (text: string) =>
            holder(Room.get(id).pipe(Effect.flatMap((room) => room.Post(text))))

          yield* post("earlier")
          const ref = (yield* holder(Room.get(id))).ref

          const connection = yield* holder(
            ActorTest.use((test) => test.connect(ref, Live, { name: "alice" })),
          )

          yield* next(connection)
          expect(BigInt(connection.cursor) > 0n).toBe(true)

          const owner = (yield* cluster.owner(ref))!

          const paused = yield* cluster.on(owner)(
            ActorTest.use((test) => test.pauseNext("beforeFlush")),
          )

          yield* post("lost").pipe(Effect.ignore, Effect.forkChild({ startImmediately: true }))
          yield* paused.reached
          yield* cluster.kill(owner)

          const [resync] = yield* next(connection)
          expect(resync).toMatchObject(resyncFrom(connection.cursor))

          yield* connection.resyncDone

          const replay = yield* throughReplayed(connection)
          const replayed = replay.filter(isFrame)
          expect(replayed.map(frameOf)).toEqual([Said.make({ text: "lost" })])
          expect(BigInt(replayed[0]!.event!) > BigInt(connection.cursor)).toBe(true)

          yield* holder(ActorTest.use((test) => test.advance("27 seconds")))
          expect(yield* quiet(connection)).toBe(true)
          yield* holder(ActorTest.use((test) => test.advance("4 seconds")))
          const { ended } = yield* untilEnd(connection)
          expect(Schema.is(SessionEnded)(ended)).toBe(true)
          expect(ended).toMatchObject({ cause: "OwnerLost", resync: true })
        }),
      ),
  },
  {
    name: "a third owner loss within five minutes closes with OwnerLost and a retry hint, and a loss during a replay from the beginning keeps that cursor",
    requiresIndependentConnections: true,
    timeoutMs: 180_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.connections,
        { runners: 4, holdersOnly: [0] },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const holder = cluster.on(0)
          const id = "connections-crashloop"
          const ref = (yield* holder(Room.get(id))).ref

          const connection = yield* holder(
            ActorTest.use((test) => test.connect(ref, Live, { name: "alice" })),
          )

          yield* next(connection)
          expect(connection.cursor).toBe("0")

          const killOwner = Effect.gen(function* () {
            const owner = yield* cluster.owner(ref)
            expect(owner === undefined || owner === 0).toBe(false)
            yield* cluster.kill(owner!)
            yield* cluster.ready
          })

          yield* killOwner
          const first = yield* throughReplayed(connection)
          expect(first[0]).toMatchObject(resyncFrom(undefined))
          expect(first.filter(isFrame)).toEqual([])

          yield* holder(Room.get(id).pipe(Effect.flatMap((room) => room.Post("between"))))
          yield* killOwner
          const second = yield* throughReplayed(connection)
          expect(second[0]).toMatchObject(resyncFrom(undefined))
          expect(second.filter(isFrame).map(frameOf)).toEqual([Said.make({ text: "between" })])

          yield* killOwner
          const { seen, ended } = yield* untilEnd(connection)
          expect(seen.filter((message) => Predicate.isTagged(message, "Resync"))).toEqual([])
          expect(Schema.is(SessionEnded)(ended)).toBe(true)
          expect(ended).toMatchObject({ cause: "OwnerLost", resync: true })
          const retryAfterMs = (ended as SessionEnded).retryAfterMs ?? 0
          expect(retryAfterMs >= 1_000 && retryAfterMs <= 5_000).toBe(true)
        }),
      ),
  },
  {
    name: "an owner does not run a frame that reaches it past the session's authorization bound",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.connections,
        { runners: 2, holdersOnly: [0] },
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const holder = cluster.on(0)
          const ref = (yield* holder(Room.get("connections-owner-clock"))).ref

          const connection = yield* holder(
            ActorTest.use((test) => test.connect(ref, Live, { name: "alice" })),
          )

          yield* next(connection)

          yield* cluster.on(1)(ActorTest.use((test) => test.advance("61 seconds")))
          yield* connection.send(Say.make({ text: "stale" }))
          const { seen, ended } = yield* untilEnd(connection)
          expect(seen).toEqual([])
          expect(ended).toMatchObject({ cause: "ServerClosed", resync: false })
          expect(yield* holder(posts(ref))).toBe(0)
        }),
      ),
  },
]
