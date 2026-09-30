import { Effect, Layer, Option, Predicate } from "effect"
import { User } from "../../../index.ts"
import { InternalActors } from "../../../runtime/actors.ts"
import type { ActorRef } from "../../../identity/caller.ts"
import { SUBPROTOCOL } from "../../../serve/frames.ts"
import { ActorTest } from "../../actor-test.ts"
import { ActorCluster } from "../../cluster.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Banned, ForgedResync, Hello, Said, SocketRoom, transportsLayer } from "./actors.ts"
import {
  decodeBanned,
  encodeForged,
  endReason,
  frameOf,
  headerSocket,
  opened,
  say,
  serveSockets,
  socket,
  upgradeStatus,
} from "./wire.ts"
import { greet, rows, setup } from "./harness.ts"

/** WebSocket handshake, framing, limits, reauthentication, parking, and resync. */
export const transportWebSocketConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "serves a connection over WebSocket: hello, open at its baseline, then member frames both ways with event cursors",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-open")
          yield* room.Post("before")
          const ws = yield* socket(host, "ws-open")
          yield* ws.send({ t: "hello", authorization: token(), params: { name: "alice" } })

          const open = yield* opened(yield* ws.next())
          expect(open.baseline).toBe("1")
          expect(open.reauthenticateBy).toBe(undefined)

          const greeting = yield* ws.next()
          expect(yield* frameOf(greeting)).toEqual(Hello.make({ name: "alice", resumed: false }))
          expect(greeting).toMatchObject({ cursor: "1" })

          yield* ws.send(yield* say("hi"))
          const hi = yield* ws.next()
          expect(yield* frameOf(hi)).toEqual(Said.make({ text: "hi" }))
          expect(hi).toMatchObject({ cursor: "1" })
          expect(Predicate.hasProperty(hi, "event")).toBe(false)

          yield* room.Post("live")
          const live = yield* ws.next()
          expect(yield* frameOf(live)).toEqual(Said.make({ text: "live" }))
          expect(live).toMatchObject({ cursor: "2" })

          yield* ws.send(yield* say("history"))
          const history = [yield* ws.next(), yield* ws.next(), yield* ws.next()]

          expect(
            history.map((message) => (message.t === "frame" ? message.event : undefined)),
          ).toEqual(["1", "2", "3"])
          expect((yield* rows(room.ref)).connections).toBe(1)

          yield* ws.close
          expect((yield* ws.closed).code).toBe(1000)

          yield* Effect.gen(function* () {
            while ((yield* rows(room.ref)).connections > 0) yield* Effect.sleep("20 millis")
          }).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        }),
      ),
  },
  {
    name: "wakes nothing before hello authenticates, and ends with InvalidInput when hello does not arrive in 10 seconds",
    timeoutMs: 40_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host } = yield* setup(environment)
          const ref = (yield* SocketRoom.get("ws-silent")).ref
          const ws = yield* socket(host, "ws-silent")

          yield* Effect.sleep("500 millis")
          expect(yield* rows(ref)).toEqual({ connections: 0, generations: 0 })

          const early = yield* socket(host, "ws-silent")
          yield* early.send(yield* say("hi"))
          expect(yield* endReason(yield* early.next())).toMatchObject({
            tag: "InvalidInput",
            code: "decode",
          })
          expect((yield* early.closed).code).toBe(4400)

          expect(yield* endReason((yield* ws.until("end", 15_000)).at(-1))).toMatchObject({
            tag: "InvalidInput",
            code: "decode",
          })
          expect((yield* ws.closed).code).toBe(4400)
          expect(yield* rows(ref)).toEqual({ connections: 0, generations: 0 })
        }),
      ),
  },
  {
    name: "refuses upgrades from origins not listed, without the subprotocol, and past 1,000 sockets awaiting hello",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host } = yield* setup(environment, { origins: ["https://chat.example.com"] })
          const protocol = { "Sec-WebSocket-Protocol": SUBPROTOCOL }

          expect(
            yield* upgradeStatus(host, "ws-refused", {
              ...protocol,
              Origin: "https://evil.example",
            }),
          ).toBe(403)
          expect(
            yield* upgradeStatus(host, "ws-refused", {
              ...protocol,
              Origin: "https://chat.example.com",
            }),
          ).toBe(101)
          expect(yield* upgradeStatus(host, "ws-refused", {})).toBe(400)
          expect(
            yield* upgradeStatus(host, "ws-refused", {
              "Sec-WebSocket-Protocol": `chat, ${SUBPROTOCOL}`,
            }),
          ).toBe(400)
          expect(
            yield* upgradeStatus(host, "ws-refused", { ...protocol, Authorization: "Bearer nope" }),
          ).toBe(401)

          const silent = yield* Effect.forEach(
            Array.from({ length: 1_000 }, (_, index) => index),
            () => socket(host, "ws-crowd"),
            { concurrency: 50 },
          )

          expect(silent.length).toBe(1_000)
          expect(yield* upgradeStatus(host, "ws-crowd", protocol)).toBe(503)
          yield* Effect.forEach(silent, (ws) => ws.close, { discard: true })

          yield* Effect.gen(function* () {
            while ((yield* upgradeStatus(host, "ws-crowd", protocol)) !== 101)
              yield* Effect.sleep("50 millis")
          }).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        }),
      ),
  },
  {
    name: "authenticates hello or the upgrade, and ends a session whose upgrade and hello credentials name different callers",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)

          const missing = yield* socket(host, "ws-auth")
          yield* missing.send({ t: "hello", params: { name: "alice" } })
          expect(yield* endReason(yield* missing.next())).toMatchObject({
            tag: "Unauthorized",
            code: "missing_credentials",
          })
          expect((yield* missing.closed).code).toBe(1008)

          const upgraded = yield* headerSocket(host, "ws-auth", token("bob"))
          expect(upgraded.status).toBe(101)
          yield* upgraded.send({ t: "hello", params: { name: "bob" } })
          expect((yield* upgraded.next).t).toBe("open")
          expect(yield* frameOf(yield* upgraded.next)).toEqual(
            Hello.make({ name: "bob", resumed: false }),
          )

          const mixed = yield* headerSocket(host, "ws-auth", token("bob"))
          yield* mixed.send({
            t: "hello",
            authorization: token("carol"),
            params: { name: "carol" },
          })
          expect(yield* endReason(yield* mixed.next)).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
          expect((yield* mixed.closed).code).toBe(1008)

          const expired = yield* socket(host, "ws-auth")
          yield* expired.send({
            t: "hello",
            authorization: "Bearer expired",
            params: { name: "x" },
          })
          expect(yield* endReason(yield* expired.next())).toMatchObject({
            tag: "Unauthorized",
            code: "expired",
          })

          const bad = yield* socket(host, "ws-auth")
          yield* bad.send({ t: "hello", authorization: token(), params: { nom: "x" } })
          expect(yield* endReason(yield* bad.next())).toMatchObject({
            tag: "InvalidInput",
            code: "decode",
          })
          expect((yield* bad.closed).code).toBe(4400)

          const banned = yield* socket(host, "ws-auth")
          yield* banned.send({ t: "hello", authorization: token(), params: { name: "mallory" } })
          const refused = yield* banned.next()

          expect(
            refused.t === "end" ? yield* decodeBanned(refused.error).pipe(Effect.orDie) : refused,
          ).toEqual(Banned.make({ name: "mallory" }))
          expect((yield* banned.closed).code).toBe(4400)
        }),
      ),
  },
  {
    name: "keeps control messages in their own envelope: an unknown client t ends the session, and a member frame shaped like a control message is decoded as a member frame",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)

          const forged = yield* socket(host, "ws-envelope")
          yield* greet(forged, token())
          yield* forged.send({ t: "resyncDone", through: "99" })
          yield* forged.send(yield* say("whoami"))
          expect(yield* frameOf(yield* forged.next())).toEqual(
            Hello.make({ name: "alice", resumed: false }),
          )

          const resync = yield* encodeForged(ForgedResync.make({ after: "0" })).pipe(Effect.orDie)
          yield* forged.send({ t: "frame", frame: resync })
          expect(yield* endReason(yield* forged.next())).toMatchObject({
            tag: "InvalidInput",
            code: "decode",
          })
          expect((yield* forged.closed).code).toBe(4400)

          const unknown = yield* socket(host, "ws-envelope")
          yield* greet(unknown, token())
          yield* unknown.sendRaw(`{"t":"command","member":"Post","input":"x"}`)
          expect(yield* endReason(yield* unknown.next())).toMatchObject({ tag: "InvalidInput" })
          expect((yield* unknown.closed).code).toBe(4400)

          const again = yield* socket(host, "ws-envelope")
          yield* greet(again, token())
          yield* again.send({ t: "hello", authorization: token(), params: { name: "alice" } })
          expect(yield* endReason(yield* again.next())).toMatchObject({ tag: "InvalidInput" })
        }),
      ),
  },
  {
    name: "ends a session with SessionEnded Defect and close 1009 on a frame over 64 KiB, and closes a binary message with 1003",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)

          const large = yield* socket(host, "ws-bounds")
          yield* greet(large, token())
          yield* large.send(yield* say("x".repeat(65_536)))
          expect(yield* endReason(yield* large.next())).toMatchObject({
            tag: "SessionEnded",
            cause: "Defect",
          })
          expect((yield* large.closed).code).toBe(1009)

          const binary = yield* socket(host, "ws-bounds")
          yield* greet(binary, token())
          yield* binary.sendRaw(new Uint8Array([1, 2, 3]))
          expect(yield* endReason(yield* binary.next())).toMatchObject({ tag: "InvalidInput" })
          expect((yield* binary.closed).code).toBe(1003)
        }),
      ),
  },
  {
    name: "reauthenticates a session before its credential expires, ends it with Unauthorized expired when the client doesn't answer, and ends a renewal for a different caller",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host } = yield* setup(environment)
          const holder = (yield* InternalActors).holder

          const expiring = (subject: string, ms: number) =>
            Effect.map(holder.now, (now) => `Bearer ${test.tenant}:${subject}:${now + ms}`)

          const renewing = yield* socket(host, "ws-renew")
          const open = yield* greet(renewing, yield* expiring("alice", 3_000))
          expect(open.reauthenticateBy === undefined).toBe(false)
          expect((yield* renewing.until("reauthenticate", 5_000)).at(-1)).toMatchObject({
            by: open.reauthenticateBy,
          })

          const fresh = (yield* holder.now) + 120_000
          yield* renewing.send({
            t: "reauthenticate",
            authorization: `Bearer ${test.tenant}:alice:${fresh}`,
          })
          expect(yield* renewing.next()).toEqual({ t: "reauthenticated", by: fresh })

          yield* Effect.sleep("2 seconds")
          yield* renewing.send(yield* say("whoami"))
          expect(yield* frameOf(yield* renewing.next())).toEqual(
            Hello.make({ name: "alice", resumed: false }),
          )

          const silent = yield* socket(host, "ws-renew")
          yield* greet(silent, yield* expiring("alice", 2_000))
          expect(yield* endReason((yield* silent.until("end", 10_000)).at(-1))).toMatchObject({
            tag: "Unauthorized",
            code: "expired",
          })
          expect((yield* silent.closed).code).toBe(1008)

          const swapped = yield* socket(host, "ws-renew")
          yield* greet(swapped, yield* expiring("alice", 60_000))
          yield* swapped.send({
            t: "reauthenticate",
            authorization: `Bearer ${test.tenant}:mallory`,
          })
          expect(yield* endReason((yield* swapped.until("end")).at(-1))).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
        }),
      ),
  },
  {
    name: "revokes a live and a parked WebSocket session within reauthorizeEvery",
    timeoutMs: 40_000,
    run: ({ expect, environment, access }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-revoke")
          const live = yield* socket(host, "ws-revoke")
          yield* greet(live, token())
          const parked = yield* socket(host, "ws-revoke")
          yield* greet(parked, token("bob"), "bob")
          yield* test.hibernate(room.ref)

          access.denied.add("Chat")

          yield* Effect.gen(function* () {
            for (const ws of [live, parked]) {
              expect(yield* endReason((yield* ws.until("end", 10_000)).at(-1))).toMatchObject({
                tag: "Unauthorized",
                code: "access_denied",
              })
              expect((yield* ws.closed).code).toBe(1008)
            }
          }).pipe(Effect.ensuring(Effect.sync(() => access.denied.delete("Chat"))))
        }),
      ),
  },
  {
    name: "keeps a parked connection parked over a real socket, and a frame wakes its actor with the session restored",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-parked")
          const ws = yield* socket(host, "ws-parked")
          yield* greet(ws, token())

          yield* test.hibernate(room.ref)
          expect(yield* ws.poll(500)).toEqual(Option.none())

          yield* ws.send(yield* say("whoami"))
          expect(yield* frameOf(yield* ws.next())).toEqual(
            Hello.make({ name: "alice", resumed: true }),
          )

          yield* test.hibernate(room.ref)
          yield* room.Post("wake")
          expect(yield* frameOf(yield* ws.next())).toEqual(Said.make({ text: "wake" }))
        }),
      ),
  },
  {
    name: "carries event cursors on frames, and omits every cursor under stampCursor: false",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-blind")
          yield* room.Post("first")

          const blind = yield* socket(host, "ws-blind", { member: "Blind" })
          yield* blind.send({ t: "hello", authorization: token() })
          const open = yield* opened(yield* blind.next())
          expect(open.baseline).toBe(undefined)

          const chat = yield* socket(host, "ws-blind")
          expect((yield* greet(chat, token())).baseline).toBe("1")

          yield* room.Post("second")
          const stamped = yield* chat.next()
          const bare = yield* blind.next()
          expect(yield* frameOf(stamped)).toEqual(Said.make({ text: "second" }))
          expect(stamped).toMatchObject({ cursor: "1" })
          expect(yield* frameOf(bare)).toEqual(Said.make({ text: "second" }))
          expect(Object.keys(bare).sort()).toEqual(["frame", "t"])
        }),
      ),
  },
  {
    name: "resyncs a WebSocket in place after its owner dies, and holds live frames until resyncDone",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const context = yield* Layer.build(
            ActorTest.cluster({
              database,
              runners: 2,
              shardLockExpiration: "3 seconds",
              actors: transportsLayer,
              as: User.make({ subject: "alice" }),
              authorize: () => Effect.succeed(true),
            }),
          )

          yield* Effect.gen(function* () {
            const cluster = yield* ActorCluster
            yield* cluster.ready

            let target: ActorRef | undefined

            for (let index = 0; target === undefined && index < 200; index++) {
              const candidate = (yield* cluster.on(0)(SocketRoom.get(`ws-crash-${index}`))).ref

              if ((yield* cluster.owner(candidate)) === 1) target = candidate
            }

            if (target === undefined)
              return yield* Effect.die(new Error("Runner 1 owns no probed actor"))

            const ref = target

            const post = (text: string) =>
              cluster.on(0)(SocketRoom.get(ref.id).pipe(Effect.flatMap((room) => room.Post(text))))

            const host = yield* cluster.on(0)(serveSockets(environment))
            const ws = yield* socket(host, ref.id)
            yield* greet(ws, `Bearer ${ref.tenant}:alice`)

            yield* post("before")
            expect(yield* frameOf(yield* ws.next())).toEqual(Said.make({ text: "before" }))

            yield* cluster.kill(1)

            expect(yield* ws.next(60_000)).toEqual({
              t: "resync",
              after: "1",
              reason: "OwnerLost",
              deadline: 30_000,
            })

            const replay = yield* ws.until("resyncReplayed", 60_000)
            expect(replay.at(-1)).toEqual({ t: "resyncReplayed" })
            expect(replay.filter((message) => message.t === "frame")).toEqual([])

            yield* post("during")
            expect(yield* ws.poll(1_000)).toEqual(Option.none())

            yield* ws.send({ t: "resyncDone", through: "1" })
            expect(yield* frameOf(yield* ws.next())).toEqual(Said.make({ text: "during" }))
            yield* ws.send(yield* say("whoami"))
            expect(yield* frameOf(yield* ws.next())).toEqual(
              Hello.make({ name: "alice", resumed: true }),
            )
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
]
