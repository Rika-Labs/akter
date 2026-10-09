import { link, mkdir, opendir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import { Data, Effect, Predicate, Stream } from "effect"

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
const codeIs = (cause: unknown, code: string) =>
  Predicate.hasProperty(cause, "code") && cause.code === code

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
    put: (key, bytes) =>
      Effect.sync(() => {
        if (objects.has(key)) return false
        objects.set(key, { bytes: Uint8Array.from(bytes), createdAtMs: Date.now() })

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
const filesystem = (directory: string): ColdStorage => {
  const root = resolve(directory)
  const path = (key: string) => {
    const target = resolve(root, key)

    if (target === root || !target.startsWith(`${root}${sep}`))
      throw new Error("Cold object key escapes its storage directory")

    return target
  }

  const walk = async function* (directory: string): AsyncGenerator<ColdObject> {
    const entries = await opendir(directory).catch((cause: unknown) => {
      if (codeIs(cause, "ENOENT")) return undefined
      throw cause
    })

    if (entries === undefined) return

    for await (const entry of entries) {
      if (entry.name.startsWith(".tmp-")) continue
      const file = join(directory, entry.name)

      if (entry.isDirectory()) yield* walk(file)
      else if (entry.isFile())
        yield {
          key: relative(root, file).split(sep).join("/"),
          createdAtMs: (await stat(file)).mtimeMs,
        }
    }
  }

  return {
    get: (key) => Effect.tryPromise({ try: () => readFile(path(key)), catch: storageError }),
    put: (key, bytes) =>
      Effect.tryPromise({
        try: async () => {
          const target = path(key)
          await mkdir(dirname(target), { recursive: true })
          const temporary = join(dirname(target), `.tmp-${randomUUID()}`)

          try {
            await writeFile(temporary, bytes, { flag: "wx" })
            try {
              await link(temporary, target)

              return true
            } catch (cause) {
              if (codeIs(cause, "EEXIST")) return false
              throw cause
            }
          } finally {
            await unlink(temporary).catch((cause: unknown) => {
              if (!codeIs(cause, "ENOENT")) throw cause
            })
          }
        },
        catch: storageError,
      }),
    delete: (key) =>
      Effect.tryPromise({
        try: () =>
          unlink(path(key)).catch((cause: unknown) => {
            if (!codeIs(cause, "ENOENT")) throw cause
          }),
        catch: storageError,
      }),
    list: (prefix) =>
      Stream.fromAsyncIterable(walk(root), storageError).pipe(
        Stream.filter(({ key }) => key.startsWith(prefix)),
      ),
  }
}

/** S3-compatible credentials, endpoint, bucket, and deployment encryption settings. */
export interface S3ColdStorageOptions extends S3ClientConfig {
  readonly bucket: string
  /** Omitted, use the bucket's configured encryption. */
  readonly encryption?: "AES256" | "aws:kms"
  readonly encryptionKey?: string
}

/**
 * Uses conditional S3 writes and the SDK's signed, cancellable requests.
 * Configure `endpoint` and `forcePathStyle` for a compatible private store.
 * The caller owns the bucket's replication, encryption, and prefix-scoped
 * credentials; neither a public URL nor client credentials are exposed.
 */
const s3 = ({
  bucket,
  encryption,
  encryptionKey,
  ...config
}: S3ColdStorageOptions): ColdStorage => {
  const client = new S3Client({ maxAttempts: 1, ...config })
  const objects = async function* (prefix: string): AsyncGenerator<ColdObject> {
    let continuation: string | undefined

    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuation,
        }),
      )

      for (const object of page.Contents ?? [])
        if (object.Key !== undefined && object.LastModified !== undefined)
          yield { key: object.Key, createdAtMs: object.LastModified.getTime() }

      continuation = page.IsTruncated ? page.NextContinuationToken : undefined

      if (page.IsTruncated && continuation === undefined)
        throw new Error("Truncated cold object listing has no continuation token")
    } while (continuation !== undefined)
  }

  return {
    get: (key) =>
      Effect.tryPromise({
        try: async (abortSignal) => {
          const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
            abortSignal,
          })

          if (object.Body === undefined) throw new Error(`Missing body for cold object ${key}`)

          return object.Body.transformToByteArray()
        },
        catch: storageError,
      }),
    put: (key, bytes) =>
      Effect.tryPromise({
        try: async (abortSignal) => {
          try {
            await client.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: bytes,
                IfNoneMatch: "*",
                ServerSideEncryption: encryption,
                SSEKMSKeyId: encryptionKey,
              }),
              { abortSignal },
            )

            return true
          } catch (cause) {
            if (Predicate.hasProperty(cause, "name") && cause.name === "PreconditionFailed")
              return false
            throw cause
          }
        },
        catch: storageError,
      }),
    delete: (key) =>
      Effect.tryPromise({
        try: (abortSignal) =>
          client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal }),
        catch: storageError,
      }).pipe(Effect.asVoid),
    list: (prefix) => Stream.fromAsyncIterable(objects(prefix), storageError),
  }
}

/** Object-storage adapters for runtime-only cold state, never tenant content. */
export const ColdStorage = { memory, filesystem, s3 }
