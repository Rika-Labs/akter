import { Effect, Fiber, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, CommandConflict } from "../../index.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { commandTimes } from "../../identity/command.ts"
import { routingKey } from "../../runtime/storage/codec.ts"
import { payloadHash } from "../../runtime/turn/receipt.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

// Fields declared out of key order, so the payload `{"value":{"b":2,"a":1}}`
// differs from its JSONB normalization `{"value": {"a": 1, "b": 2}}`.
const Pair = Schema.Struct({ b: Schema.Int, a: Schema.Int })

const Sum = Actor.command("Sum", { input: Pair, output: Schema.Int })

const Adder = Actor.make("Adder", { key: Schema.String, state: Actor.state({}), api: { Sum } })

// Counts handler runs so replay cases can prove a stored outcome is not recomputed.
const executions = { count: 0 }

export const admissionLayer = Adder.toLayer(
  Effect.succeed({
    Sum: ({ a, b }: typeof Pair.Type) =>
      Effect.sync(() => {
        executions.count += 1

        return a + b
      }),
  }),
)

// SHA-256 of `{"value": {"a": 1, "b": 2}}`, the hash the admission path stored for
// `{ b: 2, a: 1 }` before canonicalization moved into the admission statements.
const LEGACY_HASH = "f8d20b296bbcf711deb5ce365b02b79c16ddc2b0c19b292d1e866c4bcc3c1b4a"

// Writes the receipt row exactly as the previous admission path committed it.
const writeLegacyReceipt = Effect.fnUntraced(function* (ref: ActorRef, commandId: string) {
  const sql = yield* SqlClient.SqlClient
  const key = routingKey({ ref, placement: "tenant" })
  yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
    VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}) ON CONFLICT DO NOTHING`
  yield* sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id, command_id, command, payload_hash, caller_key, outcome, expires_at_ms)
    VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${commandId}, 'Sum', ${LEGACY_HASH},
      '["User","alice"]', '{"_tag":"Success","value":"{\\"value\\":40}"}', ${commandTimes(commandId).expiresAt})`
})

export const admissionConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "replays a receipt stored before admission folding and conflicts on a changed payload",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          expect(yield* payloadHash('{"value":{"b":2,"a":1}}')).toBe(LEGACY_HASH)
          const adder = yield* Adder.get("legacy-receipt")
          const id = yield* (yield* Actors).mintCommandId
          yield* writeLegacyReceipt(adder.ref, id)
          const before = executions.count

          expect(yield* adder.Sum({ b: 2, a: 1 }).pipe(Actor.commandId(id))).toBe(40)
          expect(yield* adder.Sum({ a: 1, b: 2 }).pipe(Actor.commandId(id))).toBe(40)
          expect(
            yield* adder.Sum({ b: 1, a: 2 }).pipe(Actor.commandId(id), Effect.flip),
          ).toMatchObject({
            reason: CommandConflict.make({ commandId: id }),
          })
          expect(executions.count).toBe(before)
          expect(yield* (yield* ActorTest).inspect(adder.ref)).toMatchObject({ receipts: 1 })
        }),
      ),
  },
  {
    name: "resolves a receipt stored before admission folding inside the turn's fenced admission",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const adder = yield* Adder.get("legacy-receipt-in-turn")
          expect(yield* adder.Sum({ b: 0, a: 0 })).toBe(0)
          const before = executions.count

          // The receipt lands after the pre-delivery read missed, so only the
          // fenced admission statement inside the turn can resolve it.
          const deliver = Effect.fnUntraced(function* (input: typeof Pair.Type) {
            const id = yield* (yield* Actors).mintCommandId
            const pause = yield* test.pauseNext("beforeDelivery")
            const call = yield* adder.Sum(input).pipe(Actor.commandId(id), Effect.forkChild)
            yield* pause.reached
            yield* writeLegacyReceipt(adder.ref, id)
            yield* pause.release

            return { id, call }
          })

          expect(yield* Fiber.join((yield* deliver({ b: 2, a: 1 })).call)).toBe(40)
          const changed = yield* deliver({ b: 1, a: 2 })
          expect(yield* Fiber.join(changed.call).pipe(Effect.flip)).toMatchObject({
            reason: CommandConflict.make({ commandId: changed.id }),
          })
          expect(executions.count).toBe(before)
          expect(yield* test.inspect(adder.ref)).toMatchObject({ generation: "1", receipts: 3 })
        }),
      ),
  },
]
