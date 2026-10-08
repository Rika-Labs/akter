import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Actor, Intent } from "../../../../packages/akter/src/index.ts"
import type { ActorRef } from "../../../../packages/akter/src/identity/caller.ts"
import { routingKey } from "../../../../packages/akter/src/runtime/storage/codec.ts"
import { ActorTest } from "../../../../packages/akter/src/testing/actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"
import { CLAIM_LEASE } from "./outbox.ts"

const Receive = Actor.command("Receive", { payload: Schema.String })

const Touch = Actor.command("Touch")

const Bodies = Actor.query("Bodies", { success: Schema.Array(Schema.String) })

/** An actor placed by its own id, so a receiver can sit on another shard than its sender. */
const Mailbox = Actor.make("ShardMailbox", {
  key: Schema.String,
  placement: "actor",
  state: Actor.state({
    bodies: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  api: { Touch, Bodies },
  internal: { Receive },
})

const Post = Actor.command("Post", {
  payload: Schema.Struct({ to: Schema.String, body: Schema.String, afterMs: Schema.Int }),
})

const Poster = Actor.make("ShardPoster", {
  key: Schema.String,
  placement: "actor",
  api: { Post },
})

/** Receiver handler runs by body, a rolled-back run included. */
const taken = new Map<string, number>()

export const crossShardLayer = Layer.mergeAll(
  Mailbox.toLayer(
    Effect.succeed({
      Touch: () => Effect.void,
      Receive: Effect.fnUntraced(function* (body: string) {
        const turn = yield* Mailbox.Turn
        taken.set(body, (taken.get(body) ?? 0) + 1)
        yield* turn.state.set({ bodies: [...turn.state.bodies, body] })
      }),
    }),
  ),
  Mailbox.toQueryLayer(
    Effect.succeed({
      Bodies: Effect.fnUntraced(function* () {
        return (yield* Mailbox.Read).state.bodies
      }),
    }),
  ),
  Poster.toLayer(
    Effect.succeed({
      Post: Effect.fnUntraced(function* ({ to, body, afterMs }) {
        yield* (yield* Mailbox.intents(to))
          .Receive(body)
          .pipe(Intent.after(Duration.millis(afterMs)))
      }),
    }),
  ),
)

/**
 * A sender and a receiver whose routing keys sit in opposite halves of the
 * 64-bit range, so the cases exercise distinct scheduling buckets. Ids carry
 * the scenario, so cases sharing a tenant never share an actor.
 */
const across = Effect.fnUntraced(function* (scenario: string) {
  const test = yield* ActorTest

  const keyOf = (actor: string, id: string): bigint =>
    routingKey({ ref: { tenant: test.tenant, actor, id }, placement: "actor" })

  const sender = Array.from({ length: 256 }, (_, index) => `${scenario}-from-${index}`).find(
    (id) => keyOf("ShardPoster", id) < 0n,
  )

  const receiver = Array.from({ length: 256 }, (_, index) => `${scenario}-to-${index}`).find(
    (id) => keyOf("ShardMailbox", id) >= 0n,
  )

  if (sender === undefined || receiver === undefined)
    return yield* Effect.die(new Error("No sender and receiver in opposite halves of the range"))

  return {
    sender: yield* Poster.get(sender),
    receiver: yield* Mailbox.get(receiver),
    senderKey: keyOf("ShardPoster", sender),
    receiverKey: keyOf("ShardMailbox", receiver),
  }
})

const keysOf = Effect.fnUntraced(function* (table: string, ref: ActorRef) {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{ key: string }>`
    SELECT DISTINCT routing_key::text AS key FROM ${sql(table)}
    WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`.pipe(
    Effect.orDie,
  )

  return rows.map(({ key }) => key)
})

/**
 * The cross-key cases of the Outbox delivery gate. The sender's outbox row
 * lives under the sender's routing key and the receiver's receipt under the
 * receiver's, with the row deleted only after the receiver commits. These
 * cases prove the protocol holds across routing keys on one database.
 */
export const crossShardOutboxConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "cross-shard outbox: delivers an intent from the sender's routing key to a receiver under another one",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const { sender, receiver, senderKey, receiverKey } = yield* across("deliver")
          yield* sender.Post({ to: receiver.ref.id, body: "hello", afterMs: 60_000 })

          expect(yield* keysOf("actor_outbox", sender.ref)).toEqual([String(senderKey)])
          yield* test.advance("1 minute")

          expect(yield* receiver.Bodies().pipe(Effect.orDie)).toEqual(["hello"])
          expect(yield* keysOf("actor_receipts", receiver.ref)).toEqual([String(receiverKey)])
          expect(String(senderKey) === String(receiverKey)).toBe(false)
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ receipts: 1, outbox: 0 })
        }),
      ),
  },
  {
    name: "cross-shard outbox: a crash before delivery leaves the row and the receiver untouched, and the redelivery lands once",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const { sender, receiver } = yield* across("before-delivery")
          yield* sender.Post({ to: receiver.ref.id, body: "before-delivery", afterMs: 60_000 })

          yield* test.crashNext("beforeDelivery")
          yield* test.advance("1 minute")
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(0)
          expect(taken.get("before-delivery")).toBe(undefined)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })

          yield* test.advance(CLAIM_LEASE)
          expect(yield* receiver.Bodies().pipe(Effect.orDie)).toEqual(["before-delivery"])
          expect(taken.get("before-delivery")).toBe(1)
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
  {
    name: "cross-shard outbox: a crash after the receiver commits redelivers to a receipt replay, with one handler run",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const { sender, receiver } = yield* across("after-commit")
          yield* sender.Post({ to: receiver.ref.id, body: "after-commit", afterMs: 60_000 })

          yield* test.crashNext("afterCommit")
          yield* test.advance("1 minute")
          yield* test.advance(CLAIM_LEASE)

          expect(yield* receiver.Bodies().pipe(Effect.orDie)).toEqual(["after-commit"])
          expect(taken.get("after-commit")).toBe(1)
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
  {
    name: "cross-shard outbox: a crash between the receiver's commit and the row's deletion keeps the row until the redelivery replays the receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const { sender, receiver } = yield* across("before-delete")
          yield* sender.Post({ to: receiver.ref.id, body: "before-delete", afterMs: 60_000 })

          yield* test.crashNext("beforeOutboxDelete")
          const pause = yield* test.pauseNext("beforeOutboxDelete")
          yield* test.advance("1 minute")
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })
          const draining = yield* test.advance(CLAIM_LEASE).pipe(Effect.forkChild)
          yield* pause.reached

          expect(taken.get("before-delete")).toBe(1)
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 1 })
          yield* pause.release
          yield* Fiber.join(draining)

          expect(yield* receiver.Bodies().pipe(Effect.orDie)).toEqual(["before-delete"])
          expect(taken.get("before-delete")).toBe(1)
          expect(yield* test.receiptsFor(receiver.ref, "Receive")).toBe(1)
          expect(yield* test.inspect(sender.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
]

/** Cross-shard mailbox actors. */
export const crossShardSuite: ConformanceSuite = {
  layer: () => crossShardLayer,
}
