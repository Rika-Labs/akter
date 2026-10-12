import { Effect, FileSystem, Option, Path, type PlatformError, Random } from "effect"
import { type Bucket, Condition, type ListOptions, type Listed, type Versioned } from "./bucket.ts"
import { StoreUnavailable } from "./errors.ts"

const TEMPORARY = ".tmp-"

const VERSIONS = ".v"

const VERSION = /^[0-9a-f]{16}$/u

/** Attempts a lease read or write makes when concurrent writers keep moving the latest version. */
const LEASE_ATTEMPTS = 16

const hex16 = (value: number) => value.toString(16).padStart(16, "0")

/**
 * A bucket in a local directory, for `akter dev` and tests; several processes
 * may share the directory. An object is the file at its key's path. Every
 * write lands in a temporary file opened with `O_EXCL` and synced, then
 * becomes visible in one step: a hard link for a create-once write, which
 * fails if the name exists, and a rename for a plain write. Readers never see
 * partial bytes, and a crash leaves at most an ignored temporary. Directories
 * are synced where the platform allows opening them.
 *
 * A lease object is a directory `<key>.v` of numbered versions, each created
 * once; its etag is the latest version number. A conditional write creates
 * the next number, so of two writers that saw the same version exactly one
 * succeeds, across processes and without locks. Deleting writes an empty
 * version, so a deleted lease cannot be revived by a stale etag.
 */
export const fileSystemBucket = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const root = paths.resolve(directory)
  yield* fs
    .makeDirectory(root, { recursive: true })
    .pipe(
      Effect.mapError((error) =>
        StoreUnavailable.make({ operation: "open", key: root, reason: error.message }),
      ),
    )

  const failure = (operation: string, key: string) => (error: PlatformError.PlatformError) =>
    StoreUnavailable.make({ operation, key, reason: error.message })

  const pathOf = (key: string) => {
    const target = paths.resolve(root, ...key.split("/"))
    if (target === root || !target.startsWith(`${root}${paths.sep}`))
      return Effect.die(new RangeError(`Object key ${key} escapes the store directory`))
    return Effect.succeed(target)
  }

  const syncDirectory = (path: string) =>
    Effect.scoped(Effect.flatMap(fs.open(path, { flag: "r" }), (file) => file.sync)).pipe(
      Effect.ignore,
    )

  /** Writes `body` to a fresh synced file beside `target` and hands its path to `publish`. */
  const staged = <A>(
    target: string,
    body: Uint8Array,
    publish: (temporary: string) => Effect.Effect<A, PlatformError.PlatformError>,
  ): Effect.Effect<A, PlatformError.PlatformError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = paths.dirname(target)
        yield* fs.makeDirectory(parent, { recursive: true })
        const temporary = paths.join(
          parent,
          `${TEMPORARY}${hex16(yield* Random.nextIntBetween(0, 0xffff_ffff))}${hex16(yield* Random.nextIntBetween(0, 0xffff_ffff))}`,
        )
        yield* Effect.addFinalizer(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(temporary, { flag: "wx" })
            yield* file.writeAll(body)
            yield* file.sync
          }),
        )
        const result = yield* publish(temporary)
        yield* syncDirectory(parent)
        return result
      }),
    )

  const createAt = (target: string, body: Uint8Array) =>
    staged(target, body, (temporary) =>
      fs.link(temporary, target).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      ),
    )

  const readAt = (target: string) =>
    fs.readFile(target).pipe(
      Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    )

  const entries = (directory: string) =>
    fs
      .readDirectory(directory)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<Array<string>>([])),
      )

  /** Keys of every object (or, with `leases`, every lease directory) under `directory`. */
  const walk = (
    directory: string,
    leases: boolean,
    found: Array<string>,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      for (const name of yield* entries(directory)) {
        if (name.startsWith(TEMPORARY)) continue
        const full = paths.join(directory, name)
        if (name.endsWith(VERSIONS)) {
          if (leases)
            found.push(
              paths.relative(root, full).split(paths.sep).join("/").slice(0, -VERSIONS.length),
            )
          continue
        }
        const info = yield* fs.stat(full).pipe(Effect.option)
        if (Option.isNone(info)) continue
        if (info.value.type === "Directory") yield* walk(full, leases, found)
        else if (!leases && info.value.type === "File")
          found.push(paths.relative(root, full).split(paths.sep).join("/"))
      }
    })

  const keysUnder = (prefix: string, leases: boolean, options: ListOptions = {}) =>
    Effect.gen(function* () {
      const base = prefix.slice(0, prefix.lastIndexOf("/") + 1)
      const found: Array<string> = []
      yield* walk(
        base === "" ? root : paths.resolve(root, ...base.split("/").filter(Boolean)),
        leases,
        found,
      )
      const keys: Array<string> = []
      for (const key of found)
        if (
          key.startsWith(prefix) &&
          (options.startAfter === undefined || key > options.startAfter)
        )
          keys.push(key)
      keys.sort()
      return options.limit === undefined ? keys : keys.slice(0, options.limit)
    })

  const versionsOf = (key: string) =>
    Effect.gen(function* () {
      const directory = `${yield* pathOf(key)}${VERSIONS}`
      const numbers: Array<string> = []
      for (const name of yield* entries(directory)) if (VERSION.test(name)) numbers.push(name)
      numbers.sort()
      return { directory, numbers }
    })

  /** The latest version of a lease and whether it is live; an empty version is a deletion. */
  const latest = (key: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt++) {
        const { directory, numbers } = yield* versionsOf(key)
        const last = numbers.at(-1)
        if (last === undefined) return { directory, number: 0, body: Option.none<Uint8Array>() }
        const body = yield* readAt(paths.join(directory, last))
        if (Option.isNone(body)) continue
        return {
          directory,
          number: Number.parseInt(last, 16),
          body: body.value.length === 0 ? Option.none<Uint8Array>() : body,
        }
      }
      return yield* Effect.die(new Error(`Lease ${key} kept changing while it was read`))
    })

  const writeLease = (key: string, body: Uint8Array, condition: Condition) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt++) {
        const current = yield* latest(key)
        const holds = Condition.$match(condition, {
          Absent: () => Option.isNone(current.body),
          Matches: ({ etag }) =>
            Option.isSome(current.body) && etag === `"${hex16(current.number)}"`,
          Always: () => true,
        })
        if (!holds) return Option.none<string>()
        const next = current.number + 1
        const created = yield* createAt(paths.join(current.directory, hex16(next)), body)
        if (created) {
          const { directory, numbers } = yield* versionsOf(key)
          for (const number of numbers)
            if (Number.parseInt(number, 16) < next - 1)
              yield* fs.remove(paths.join(directory, number), { force: true }).pipe(Effect.ignore)
          return Option.some(`"${hex16(next)}"`)
        }
        if (!Condition.$is("Always")(condition)) return Option.none<string>()
      }
      return yield* Effect.die(new Error(`Lease ${key} kept changing while it was written`))
    })

  const bucket: Bucket = {
    get: (key) => pathOf(key).pipe(Effect.flatMap(readAt), Effect.mapError(failure("get", key))),
    exists: (key) =>
      pathOf(key).pipe(
        Effect.flatMap((path) => fs.exists(path)),
        Effect.mapError(failure("exists", key)),
      ),
    create: (key, body) =>
      pathOf(key).pipe(
        Effect.flatMap((target) => createAt(target, body)),
        Effect.mapError(failure("create", key)),
      ),
    put: (key, body) =>
      pathOf(key).pipe(
        Effect.flatMap((target) =>
          staged(target, body, (temporary) => fs.rename(temporary, target)),
        ),
        Effect.mapError(failure("put", key)),
      ),
    list: (prefix, options) =>
      keysUnder(prefix, false, options).pipe(Effect.mapError(failure("list", prefix))),
    delete: (keys) =>
      Effect.forEach(
        keys,
        (key) =>
          pathOf(key).pipe(
            Effect.flatMap((path) => fs.remove(path, { force: true })),
            Effect.mapError(failure("delete", key)),
          ),
        { discard: true },
      ),
    leases: {
      read: (key) =>
        latest(key).pipe(
          Effect.map((current) =>
            Option.map(current.body, (body): Versioned => ({
              body,
              etag: `"${hex16(current.number)}"`,
            })),
          ),
          Effect.mapError(failure("lease.read", key)),
        ),
      write: (key, body, condition) =>
        body.length === 0
          ? Effect.die(new RangeError("A lease body cannot be empty"))
          : writeLease(key, body, condition).pipe(Effect.mapError(failure("lease.write", key))),
      list: (prefix) =>
        Effect.gen(function* () {
          const listed: Array<Listed> = []
          for (const key of yield* keysUnder(prefix, true)) {
            const current = yield* latest(key)
            if (Option.isSome(current.body))
              listed.push({ key, etag: `"${hex16(current.number)}"` })
          }
          return listed
        }).pipe(Effect.mapError(failure("lease.list", prefix))),
      remove: (key) =>
        writeLease(key, new Uint8Array(0), Condition.Always()).pipe(
          Effect.asVoid,
          Effect.mapError(failure("lease.remove", key)),
        ),
    },
  }
  return bucket
})
