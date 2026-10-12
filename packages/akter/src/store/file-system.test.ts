import { Context, Effect, FileSystem, Layer } from "effect"
import { storeConformance } from "../../../../tooling/conformance/src/conformance/store.ts"
import { fileSystemBucket } from "./file-system.ts"

const platform =
  globalThis.Bun === undefined
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer

storeConformance({
  name: "the file system",
  namespace: Effect.flatMap(Layer.build(platform), (services) =>
    Effect.map(
      Context.get(services, FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "akter-store-",
      }),
      (directory) => fileSystemBucket(directory).pipe(Effect.provide(services)),
    ),
  ),
})
