import { Effect, Fiber, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  Actor,
  Actors,
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  Unauthorized,
  User,
} from "../../index.ts"
import { type ActorRef, callerKey } from "../../identity/caller.ts"
import { commandTimes } from "../../identity/command.ts"
import { routingKey } from "../../runtime/storage/codec.ts"
import { InternalActors } from "../../runtime/actors.ts"
import { databaseTime } from "../../runtime/turn/admission.ts"
import { hashCanonical } from "../../runtime/turn/receipt.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"

const Pair = Schema.Struct({ b: Schema.Int, a: Schema.Int })

const Sum = Actor.command("Sum", { payload: Pair, success: Schema.Int })

const Echo = Actor.command("Echo", { payload: Schema.String, success: Schema.String })

const Adder = Actor.make("Adder", {
  key: Schema.String,
  state: Actor.state({}),
  api: { Sum, Echo },
})

const executions = { count: 0 }

export const admissionLayer = Adder.toLayer(
  Effect.succeed({
    Sum: ({ a, b }: typeof Pair.Type) =>
      Effect.sync(() => {
        executions.count += 1

        return a + b
      }),
    Echo: (text: string) =>
      Effect.sync(() => {
        executions.count += 1

        return text
      }),
  }),
)

/** The receipt hash of a payload: SHA-256 over its Postgres JSONB text. */
export const payloadHash = Effect.fnUntraced(function* (payload: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ canonical: string }>`SELECT ${payload}::jsonb::text AS canonical`

  return yield* hashCanonical(rows[0]!.canonical)
})

const writeReceipt = Effect.fnUntraced(function* (ref: ActorRef, commandId: string) {
  const sql = yield* SqlClient.SqlClient
  const hash = yield* payloadHash('{"value":{"b":2,"a":1}}')
  const key = routingKey({ ref, placement: "tenant" })
  yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
    VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}) ON CONFLICT DO NOTHING`
  yield* sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id, command_id, command, payload_hash, caller_key, outcome, expires_at_ms)
    VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${commandId}, 'Sum', ${hash},
      ${callerKey(User.make({ subject: "alice" }))}, '{"_tag":"Success","value":"{\\"value\\":40}"}', ${commandTimes(commandId).expiresAt})`
})

/** Receipt admission cases: replay by canonical payload hash, admission fenced inside the turn, and terminal rejection of malformed or expired identities. */
export const admissionConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "rejects first admission that expires while waiting for the generation fence without running its handler",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const adder = yield* Adder.get("expires-waiting-for-fence")
          expect(yield* adder.Echo("warm")).toBe("warm")
          const before = executions.count
          const locker = yield* environment.connect!
          yield* locker.query("BEGIN")
          yield* Effect.addFinalizer(() => locker.query("ROLLBACK"))
          yield* locker.query(
            "SELECT generation FROM actor_generations WHERE tenant_id = $1 AND actor_type = $2 AND actor_id = $3 FOR UPDATE",
            [adder.ref.tenant, adder.ref.actor, adder.ref.id],
          )
          const now = yield* databaseTime
          const id = `v1.${now - 59_000}.${now + 1_000}.2a32b8db-49b3-4e4c-8a7c-1c1630540c67`
          const call = yield* adder
            .Echo("late")
            .pipe(Actor.commandId(id), Effect.flip, Effect.forkChild)
          const waiting = yield* locker.query("SELECT pg_stat_clear_snapshot()").pipe(
            Effect.andThen(() =>
              locker.query(
                "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%actor_generations%' AND pid <> pg_backend_pid()",
              ),
            ),
            Effect.repeat({
              until: (rows) => (rows[0] as { waiting: number }).waiting === 1,
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("500 millis"),
          )
          expect(waiting).toEqual([{ waiting: 1 }])
          yield* Effect.sleep("1 second")
          yield* locker.query("ROLLBACK")
          expect((yield* Fiber.join(call)).reason).toEqual(CommandExpired.make({ commandId: id }))
          expect(executions.count).toBe(before)
          expect(yield* test.receiptsFor(adder.ref, "Echo")).toBe(1)
        }),
      ),
  },
  {
    name: "refuses an external caller's redelivery flag before any handler or receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const actors = yield* InternalActors
          const adder = yield* Adder.get("forged-redelivery")
          const commandId = yield* (yield* Actors).mintCommandId
          const before = executions.count

          for (const metadata of [
            { redelivered: false },
            { redelivered: true },
            { clockOffset: 60_000 },
          ])
            expect(
              yield* actors
                .execute({
                  ref: adder.ref,
                  caller: User.make({ subject: "alice" }),
                  command: "Echo",
                  commandId,
                  payload: '{"value":"forged"}',
                  ...metadata,
                })
                .pipe(Effect.flip),
            ).toMatchObject({ reason: Unauthorized.make({ code: "access_denied" }) })

          expect(executions.count).toBe(before)
          expect(yield* (yield* ActorTest).receiptsFor(adder.ref, "Echo")).toBe(0)
        }),
      ),
  },
  {
    name: "replays a receipt another runner stored by its canonical payload hash and conflicts on a changed payload",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const adder = yield* Adder.get("stored-receipt")
          const id = yield* (yield* Actors).mintCommandId
          yield* writeReceipt(adder.ref, id)
          const before = executions.count

          expect(yield* adder.Sum({ b: 2, a: 1 }).pipe(Actor.commandId(id))).toBe(40)
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
    name: "resolves a receipt another runner stored inside the turn's fenced admission",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const adder = yield* Adder.get("stored-receipt-in-turn")
          expect(yield* adder.Sum({ b: 0, a: 0 })).toBe(0)
          const before = executions.count

          const deliver = Effect.fnUntraced(function* (input: typeof Pair.Type) {
            const id = yield* (yield* Actors).mintCommandId
            const pause = yield* test.pauseNext("beforeDelivery")
            const call = yield* adder.Sum(input).pipe(Actor.commandId(id), Effect.forkChild)
            yield* pause.reached
            yield* writeReceipt(adder.ref, id)
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
  {
    name: "rechecks expiry before the reply against a clock read after the commit, not the admission clock",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const adder = yield* Adder.get("expires-mid-turn")
          expect(yield* adder.Echo("warm")).toBe("warm")
          const before = executions.count
          const pause = yield* test.pauseNext("beforeHandler")
          const now = yield* databaseTime
          const id = `v1.${now - 59_500}.${now + 500}.6c0f9e2a-4b1d-4c3e-9a7f-1e2d3c4b5a69`

          const call = yield* adder
            .Echo("late")
            .pipe(Actor.commandId(id), Effect.flip, Effect.forkChild)

          yield* pause.reached
          yield* Effect.sleep("600 millis")
          yield* pause.release

          expect((yield* Fiber.join(call)).reason).toEqual(CommandExpired.make({ commandId: id }))
          expect(executions.count).toBe(before + 1)
          expect(yield* test.receiptsFor(adder.ref, "Echo")).toBe(2)
        }),
      ),
  },
  {
    name: "rejects malformed and expired identities as terminal even when Postgres rejects their text",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const adder = yield* Adder.get("unencodable")
          const before = executions.count
          const malformed = "v1.1000.6000.\u0000"
          expect(
            yield* adder.Echo("text").pipe(Actor.commandId(malformed), Effect.flip),
          ).toMatchObject({
            reason: InvalidCommandId.make({ commandId: malformed, code: "malformed" }),
          })
          const expired = "v1.1000.61000.17b3670b-3f17-4a9b-aade-037e1dd1bba8"
          expect(
            yield* adder.Echo("\u0000").pipe(Actor.commandId(expired), Effect.flip),
          ).toMatchObject({ reason: CommandExpired.make({ commandId: expired }) })
          expect(executions.count).toBe(before)
        }),
      ),
  },
]

/** The admission cases' actor. */
export const admissionSuite: ConformanceSuite = {
  layer: () => admissionLayer,
}
