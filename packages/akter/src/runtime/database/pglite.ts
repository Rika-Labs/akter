import { PGlite } from "@electric-sql/pglite"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect } from "effect"
import { DataDirLocked, DataDirVersion } from "../../errors/database.ts"
import { flockExclusive } from "./flock.ts"

/**
 * The Postgres major the pinned PGlite embeds. Postgres cannot open a data
 * directory another major wrote, so a PGlite upgrade across a major must
 * change this, and a test checks it against what a fresh directory records.
 */
export const POSTGRES_MAJOR = "18"

/** The lock file inside a data directory; the kernel drops its lock when the holder dies. */
export const LOCK_FILE = ".akter.lock"

/** A filesystem data directory, or undefined for an in-memory database. */
const directoryOf = (dataDir: string | undefined) => {
  if (dataDir === undefined || dataDir.startsWith("memory://")) return undefined

  return dataDir.startsWith("file://") ? dataDir.slice("file://".length) : dataDir
}

/** Holds an exclusive lock on the directory's lock file for the scope, so a second instance, in this process or another, never opens PGlite. */
const lockDataDir = (directory: string) =>
  Effect.gen(function* () {
    if (!(yield* flockExclusive(`${directory}/${LOCK_FILE}`)))
      return yield* DataDirLocked.make({ dataDir: directory })
  })

/** Refuses a directory another Postgres major wrote before PGlite fails on it opaquely. */
const checkVersion = (directory: string) =>
  Effect.gen(function* () {
    const found = yield* Effect.promise(() =>
      import("node:fs/promises").then(({ readFile }) =>
        readFile(`${directory}/PG_VERSION`, "utf8").then(
          (text) => text.trim(),
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined

            throw error
          },
        ),
      ),
    )

    if (found !== undefined && found !== POSTGRES_MAJOR)
      return yield* DataDirVersion.make({ dataDir: directory, found, expected: POSTGRES_MAJOR })
  })

/**
 * A PGlite client layer that owns fresh instances; a borrowed `liveClient`
 * keeps its original methods and lifetime. A file-backed instance holds its
 * data directory's lock from before it opens until after it closes, refuses a
 * directory another Postgres major wrote, and refuses `relaxedDurability`
 * because it acknowledges a commit before its WAL is written, so a crash
 * could lose a turn whose receipt the caller already has. Closing waits for
 * in-flight queries: interrupted SQL fibers can leave protocol exchanges
 * running, and closing PGlite during one deadlocks its single connection.
 */
export const pglite = (config: PgliteClient.PgliteClientConfig = {}) => {
  if ("liveClient" in config) return PgliteClient.layer(config)

  const directory = directoryOf(config.dataDir)

  return PgliteClient.layerFrom(
    Effect.gen(function* () {
      if (directory !== undefined) {
        if (config.relaxedDurability === true)
          return yield* Effect.die(
            new Error("A file-backed PGlite database refuses relaxedDurability"),
          )

        yield* lockDataDir(directory)
        yield* checkVersion(directory)
      }

      const pending = new Set<Promise<unknown>>()

      const database = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const database = new PGlite(config)
          const query = database.query.bind(database)
          database.query = (...args) => {
            const promise = (query as (...a: typeof args) => Promise<never>)(...args)
            pending.add(promise)

            return promise.finally(() => pending.delete(promise))
          }

          return database
        }),
        (database) =>
          Effect.gen(function* () {
            while (pending.size > 0) yield* Effect.promise(() => Promise.allSettled(pending))
            yield* Effect.promise(() => database.close())
          }),
      )

      yield* Effect.promise(() => database.waitReady)

      return yield* PgliteClient.make({ ...config, liveClient: database })
    }),
  )
}
