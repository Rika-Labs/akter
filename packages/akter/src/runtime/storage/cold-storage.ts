import { Clock, Data, Effect, FileSystem, Option, Path, Stream } from "effect"

/** A failed object operation, including an unknown upload or deletion outcome. */
export class ColdStorageError extends Data.TaggedError("ColdStorageError")<{
  readonly cause: unknown
}> {}

/** An immutable object's key and creation time, used only as an orphan retention bound. */
export interface ColdObject {
  readonly key: string
  readonly createdAtMs: number
}

/**
 * Private deployment object storage. `put` creates a key once and returns
 * false if it already exists; a retry must verify the existing bytes.
 * `delete` succeeds only when absence is confirmed. Listing is paginated,
 * and failures never mean an empty object or a successful deletion.
 */
export interface ColdStorage {
  readonly get: (key: string) => Effect.Effect<Uint8Array, ColdStorageError>
  readonly put: (key: string, bytes: Uint8Array) => Effect.Effect<boolean, ColdStorageError>
  readonly delete: (key: string) => Effect.Effect<void, ColdStorageError>
  readonly list: (prefix: string) => Stream.Stream<ColdObject, ColdStorageError>
}

const storageError = (cause: unknown) => new ColdStorageError({ cause })

/** A deterministic create-only store for local tests; copies bytes at both boundaries. */
const memory = (): ColdStorage => {
  const objects = new Map<string, { readonly bytes: Uint8Array; readonly createdAtMs: number }>()

  return {
    get: (key) =>
      Effect.suspend(() => {
        const object = objects.get(key)

        return object === undefined
          ? Effect.fail(storageError(new Error(`Missing cold object ${key}`)))
          : Effect.succeed(Uint8Array.from(object.bytes))
      }),
    put: Effect.fnUntraced(function* (key, bytes) {
      const createdAtMs = yield* Clock.currentTimeMillis
      if (objects.has(key)) return false
      objects.set(key, { bytes: Uint8Array.from(bytes), createdAtMs })

      return true
    }),
    delete: (key) => Effect.sync(() => void objects.delete(key)),
    list: (prefix) =>
      Stream.suspend(() =>
        Stream.fromIterable(
          [...objects].flatMap(([key, object]) =>
            key.startsWith(prefix) ? [{ key, createdAtMs: object.createdAtMs }] : [],
          ),
        ),
      ),
  }
}

/**
 * Local disk storage. A fully written temporary file is linked atomically
 * into its create-only name, so process death cannot publish partial bytes.
 * The directory is private to the runtime; never let untrusted users place
 * symlinks in it. This adapter does not replace a replicated object store.
 */
const filesystem = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const root = paths.resolve(directory)
  const path = (key: string) =>
    Effect.try({
      try: () => {
        const target = paths.resolve(root, key)

        if (target === root || !target.startsWith(`${root}${paths.sep}`))
          throw new Error("Cold object key escapes its storage directory")

        return target
      },
      catch: storageError,
    })

  const walk = (directory: string): Stream.Stream<ColdObject, ColdStorageError> =>
    Stream.fromEffect(
      fs.readDirectory(directory).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
        Effect.mapError(storageError),
      ),
    ).pipe(
      Stream.flatMap(Stream.fromIterable),
      Stream.filter((entry) => !entry.startsWith(".tmp-")),
      Stream.flatMap((entry) => {
        const file = paths.join(directory, entry)
        return Stream.fromEffect(fs.stat(file).pipe(Effect.mapError(storageError))).pipe(
          Stream.flatMap((info) => {
            if (info.type === "Directory") return walk(file)
            if (info.type === "File")
              return Stream.succeed({
                key: paths.relative(root, file).split(paths.sep).join("/"),
                createdAtMs: Option.getOrThrow(info.mtime).getTime(),
              })
            return Stream.empty
          }),
        )
      }),
    )

  return {
    get: (key) =>
      path(key).pipe(
        Effect.flatMap((file) => fs.readFile(file).pipe(Effect.mapError(storageError))),
      ),
    put: (key, bytes) =>
      Effect.scoped(
        Effect.gen(function* () {
          const target = yield* path(key)
          yield* fs.makeDirectory(paths.dirname(target), { recursive: true })
          const temporary = paths.join(
            yield* fs.makeTempDirectoryScoped({
              directory: paths.dirname(target),
              prefix: ".tmp-",
            }),
            "object",
          )
          yield* fs.writeFile(temporary, bytes, { flag: "wx" })
          return yield* fs.link(temporary, target).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
          )
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof ColdStorageError ? error : storageError(error),
        ),
      ),
    delete: (key) =>
      path(key).pipe(
        Effect.flatMap((file) =>
          fs.remove(file, { force: true }).pipe(Effect.mapError(storageError)),
        ),
      ),
    list: (prefix) => walk(root).pipe(Stream.filter(({ key }) => key.startsWith(prefix))),
  } satisfies ColdStorage
})

/** Object-storage adapters for runtime-only cold state, never tenant content. */
export const ColdStorage = { memory, filesystem }
