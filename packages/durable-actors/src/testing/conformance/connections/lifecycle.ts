import { Cause, Effect, Exit, Option, Schedule } from "effect"
import { CurrentCaller, System, Tenant } from "../../../identity/caller.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Banned, Hello, Live, Room, Said, Say, type ConnectionsFixture } from "./actors.ts"
import { connect, cursorOf, frameOf, isFrame, next, rows } from "./harness.ts"

/** Opening, ordered frames, stored sessions, parking, and broadcasts of connections. */
export const connectionLifecycleConformance: ReadonlyArray<ConformanceCase<ConnectionsFixture>> = [
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
]
