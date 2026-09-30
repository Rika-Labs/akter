import { Cause, Effect, Exit, Option, Predicate, Schedule, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, ActorUnavailable, SessionEnded } from "../../../errors/actor.ts"
import { type ActorRef, System } from "../../../identity/caller.ts"
import { connectionHolder, type HeldActorType } from "../../../runtime/connections/holder.ts"
import { FrameworkClock } from "../../../runtime/turn/admission.ts"
import { ActorTest } from "../../actor-test.ts"
import { ActorCluster } from "../../cluster.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Hello, Live, Room, Said, Say, type ConnectionsFixture } from "./actors.ts"
import { connect, endOf, frameOf, isFrame, next, reasonOf, rows, withCluster } from "./harness.ts"

/** Slow consumers, resync after lost replies or owners, and credential expiry during checks. */
export const connectionResyncConformance: ReadonlyArray<ConformanceCase<ConnectionsFixture>> = [
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
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture,
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
]
