import { Effect, Option } from "effect"
import { type Bucket, Condition, type ListOptions, type Listed } from "./bucket.ts"

interface Stored {
  readonly body: Uint8Array<ArrayBuffer>
  readonly etag: string
}

/**
 * A bucket in process memory with S3's conditional-write semantics: every
 * operation completes atomically, a conditional write that does not hold
 * changes nothing, and every write gets a fresh etag. Bytes are copied in and
 * out, so callers can reuse their buffers.
 */
export const memoryBucket = (): Bucket => {
  const objects = new Map<string, Stored>()
  let version = 0

  const store = (key: string, body: Uint8Array) => {
    version += 1
    const etag = `"${version.toString(16)}"`
    objects.set(key, { body: Uint8Array.from(body), etag })
    return etag
  }

  const keysUnder = (prefix: string, options: ListOptions = {}) => {
    const keys: Array<string> = []
    for (const key of objects.keys())
      if (key.startsWith(prefix) && (options.startAfter === undefined || key > options.startAfter))
        keys.push(key)
    keys.sort()
    return options.limit === undefined ? keys : keys.slice(0, options.limit)
  }

  return {
    get: (key) =>
      Effect.sync(() =>
        Option.map(Option.fromNullishOr(objects.get(key)), (object) => object.body.slice()),
      ),
    exists: (key) => Effect.sync(() => objects.has(key)),
    create: (key, body) =>
      Effect.sync(() => {
        if (objects.has(key)) return false
        store(key, body)
        return true
      }),
    put: (key, body) =>
      Effect.sync(() => {
        store(key, body)
      }),
    list: (prefix, options) => Effect.sync(() => keysUnder(prefix, options)),
    delete: (keys) =>
      Effect.sync(() => {
        for (const key of keys) objects.delete(key)
      }),
    leases: {
      read: (key) =>
        Effect.sync(() =>
          Option.map(Option.fromNullishOr(objects.get(key)), (object) => ({
            body: object.body.slice(),
            etag: object.etag,
          })),
        ),
      write: (key, body, condition) =>
        Effect.sync(() => {
          const current = objects.get(key)
          const holds = Condition.$match(condition, {
            Absent: () => current === undefined,
            Matches: ({ etag }) => current?.etag === etag,
            Always: () => true,
          })
          return holds ? Option.some(store(key, body)) : Option.none()
        }),
      list: (prefix) =>
        Effect.sync(() =>
          keysUnder(prefix).map((key): Listed => ({ key, etag: objects.get(key)?.etag ?? "" })),
        ),
      remove: (key) =>
        Effect.sync(() => {
          objects.delete(key)
        }),
    },
  }
}
