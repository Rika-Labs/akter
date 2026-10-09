import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, FileSystem, ManagedRuntime, Stream } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { ColdStorage } from "./cold-storage.ts"

const runtime = ManagedRuntime.make(BunServices.layer)
afterAll(() => runtime.dispose())

describe("immutable cold object adapters", () => {
  it.each(["memory", "filesystem"] as const)(
    "publishes exactly one complete concurrent upload with %s",
    (kind) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(".amp/in", { recursive: true })
          const root = yield* fs.makeTempDirectoryScoped({
            directory: ".amp/in",
            prefix: "cold-storage-",
          })
          const store =
            kind === "memory" ? ColdStorage.memory() : yield* ColdStorage.filesystem(root)
          const first = new Uint8Array([31, 7, 18])
          const second = new Uint8Array([44, 90])
          const created = yield* Effect.all(
            [store.put("one/a", first), store.put("one/a", second)],
            { concurrency: 2 },
          )
          expect(created.filter(Boolean)).toHaveLength(1)
          const expected = created[0] ? [31, 7, 18] : [44, 90]
          first.fill(0)
          second.fill(0)
          const fetched = yield* store.get("one/a")
          expect([...fetched]).toEqual(expected)
          fetched.fill(0)
          expect([...(yield* store.get("one/a"))]).toEqual(expected)
          expect(yield* store.put("one/a", new Uint8Array([255]))).toBe(false)
          yield* store.put("two/b", new Uint8Array([11]))
          expect((yield* store.list("one/").pipe(Stream.runCollect)).map(({ key }) => key)).toEqual(
            ["one/a"],
          )
          yield* store.delete("one/a")
          yield* store.delete("one/a")
          expect(Exit.isFailure(yield* store.get("one/a").pipe(Effect.exit))).toBe(true)
          expect((yield* store.list("").pipe(Stream.runCollect)).map(({ key }) => key)).toEqual([
            "two/b",
          ])
          if (kind === "filesystem") {
            for (const key of ["../escape", ".", "/outside"])
              expect(
                Exit.isFailure(yield* store.put(key, new Uint8Array([9])).pipe(Effect.exit)),
              ).toBe(true)
          }
        }).pipe(Effect.scoped),
      ),
  )
})
