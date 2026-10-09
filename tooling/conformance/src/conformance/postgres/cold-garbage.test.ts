import { BunCrypto } from "@effect/platform-bun"
import { Config, Deferred, Effect, Exit, Fiber, ManagedRuntime, Redacted, Stream } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import {
  ColdStorage,
  ColdStorageError,
} from "../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { disposableDatabase } from "../../../../../packages/akter/src/testing/database.ts"
import { ColdLedger, openCold } from "./cold-tier.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => harness.dispose())
const database = disposableDatabase({
  url: Config.Redacted("TEST_DATABASE_URL").pipe(Effect.runSync),
})

describe("cold offload and collectors with real Postgres", () => {
  it("reuses an immutable upload across competing claims without garbage-recording or deleting the winning live object", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        const store = {
          ...base,
          list: (prefix: string) =>
            base.list(prefix).pipe(Stream.map((object) => ({ ...object, createdAtMs: 0 }))),
        }
        const uploaded = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        let uploads = 0
        const { ledger, tier, claim, sql, test, pointer } = yield* openCold(
          yield* database,
          store,
          {
            periodic: false,
            at: (point) =>
              point === "afterUpload" && uploads++ === 0
                ? Deferred.succeed(uploaded, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          },
        )
        const actor = yield* ledger("same-key")
        yield* actor.Seed()
        yield* test.hibernate(actor.ref)
        const old = yield* tier!.offload(yield* claim("same-key")).pipe(Effect.forkChild)
        yield* Effect.addFinalizer(() => Deferred.succeed(resume, undefined).pipe(Effect.asVoid))
        yield* Deferred.await(uploaded)
        yield* tier!.offload(yield* claim("same-key"))
        const live = (yield* pointer("same-key")).cold_ref!
        yield* Deferred.succeed(resume, undefined)
        yield* Fiber.join(old)
        expect(yield* sql`SELECT * FROM actor_cold_garbage`).toEqual([])
        yield* sql`INSERT INTO actor_cold_garbage
        SELECT routing_key, tenant_id, actor_type, actor_id, cold_ref, 0 FROM actor_generations`
        for (const reconcile of [false, true]) expect(yield* tier!.sweep(reconcile)).toBe(0)
        expect(yield* base.get(live)).toBeInstanceOf(Uint8Array)
        expect(yield* store.list("").pipe(Stream.runCollect)).toHaveLength(1)
        expect(yield* actor.Add(7)).toBe(24)
      }).pipe(Effect.scoped),
    ))

  it("aborts an uploaded stale snapshot after a wake, preserves the replacement timer, and later offloads the newer state", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        const store = {
          ...base,
          list: (prefix: string) =>
            base.list(prefix).pipe(Stream.map((object) => ({ ...object, createdAtMs: 0 }))),
        }
        const uploaded = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        let uploads = 0
        const { ledger, tier, claim, sql, test, pointer } = yield* openCold(
          yield* database,
          store,
          {
            periodic: false,
            at: (point) =>
              point === "afterUpload" && uploads++ === 0
                ? Deferred.succeed(uploaded, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          },
        )
        const actor = yield* ledger("wake-race")
        yield* actor.Seed()
        yield* test.hibernate(actor.ref)
        const pending = yield* tier!.offload(yield* claim("wake-race")).pipe(Effect.forkChild)
        yield* Effect.addFinalizer(() => Deferred.succeed(resume, undefined).pipe(Effect.asVoid))
        yield* Deferred.await(uploaded)
        expect(yield* actor.Add(11)).toBe(28)
        yield* test.hibernate(actor.ref)
        const replacement =
          yield* sql`SELECT intent_id, attempts, due_at_ms FROM actor_outbox WHERE kind = 'cold'`
        yield* Deferred.succeed(resume, undefined)
        yield* Fiber.join(pending)
        expect((yield* pointer("wake-race")).cold_ref).toBeNull()
        expect(
          yield* sql`SELECT intent_id, attempts, due_at_ms FROM actor_outbox WHERE kind = 'cold'`,
        ).toEqual(replacement)
        expect(yield* sql`SELECT count(*)::int AS n FROM actor_cold_garbage`).toEqual([{ n: 1 }])
        yield* sql`UPDATE actor_cold_garbage SET unreferenced_at_ms = 0`
        for (const reconcile of [false, true]) expect(yield* tier!.sweep(reconcile)).toBe(0)
        yield* tier!.offload(yield* claim("wake-race"))
        expect((yield* pointer("wake-race")).cold_ref).not.toBeNull()
        expect(yield* tier!.sweep(true)).toBe(1)
        expect(yield* base.list("").pipe(Stream.runCollect)).toHaveLength(1)
        expect(yield* actor.Add(3)).toBe(31)
        expect(yield* actor.Read()).toEqual({
          total: 31,
          untouched: 43,
          first: "A|BC",
          second: "DZ",
        })
      }).pipe(Effect.scoped),
    ))

  it("leaves a newer wake's cold timer alone when a stale empty snapshot settles", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const store = ColdStorage.memory()
        const snapshotted = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        let snapshots = 0
        const { tier, claim, sql, test, context } = yield* openCold(yield* database, store, {
          periodic: false,
          at: (point) =>
            point === "afterSnapshot" && snapshots++ === 0
              ? Deferred.succeed(snapshotted, undefined).pipe(
                  Effect.andThen(Deferred.await(resume)),
                )
              : Effect.void,
        })
        const { system: actor } = yield* test
          .actor(ColdLedger, "empty")
          .pipe(Effect.provideContext(context))
        yield* actor.Ping().pipe(Effect.provideContext(context))
        yield* test.hibernate(actor.ref)
        const pending = yield* tier!.offload(yield* claim("empty")).pipe(Effect.forkChild)
        yield* Effect.addFinalizer(() => Deferred.succeed(resume, undefined).pipe(Effect.asVoid))
        yield* Deferred.await(snapshotted)
        yield* actor.Seed().pipe(Effect.provideContext(context))
        yield* test.hibernate(actor.ref)
        const replacement =
          yield* sql`SELECT intent_id, attempts, due_at_ms FROM actor_outbox WHERE kind = 'cold'`
        yield* Deferred.succeed(resume, undefined)
        yield* Fiber.join(pending)
        expect(
          yield* sql`SELECT intent_id, attempts, due_at_ms FROM actor_outbox WHERE kind = 'cold'`,
        ).toEqual(replacement)
        expect(yield* store.list("").pipe(Stream.runCollect)).toHaveLength(0)
        yield* tier!.offload(yield* claim("empty"))
        expect(yield* actor.Read().pipe(Effect.provideContext(context))).toEqual({
          total: 17,
          untouched: 43,
          first: "A|BC",
          second: "DZ",
        })
      }).pipe(Effect.scoped),
    ))

  it("uses the latest unreference, not creation age or an old garbage deadline, in both collectors", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        const store = {
          ...base,
          list: (prefix: string) =>
            base.list(prefix).pipe(Stream.map((object) => ({ ...object, createdAtMs: 0 }))),
        }
        const { cold, pointer, tier, sql, test } = yield* openCold(yield* database, store)
        const actor = yield* cold("old-object")
        const key = (yield* pointer("old-object")).cold_ref!
        yield* sql`INSERT INTO actor_cold_garbage
        SELECT routing_key, tenant_id, actor_type, actor_id, cold_ref, 0 FROM actor_generations`
        expect(yield* actor.Add(5)).toBe(22)
        expect(yield* sql`SELECT unreferenced_at_ms > 0 AS recent FROM actor_cold_garbage`).toEqual(
          [{ recent: true }],
        )
        for (const reconcile of [false, true]) expect(yield* tier!.sweep(reconcile)).toBe(0)
        expect(yield* base.get(key)).toBeInstanceOf(Uint8Array)
        yield* test.advance("2 hours")
        expect(yield* tier!.sweep(true)).toBe(1)
        expect(yield* sql`SELECT * FROM actor_cold_garbage`).toEqual([])
        expect(Exit.isFailure(yield* base.get(key).pipe(Effect.exit))).toBe(true)
      }).pipe(Effect.scoped),
    ))

  it("protects an aged unflipped upload throughout retry, then reconciles it only after a wake removes the cold obligation", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = ColdStorage.memory()
        const store = {
          ...base,
          list: (prefix: string) =>
            base.list(prefix).pipe(Stream.map((object) => ({ ...object, createdAtMs: 0 }))),
        }
        const { ledger, tier, test, sql, pointer } = yield* openCold(yield* database, store, {
          periodic: false,
          at: (point) =>
            point === "afterUpload" ? Effect.die(new Error("lost before flip")) : Effect.void,
        })
        const actor = yield* ledger("orphan")
        yield* actor.Seed()
        yield* test.hibernate(actor.ref)
        yield* test.advance(2)
        const [object] = yield* store.list("").pipe(Stream.runCollect)
        expect(object).toBeDefined()
        expect((yield* pointer("orphan")).cold_ref).toBeNull()
        yield* sql`UPDATE actor_outbox SET attempts = 12 WHERE kind = 'cold'`
        expect(yield* tier!.sweep(true)).toBe(0)
        expect(yield* sql`SELECT count(*)::int AS n FROM actor_cold_garbage`).toEqual([{ n: 0 }])
        expect(yield* base.get(object!.key)).toBeInstanceOf(Uint8Array)
        expect(yield* actor.Add(5)).toBe(22)
        expect(yield* tier!.sweep(true)).toBe(1)
        expect(yield* sql`SELECT count(*)::int AS n FROM actor_cold_garbage`).toEqual([{ n: 0 }])
        expect(yield* base.list("").pipe(Stream.runCollect)).toHaveLength(0)
        expect(yield* actor.Read()).toEqual({
          total: 22,
          untouched: 43,
          first: "A|BC",
          second: "DZ",
        })
      }).pipe(Effect.scoped),
    ))

  it.each(["check", "delete", "unknown"] as const)(
    "retains the candidate on a failed %s and confirms absence on retry",
    (failure) =>
      harness.runPromise(
        Effect.gen(function* () {
          const base = ColdStorage.memory()
          const url = yield* database
          const checker = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: Redacted.value(url), max: 1 })),
            (pool) => Effect.promise(() => pool.end()),
          )
          let broken = false
          let deleted = 0
          const store = {
            ...base,
            delete: (key: string) =>
              Effect.gen(function* () {
                deleted++
                if (broken && failure === "delete")
                  return yield* new ColdStorageError({ cause: new Error("DELETE failed") })
                yield* base.delete(key)
                if (broken && failure === "unknown")
                  return yield* new ColdStorageError({ cause: new Error("reply lost") })
              }),
          }
          const { cold, pointer, tier, sql } = yield* openCold(url, store, {
            periodic: false,
            at: (point): Effect.Effect<void> =>
              Effect.suspend(() => {
                if (point !== "beforeGarbageCheck" || failure !== "check" || !broken)
                  return Effect.void
                return Effect.promise(() => checker.query("SELECT 1 / 0")).pipe(Effect.asVoid)
              }),
          })
          const actor = yield* cold("failure")
          const key = (yield* pointer("failure")).cold_ref!
          yield* actor.Add(9)
          yield* sql`UPDATE actor_cold_garbage SET unreferenced_at_ms = 0`
          broken = true
          expect(yield* tier!.sweep()).toBe(0)
          expect(yield* sql`SELECT object_key FROM actor_cold_garbage`).toEqual([
            { object_key: key },
          ])
          if (failure === "check") {
            expect(deleted).toBe(0)
          }
          broken = false
          expect(yield* tier!.sweep()).toBe(1)
          expect(yield* sql`SELECT * FROM actor_cold_garbage`).toEqual([])
          expect(Exit.isFailure(yield* base.get(key).pipe(Effect.exit))).toBe(true)
        }).pipe(Effect.scoped),
      ),
  )
})
