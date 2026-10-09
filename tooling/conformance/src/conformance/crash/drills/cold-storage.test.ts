import { BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, Exit, FileSystem, ManagedRuntime, Schema, Stream } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { Actor } from "../../../../../../packages/akter/src/index.ts"
import { ColdStorage } from "../../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { disposableDatabase } from "../../../../../../packages/akter/src/testing/database.ts"
import { openCold } from "../../postgres/cold-tier.ts"
import { minio } from "./cold-storage.ts"

const runtime = ManagedRuntime.make(BunServices.layer)
afterAll(() => runtime.dispose())

describe("S3-compatible cold objects with MinIO and Postgres", () => {
  it(
    "creates immutable objects, paginates, rejects bad credentials, survives a GET outage, and measures complete cold wakes",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const { store, config, bucket, docker, id } = yield* minio()
          const bytes = new Uint8Array([83, 6, 19])
          const created = yield* Effect.all(
            [store.put("adapter/one", bytes), store.put("adapter/one", new Uint8Array([92]))],
            { concurrency: 2 },
          )
          expect(created.filter(Boolean)).toHaveLength(1)
          expect([...(yield* store.get("adapter/one"))]).toEqual(created[0] ? [83, 6, 19] : [92])
          expect(yield* store.put("adapter/one", new Uint8Array([0]))).toBe(false)
          yield* Effect.forEach(
            Array.from({ length: 1003 }, (_, index) => `pagination/${index}`),
            (key) => store.put(key, bytes),
            { concurrency: 16, discard: true },
          )
          const objects = yield* store.list("pagination/").pipe(Stream.runCollect)
          expect(new Set(objects.map(({ key }) => key)).size).toBe(1003)
          expect(objects.every(({ createdAtMs }) => createdAtMs > 0)).toBe(true)
          yield* store.delete("adapter/one")
          yield* store.delete("adapter/one")
          expect(Exit.isFailure(yield* store.get("adapter/one").pipe(Effect.exit))).toBe(true)
          const denied = yield* ColdStorage.s3({
            ...config,
            bucket,
            credentials: { accessKeyId: "denied", secretAccessKey: "invalid-test-key" },
          })
          expect(Exit.isFailure(yield* denied.get("pagination/0").pipe(Effect.exit))).toBe(true)

          const { cold, pointer, test, ledger, sql } = yield* openCold(
            yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") }),
            store,
          )
          const actor = yield* cold("outage")
          const before = yield* pointer("outage")
          const [seed] = yield* sql<{ command_id: string }>`SELECT command_id FROM actor_receipts
            WHERE actor_id = 'outage' AND command = 'Seed'`
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(docker(["pause", id]), () =>
                Effect.ignore(docker(["unpause", id])),
              )
              expect(yield* actor.Seed().pipe(Actor.commandId(seed!.command_id))).toBe(17)
              const replayed = yield* pointer("outage")
              expect(replayed.cold_ref).toBe(before.cold_ref)
              expect((yield* actor.Read().pipe(Effect.flip)).reason._tag).toBe("ActorUnavailable")
              expect(yield* pointer("outage")).toEqual(replayed)
              expect(yield* sql`SELECT count(*)::int AS n FROM actor_state`).toEqual([{ n: 0 }])
              expect(yield* sql`SELECT count(*)::int AS n FROM actor_blobs`).toEqual([{ n: 0 }])
            }),
          )
          expect(yield* actor.Add(7)).toBe(24)
          expect(yield* actor.Read()).toEqual({
            total: 24,
            untouched: 43,
            first: "A|BC",
            second: "DZ",
          })

          const measurements = { plain: [] as number[], cold: [] as number[], get: [] as number[] }
          for (let index = 0; index < 30; index++) {
            const coldActor = yield* cold(`cold-${index}`)
            const plainActor = yield* ledger(`plain-${index}`)
            yield* plainActor.Seed()
            yield* test.hibernate(plainActor.ref)
            const key = (yield* pointer(`cold-${index}`)).cold_ref!
            const getStarted = performance.now()
            yield* store.get(key)
            const getMs = performance.now() - getStarted
            const plainStarted = performance.now()
            expect(yield* plainActor.Add(7)).toBe(24)
            const plainMs = performance.now() - plainStarted
            const coldStarted = performance.now()
            expect(yield* coldActor.Add(7)).toBe(24)
            const coldMs = performance.now() - coldStarted
            expect(yield* coldActor.Read()).toEqual({
              total: 24,
              untouched: 43,
              first: "A|BC",
              second: "DZ",
            })
            expect((yield* pointer(`cold-${index}`)).cold_ref).toBeNull()
            if (index >= 5) {
              measurements.get.push(getMs)
              measurements.plain.push(plainMs)
              measurements.cold.push(coldMs)
            }
          }
          expect(
            yield* sql`SELECT count(*)::int AS n FROM actor_generations WHERE cold_ref IS NOT NULL`,
          ).toEqual([{ n: 0 }])
          const quantiles = (values: number[]) => {
            const sorted = values.toSorted((left, right) => left - right)
            return {
              samples: sorted.length,
              p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
              p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
              p99: sorted[Math.ceil(sorted.length * 0.99) - 1]!,
            }
          }
          const result = {
            plain: quantiles(measurements.plain),
            cold: quantiles(measurements.cold),
            get: quantiles(measurements.get),
          }
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(".amp/in/artifacts", { recursive: true })
          yield* fs.writeFileString(
            ".amp/in/artifacts/cold-wake-local.json",
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(result),
          )
          yield* Console.log("COLD_WAKE_LOCAL_MS", result)
        }).pipe(Effect.scoped, Effect.timeout("90 seconds")),
      ),
    120_000,
  )
})
