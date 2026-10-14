import { Context, Effect, FileSystem, Layer } from "effect"
import { engineConformance } from "../../../../tooling/conformance/src/conformance/engine.ts"
import { jobConformance } from "../../../../tooling/conformance/src/conformance/jobs.ts"
import { pageConformance } from "../../../../tooling/conformance/src/conformance/pages.ts"
import { storeConformance } from "../../../../tooling/conformance/src/conformance/store.ts"
import { operatorConformance } from "../../../../tooling/conformance/src/conformance/operators.ts"
import { retentionConformance } from "../../../../tooling/conformance/src/conformance/retention.ts"
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

const engineBackend = {
  name: "the file system",
  location: Effect.flatMap(Layer.build(platform), (services) =>
    Effect.map(
      Context.get(services, FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "akter-engine-",
      }),
      (directory) => ({
        bucket: fileSystemBucket(directory).pipe(Effect.provide(services)),
        env: { AKTER_CONFORMANCE_DIRECTORY: directory },
      }),
    ),
  ),
}

engineConformance(engineBackend)
jobConformance(engineBackend)
operatorConformance(engineBackend)
pageConformance(engineBackend)

retentionConformance({
  name: "the file system",
  namespace: Effect.map(engineBackend.location, ({ bucket }) => bucket),
})
