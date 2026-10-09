import { BunCrypto } from "@effect/platform-bun"
import {
  Cause,
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  ManagedRuntime,
  Option,
  Stream,
} from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { Actor } from "../../../../../packages/akter/src/index.ts"
import {
  ColdStorage,
  ColdStorageError,
} from "../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { disposableDatabase } from "../../../../../packages/akter/src/testing/database.ts"
import { enqueue } from "../batches.ts"
import { ColdLedger, openCold } from "./cold-tier.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => harness.dispose())

const database = disposableDatabase({
  url: Config.Redacted("TEST_DATABASE_URL").pipe(Effect.runSync),
})
const snapshot = { total: 17, untouched: 43, first: "A|BC", second: "DZ" }

describe("cold tier with real Postgres", () => {
  it("offloads through the relay without a turn, reads through without activation, and restores every key and chunk after a declared failure", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        let reads = 0
        const store = {
          ...base,
          get: (key: string) =>
            Effect.suspend(() => {
              reads++
              return base.get(key)
            }),
        }
        const { cold, pointer, test, sql, tier } = yield* openCold(yield* database, store)
        const actor = yield* cold("complete")
        const before = yield* pointer("complete")
        expect(before.cold_ref).toEqual(expect.any(String))
        expect(yield* test.inspect(actor.ref)).toMatchObject({
          generation: "1",
          state: {},
          receipts: 1,
          events: 1,
          outbox: 1,
          blobs: { archive: 0 },
        })
        expect(
          yield* sql`SELECT kind, command, payload, caller::jsonb->>'source' AS source FROM actor_outbox ORDER BY command`,
        ).toEqual([{ kind: "intent", command: "Ping", payload: '{"value":null}', source: "timer" }])
        expect(yield* actor.Read()).toEqual(snapshot)
        expect(yield* pointer("complete")).toEqual(before)
        expect(Exit.isFailure(yield* actor.Refuse().pipe(Effect.exit))).toBe(true)
        expect((yield* pointer("complete")).cold_ref).toBe(before.cold_ref)
        expect(yield* test.inspect(actor.ref)).toMatchObject({
          state: {},
          receipts: 2,
          events: 1,
          outbox: 1,
          blobs: { archive: 0 },
        })
        const fetched = reads
        expect(yield* actor.Add(3)).toBe(20)
        expect(reads).toBe(fetched)
        expect((yield* pointer("complete")).cold_ref).toBeNull()
        expect(yield* actor.Read()).toEqual({ ...snapshot, total: 20 })
        expect(yield* sql`SELECT key FROM actor_state ORDER BY key`).toEqual([
          { key: "total" },
          { key: "untouched" },
        ])
        expect(yield* sql`SELECT name, chunk FROM actor_blobs ORDER BY name, chunk`).toEqual([
          { name: "first", chunk: 0 },
          { name: "first", chunk: 1 },
          { name: "second", chunk: 0 },
        ])
        expect(yield* sql`SELECT object_key FROM actor_cold_garbage`).toEqual([
          { object_key: before.cold_ref },
        ])
        expect(yield* tier!.sweep(true)).toBe(0)
        expect(yield* base.get(before.cold_ref!)).toBeInstanceOf(Uint8Array)
      }).pipe(Effect.scoped),
    ))

  it("rolls back restored material and every business consequence on a defect, then restores unchanged committed state", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const { cold, pointer, test } = yield* openCold(yield* database, ColdStorage.memory())
        const actor = yield* cold("defect")
        const before = yield* pointer("defect")
        const result = yield* actor.Explode().pipe(Effect.exit)
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain(
          "cold handler defect",
        )
        expect((yield* pointer("defect")).cold_ref).toBe(before.cold_ref)
        expect(yield* test.inspect(actor.ref)).toMatchObject({
          state: {},
          receipts: 1,
          events: 1,
          outbox: 1,
          blobs: { archive: 0 },
        })
        expect(yield* actor.Add(9)).toBe(26)
        expect(yield* actor.Read()).toEqual({ ...snapshot, total: 26 })
      }).pipe(Effect.scoped),
    ))

  it("refuses an expired identity and a receipt conflict before any cold fetch during an outage", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        let reads = 0
        const store = {
          ...base,
          get: () =>
            Effect.suspend(() => {
              reads++
              return Effect.fail(new ColdStorageError({ cause: new Error("offline") }))
            }),
        }
        const { ledger, test, pointer } = yield* openCold(yield* database, store)
        const actor = yield* ledger("refused-admission")
        const now = (yield* test.now).epochMilliseconds
        const id = `v1.${now}.${now + 86_400_000}.d650cd06-f188-4f35-97d4-b2ee67b13312`
        yield* actor.Seed().pipe(Actor.commandId(id))
        yield* test.hibernate(actor.ref)
        yield* test.advance(2)
        const before = yield* pointer("refused-admission")
        expect((yield* actor.Add(1).pipe(Actor.commandId(id), Effect.flip)).reason._tag).toBe(
          "CommandConflict",
        )
        const issued = now - 86_400_001
        const expired = `v1.${issued}.${issued + 86_400_000}.c35e3205-5d84-40d4-a52c-4cfe98753051`
        expect((yield* actor.Add(2).pipe(Actor.commandId(expired), Effect.flip)).reason._tag).toBe(
          "CommandExpired",
        )
        expect(reads).toBe(0)
        expect((yield* pointer("refused-admission")).cold_ref).toBe(before.cold_ref)
        expect(yield* test.inspect(actor.ref)).toMatchObject({ state: {}, receipts: 1, events: 1 })
      }).pipe(Effect.scoped),
    ))

  it("publishes no partial cold batch and keeps every original receipt identity through failure and full write-back", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const { cold, test, context, sql, pointer } = yield* openCold(
          yield* database,
          ColdStorage.memory(),
        )
        const actor = yield* cold("batch")
        const firstCommit = yield* test.pauseNext("beforeCommit")
        const first = yield* actor.Refuse().pipe(Effect.exit, Effect.forkChild)
        yield* firstCommit.reached
        const now = (yield* test.now).epochMilliseconds
        const ids = [
          "128c1d05-07c6-4f82-9f0b-20d9003b159c",
          "dbfe3cdf-12c2-43a6-a1c9-33b32a5d8f55",
          "93ed9c2f-7886-4125-8341-88ae18dc40ac",
        ].map((uuid) => `v1.${now}.${now + 86_400_000}.${uuid}`)
        const waiting = yield* enqueue<Exit.Exit<unknown, unknown>, never>([
          actor.Refuse().pipe(Actor.commandId(ids[0]!), Effect.exit),
          actor.Add(3).pipe(Actor.commandId(ids[1]!), Effect.exit),
          actor.Add(11).pipe(Actor.commandId(ids[2]!), Effect.exit),
        ]).pipe(Effect.provideContext(context))
        const batchCommit = yield* test.pauseNext("beforeCommit")
        yield* firstCommit.release
        expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
        yield* batchCommit.reached
        expect(waiting.map((fiber) => fiber.pollUnsafe())).toEqual([
          undefined,
          undefined,
          undefined,
        ])
        expect((yield* pointer("batch")).cold_ref).not.toBeNull()
        expect(yield* sql`SELECT count(*)::int AS n FROM actor_state`).toEqual([{ n: 0 }])
        yield* batchCommit.release
        const replies = yield* Effect.forEach(waiting, Fiber.join)
        expect(Exit.isFailure(replies[0]!)).toBe(true)
        expect(replies.slice(1)).toEqual([Exit.succeed(20), Exit.succeed(31)])
        expect(
          yield* sql`SELECT count(*)::int AS n, count(DISTINCT xmin::text)::int AS transactions
        FROM actor_receipts WHERE command_id IN ${sql.in(ids)}`,
        ).toEqual([{ n: 3, transactions: 1 }])
        expect(yield* actor.Add(3).pipe(Actor.commandId(ids[1]!))).toBe(20)
        expect(yield* actor.Read()).toEqual({ ...snapshot, total: 31 })
      }).pipe(Effect.scoped),
    ))

  it("replays retained receipts during a GET outage and retries an unavailable new command with its original identity", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        let unavailable = false
        let reads = 0
        const store = {
          ...base,
          get: (key: string) =>
            Effect.suspend(() => {
              reads++
              return unavailable
                ? Effect.fail(new ColdStorageError({ cause: new Error("offline") }))
                : base.get(key)
            }),
        }
        const { ledger, pointer, test, sql } = yield* openCold(yield* database, store)
        const actor = yield* ledger("outage")
        const now = (yield* test.now).epochMilliseconds
        const seededId = `v1.${now}.${now + 86_400_000}.8f5d3471-b1de-4e80-89c7-1b7a9a5249a3`
        expect(yield* actor.Seed().pipe(Actor.commandId(seededId))).toBe(17)
        yield* test.hibernate(actor.ref)
        yield* test.advance(2)
        unavailable = true
        expect(yield* actor.Seed().pipe(Actor.commandId(seededId))).toBe(17)
        expect(reads).toBe(0)
        const requestId = `v1.${now}.${now + 86_400_000}.345de76a-7f87-4bb4-9673-8e12c31ac9f1`
        const attempt = yield* actor.Add(5).pipe(Actor.commandId(requestId), Effect.forkChild)
        while (reads === 0) yield* Effect.sleep(5)
        expect((yield* pointer("outage")).cold_ref).not.toBeNull()
        expect(
          yield* sql`SELECT count(*)::int AS n FROM actor_receipts WHERE command_id = ${requestId}`,
        ).toEqual([{ n: 0 }])
        unavailable = false
        expect(yield* Fiber.join(attempt)).toBe(22)
        expect(yield* actor.Add(5).pipe(Actor.commandId(requestId))).toBe(22)
        expect(yield* actor.Read()).toEqual({ ...snapshot, total: 22 })
        expect(
          yield* sql`SELECT count(*)::int AS n FROM actor_receipts WHERE command_id = ${requestId}`,
        ).toEqual([{ n: 1 }])
      }).pipe(Effect.scoped),
    ))

  it.each(["receipt", "warm", "pointer"] as const)(
    "releases admission before fetch and rechecks a competing %s at renewed admission",
    (race) =>
      harness.runPromise(
        Effect.gen(function* () {
          const url = yield* database
          const store = ColdStorage.memory()
          const fetched = yield* Deferred.make<void>()
          const resume = yield* Deferred.make<void>()
          let reads = 0
          const primary = yield* openCold(url, store, undefined, {
            at: (point) =>
              point === "afterColdFetch" && reads++ === 0
                ? Deferred.succeed(fetched, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          })
          const actor = yield* primary.cold("race")
          const before = yield* primary.pointer("race")
          const now = (yield* primary.test.now).epochMilliseconds
          const id = `v1.${now - 1000}.${now - 1000 + 86_400_000}.a8ae2821-8a3f-4b6a-aa88-fae274f48c96`
          const request = (race === "receipt" ? actor.Refuse() : actor.Add(7)).pipe(
            Actor.commandId(id),
          )
          const pending = yield* request.pipe(Effect.exit, Effect.forkChild)
          yield* Deferred.await(fetched)
          expect(yield* primary.sql`SELECT generation::text FROM actor_generations`).toEqual([
            { generation: before.generation },
          ])
          expect(
            yield* primary.sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'`,
          ).toEqual([{ n: 0 }])
          const rival = yield* openCold(url, store)
          const other = yield* ColdLedger.get("race").pipe(
            Actor.tenant(primary.test.tenant),
            Effect.provideContext(rival.context),
          )
          if (race === "receipt") {
            expect(
              Exit.isFailure(yield* other.Refuse().pipe(Actor.commandId(id), Effect.exit)),
            ).toBe(true)
            expect((yield* primary.pointer("race")).cold_ref).toBe(before.cold_ref)
          } else {
            expect(yield* other.Add(5)).toBe(22)
            if (race === "pointer") {
              yield* rival.test.hibernate(other.ref)
              yield* rival.test.advance(2)
              expect((yield* primary.pointer("race")).cold_ref).not.toBe(before.cold_ref)
              expect((yield* primary.pointer("race")).cold_ref).not.toBeNull()
            }
          }
          yield* Deferred.succeed(resume, undefined)
          const result = yield* Fiber.join(pending)
          if (race === "receipt") {
            expect(Exit.isFailure(result)).toBe(true)
            expect((yield* primary.pointer("race")).cold_ref).toBe(before.cold_ref)
            expect(yield* primary.test.inspect(actor.ref)).toMatchObject({
              state: {},
              receipts: 2,
              events: 1,
              blobs: { archive: 0 },
            })
            expect(reads).toBe(1)
          } else {
            expect(result).toEqual(Exit.succeed(29))
            expect((yield* primary.pointer("race")).cold_ref).toBeNull()
            expect(yield* actor.Read()).toEqual({ ...snapshot, total: 29 })
            expect(reads).toBe(race === "pointer" ? 2 : 1)
          }
          expect(
            yield* primary.sql`SELECT count(*)::int AS n FROM actor_receipts WHERE command_id = ${id}`,
          ).toEqual([{ n: 1 }])
        }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
      ),
  )

  it("times out read-through as retryable ActorUnavailable without activating or changing durable material", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        let offline = false
        const store = { ...base, get: (key: string) => (offline ? Effect.never : base.get(key)) }
        const { cold, pointer, test } = yield* openCold(yield* database, store)
        const actor = yield* cold("timeout")
        const before = yield* pointer("timeout")
        offline = true
        const exit = yield* actor.Read().pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit)
          ? Option.getOrThrow(Cause.findErrorOption(exit.cause))
          : undefined
        expect(error).toHaveProperty("_tag", "ActorError")
        expect(error).toHaveProperty("reason._tag", "ActorUnavailable")
        expect(error).toHaveProperty("isRetryable", true)
        expect(
          Option.getOrThrow((error as { retryAfter: Option.Option<number> }).retryAfter),
        ).toBeGreaterThan(0)
        expect(yield* pointer("timeout")).toEqual(before)
        expect(yield* test.inspect(actor.ref)).toMatchObject({
          state: {},
          receipts: 1,
          blobs: { archive: 0 },
        })
        offline = false
        expect(yield* actor.Add(4)).toBe(21)
      }).pipe(Effect.scoped),
    ))

  it("does not claim a cold row without configured storage and enforces truthful maintenance rows", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const { ledger, test, sql } = yield* openCold(yield* database, undefined)
        const actor = yield* ledger("disabled")
        yield* actor.Seed()
        yield* test.hibernate(actor.ref)
        expect(yield* sql`SELECT count(*)::int AS n FROM actor_outbox WHERE kind = 'cold'`).toEqual(
          [{ n: 0 }],
        )
        const row = yield* sql`INSERT INTO actor_outbox
        (routing_key, intent_id, bucket, kind, due_at_ms, scheduled_at_ms, tenant_id, actor_type, actor_id,
          timer_key, target_type, target_id, command, payload, caller)
        SELECT routing_key, 'unconfigured', (routing_key >> 56)::int, 'cold', 1, 1, tenant_id,
          actor_type, actor_id, '$cold', actor_type, actor_id, '$cold', 'null', '{"_tag":"System","source":"cold"}'
        FROM actor_generations RETURNING intent_id`
        expect(row).toEqual([{ intent_id: "unconfigured" }])
        yield* test.advance(2)
        expect(yield* sql`SELECT attempts FROM actor_outbox WHERE kind = 'cold'`).toEqual([
          { attempts: 0 },
        ])
        for (const mutation of [
          "timer_key = NULL",
          "target_id = 'wrong'",
          "command = 'Ping'",
          "payload = '{}'",
          "caller = '{}'",
          "kind = 'intent'",
        ])
          expect(
            Exit.isFailure(
              yield* sql
                .unsafe(`UPDATE actor_outbox SET ${mutation} WHERE kind = 'cold'`)
                .pipe(Effect.exit),
            ),
          ).toBe(true)
      }).pipe(Effect.scoped),
    ))

  it("backs off a failed upload indefinitely without a dead letter or state loss", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        let offline = true
        const store = {
          ...base,
          put: (key: string, bytes: Uint8Array) =>
            Effect.suspend(() =>
              offline
                ? Effect.fail(new ColdStorageError({ cause: new Error("PUT offline") }))
                : base.put(key, bytes),
            ),
        }
        const { ledger, test, pointer, sql, tier, claim } = yield* openCold(yield* database, store)
        const actor = yield* ledger("retry-upload")
        yield* actor.Seed()
        yield* test.hibernate(actor.ref)
        yield* test.advance(2)
        expect((yield* pointer("retry-upload")).cold_ref).toBeNull()
        expect(yield* actor.Read()).toEqual(snapshot)
        expect(
          yield* sql`SELECT attempts, last_error IS NOT NULL AS failed FROM actor_outbox WHERE kind = 'cold'`,
        ).toEqual([{ attempts: 1, failed: true }])
        yield* sql`UPDATE actor_outbox SET attempts = 9 WHERE kind = 'cold'`
        yield* tier!.offload(yield* claim("retry-upload"))
        expect(yield* sql`SELECT attempts FROM actor_outbox WHERE kind = 'cold'`).toEqual([
          { attempts: 10 },
        ])
        expect(yield* sql`SELECT count(*)::int AS n FROM actor_dead_letters`).toEqual([{ n: 0 }])
        offline = false
        yield* tier!.offload(yield* claim("retry-upload"))
        expect((yield* pointer("retry-upload")).cold_ref).not.toBeNull()
        expect(yield* actor.Add(7)).toBe(24)
        expect(yield* actor.Read()).toEqual({ ...snapshot, total: 24 })
      }).pipe(Effect.scoped),
    ))

  it.each(["digest", "envelope"] as const)(
    "leaves cold material untouched on deterministic %s corruption",
    (kind) =>
      harness.runPromise(
        Effect.gen(function* () {
          const base = ColdStorage.memory()
          let corrupt = false
          const store = {
            ...base,
            get: (key: string) =>
              corrupt && kind === "digest"
                ? Effect.succeed(new Uint8Array([1, 2, 3]))
                : base.get(key),
          }
          const { cold, pointer, sql, test } = yield* openCold(yield* database, store)
          const actor = yield* cold("corrupt")
          const before = yield* pointer("corrupt")
          if (kind === "envelope") yield* sql`UPDATE actor_generations SET cold_state_version = 3`
          corrupt = true
          const exit = yield* actor.Add(2).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
            kind === "digest" ? "digest mismatch" : "envelope mismatch",
          )
          expect((yield* pointer("corrupt")).cold_ref).toBe(before.cold_ref)
          expect(yield* test.inspect(actor.ref)).toMatchObject({
            state: {},
            receipts: 1,
            blobs: { archive: 0 },
          })
          expect(yield* base.list("").pipe(Stream.runCollect)).toHaveLength(1)
        }).pipe(Effect.scoped),
      ),
  )
})
