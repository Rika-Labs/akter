import { Cause, Effect, Exit, Layer, Option, Predicate, Schedule, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, User } from "../../index.ts"
import { type ActorError, SessionEnded, Unauthorized } from "../../errors/actor.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { ActorTest, type TestConnection, type TestMessage } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

class Said extends Actor.Event<Said>()("Said", { text: Schema.String }) {}

class Hello extends Schema.TaggedClass<Hello>()("Hello", {
  name: Schema.String,
  resumed: Schema.Boolean,
  frames: Schema.Finite,
}) {}

class Say extends Schema.TaggedClass<Say>()("Say", { text: Schema.String }) {}

class Banned extends Schema.TaggedError<Banned>()("Banned", { name: Schema.String }) {}

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Live = Actor.connection("Live", {
  params: Schema.Struct({ name: Schema.String }),
  server: Schema.Union([Said, Hello]),
  client: Say,
  session: Schema.Struct({ name: Schema.String, frames: Schema.Finite }),
  errors: [Banned],
})

const Post = Actor.command("Post", { input: Schema.String, errors: [Refused] })

const Room = Actor.make("LiveRoom", {
  key: Schema.String,
  state: Actor.state({ posts: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Said],
  api: { Live, Post },
})

/** Frames a `flood` sends in one handler, past the 1,024-frame outbound limit. */
const FLOOD = 1_100

export const connectionsLayer = Room.toLayer(
  Effect.succeed({
    Post: Effect.fnUntraced(function* (text: string) {
      const turn = yield* Room.Turn
      yield* turn.emit(Said.make({ text }))
      yield* turn.broadcast(Live, Said.make({ text }))

      if (text === "refuse") return yield* Refused.make({})

      yield* turn.state.set({ posts: turn.state.posts + 1 })
    }),
    Live: {
      open: Effect.fnUntraced(function* ({ name }: { readonly name: string }) {
        const conn = yield* Room.Connection

        if (name === "mallory") return yield* Banned.make({ name })

        if (name === "leaver") return yield* conn.close

        yield* conn.session.set({ name, frames: 0 })
        yield* conn.send(Hello.make({ name, resumed: conn.resumed, frames: 0 }))
      }),
      frame: Effect.fnUntraced(function* (frame: Say) {
        const conn = yield* Room.Connection
        const session = Option.getOrElse(yield* conn.session.get, () => ({ name: "", frames: 0 }))
        const frames = session.frames + 1
        yield* conn.session.set({ frames })

        if (frame.text === "whoami")
          return yield* conn.send(Hello.make({ name: session.name, resumed: conn.resumed, frames }))

        if (frame.text === "flood") {
          for (let index = 0; index < FLOOD; index++)
            yield* conn.send(Hello.make({ name: session.name, resumed: conn.resumed, frames }))

          return
        }

        yield* (yield* Room.get(conn.id)).Post(frame.text).pipe(Effect.orDie)
      }),
      resync: Effect.fnUntraced(function* ({ after }: { readonly after: string | undefined }) {
        const conn = yield* Room.Connection

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

const EXPIRATION_SECONDS = 3

const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners: 2,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: connectionsLayer,
          as: User.make({ subject: "alice" }),
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

export const connectionsConformance: ReadonlyArray<ConformanceCase> = [
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
          // The second turn's frame carries the watermark the first turn's flush advanced.
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
          // The client reads nothing until its session has ended and its row is gone.
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
    name: "an ungraceful owner death resyncs a held connection in place from its flushed-through cursor",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      withCluster(
        environment,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready

          // The holder is runner 0; find an actor that runner 1 owns.
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
          yield* cluster.on(0)(
            Room.get(target.id).pipe(Effect.flatMap((room) => room.Post("before"))),
          )
          const [before] = yield* next(connection)
          expect(frameOf(before)).toEqual(Said.make({ text: "before" }))

          yield* cluster.kill(1)

          const [resync] = yield* next(connection)
          const lost = Predicate.isTagged(resync, "Resync") ? resync : undefined
          expect(lost?.reason).toBe("OwnerLost")
          const after = lost?.after
          expect(after === undefined).toBe(false)

          // The new owner replays events after the cursor, then the holder reports the replay done.
          const replay = yield* connection.messages.pipe(
            Stream.takeUntil((message) => Predicate.isTagged(message, "ResyncReplayed")),
            Stream.runCollect,
            Effect.timeout("60 seconds"),
            Effect.orDie,
          )

          expect([...replay].at(-1)?._tag).toBe("ResyncReplayed")
          expect([...replay].filter(isFrame)).toEqual([])

          yield* connection.resyncDone
          yield* connection.send(Say.make({ text: "whoami" }))
          const [resumed] = yield* next(connection)
          expect(frameOf(resumed)).toEqual(Hello.make({ name: "alice", resumed: true, frames: 1 }))
          expect(yield* cluster.owner(target)).toBe(0)
        }),
      ),
  },
]
