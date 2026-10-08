import { BunCrypto, BunHttpServer, BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, ManagedRuntime, Redacted } from "effect"
import type { ConformanceBackend } from "../../conformance.ts"

const harness = ManagedRuntime.make(BunFileSystem.layer)

/** Closes the runtime that creates and removes the PGlite data directories. */
export const disposePgliteBackend = () => harness.dispose()

/** A file-backed PGlite database per case, copied on demand for the restore cases. */
export const pgliteBackend: ConformanceBackend = {
  independentConnections: false,
  freshDatabases: true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dataDir = yield* fs.makeTempDirectory({ prefix: "akter-pglite-" })
        const copies: Array<string> = []

        return {
          database: { dataDir },
          freshDatabase: Effect.succeed({}),
          copy: (database) =>
            Effect.gen(function* () {
              if (
                Redacted.isRedacted(database) ||
                !("dataDir" in database) ||
                database.dataDir === undefined
              )
                return yield* Effect.die(new Error("Only a file-backed PGlite database is copied"))

              const copied = yield* fs.makeTempDirectory({ prefix: "akter-restored-" })
              copies.push(copied)
              yield* fs.copy(database.dataDir, `${copied}/data`)

              return { dataDir: `${copied}/data` }
            }).pipe(Effect.orDie),
          close: Effect.suspend(() =>
            Effect.forEach([dataDir, ...copies], (path) =>
              fs.remove(path, { recursive: true }).pipe(Effect.ignore),
            ),
          ),
        }
      }),
    ),
}
