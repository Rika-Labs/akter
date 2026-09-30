import { Deferred, Effect, Predicate, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SessionEnded } from "../../../errors/actor.ts"
import { ActorTest } from "../../actor-test.ts"
import { ActorCluster } from "../../cluster.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Hello, Live, Room, Said, Say, holdNext } from "./actors.ts"
import {
  connect,
  eventually,
  frameOf,
  isFrame,
  next,
  posts,
  quiet,
  resyncFrom,
  rows,
  throughReplayed,
  untilEnd,
  withCluster,
} from "./harness.ts"

/** Ownership takeover, cross-runner wakes, and owner loss of held connections. */
export const connectionTakeoverConformance: ReadonlyArray<ConformanceCase> = [
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
