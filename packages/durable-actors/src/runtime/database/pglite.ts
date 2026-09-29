import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { dlopen, FFIType } from "bun:ffi"
import { PGlite } from "@electric-sql/pglite"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect } from "effect"
import { DataDirLocked, DataDirVersion } from "../../errors/database.ts"

/**
 * The Postgres major the pinned PGlite embeds. Postgres cannot open a data
 * directory another major wrote, so a PGlite upgrade across a major must
 * change this, and a test checks it against what a fresh directory records.
 */
export const POSTGRES_MAJOR = "18"

/** The lock file inside a data directory; the kernel drops its lock when the holder dies. */
export const LOCK_FILE = ".durable-actors.lock"

const LOCK_EX = 2

const LOCK_NB = 4

let libc: { readonly flock: (fd: number, operation: number) => number } | undefined

// PGlite takes no lock of its own, and two instances on one directory both
// open it and write. An exclusive flock is released by the kernel when the
// holder dies, even by SIGKILL, so a crash leaves nothing to clean up.
const flock = (fd: number, operation: number) => {
  libc ??= dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols

  return libc.flock(fd, operation)
}

/** A filesystem data directory, or undefined for an in-memory database. */
const directoryOf = (dataDir: string | undefined) => {
  if (dataDir === undefined || dataDir.startsWith("memory://")) return undefined

  return dataDir.startsWith("file://") ? dataDir.slice("file://".length) : dataDir
}

const lockDataDir = (directory: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      if (process.platform !== "linux" && process.platform !== "darwin")
        return yield* Effect.die(
          new Error(`A file-backed PGlite database needs flock, which ${process.platform} lacks`),
        )

      const fd = yield* Effect.sync(() => {
        mkdirSync(directory, { recursive: true })

        return openSync(join(directory, LOCK_FILE), "a")
      })

      if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
        closeSync(fd)

        return yield* new DataDirLocked({ dataDir: directory })
      }

      return fd
    }),
    (fd) => Effect.sync(() => closeSync(fd)),
  )

/** Refuses a directory another Postgres major wrote before PGlite fails on it opaquely. */
const checkVersion = (directory: string) =>
  Effect.gen(function* () {
    const file = join(directory, "PG_VERSION")

    if (!existsSync(file)) return

    const found = readFileSync(file, "utf8").trim()

    if (found !== POSTGRES_MAJOR)
      return yield* new DataDirVersion({ dataDir: directory, found, expected: POSTGRES_MAJOR })
  })

/**
 * Own fresh instances; borrowed clients retain their original methods and
 * lifetime. A file-backed instance holds its data directory's lock from
 * before it opens until after it closes.
 */
export const pglite = (config: PgliteClient.PgliteClientConfig = {}) => {
  if ("liveClient" in config) return PgliteClient.layer(config)

  const directory = directoryOf(config.dataDir)

  return PgliteClient.layerFrom(
    Effect.gen(function* () {
      if (directory !== undefined) {
        // Relaxed durability acknowledges a commit before its WAL is written,
        // so a crash could lose a turn whose receipt the caller already has.
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
          // Interrupted SQL fibers can leave protocol exchanges running. Closing
          // PGlite during one deadlocks its single connection; drain after users stop.
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
