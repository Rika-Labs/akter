import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import { Effect, Option, Predicate, Stream } from "effect"
import { ColdStorageError, type ColdStorage } from "../runtime/storage/cold-storage.ts"

/** S3-compatible credentials, endpoint, bucket, and deployment encryption settings. */
export interface S3ColdStorageOptions extends S3ClientConfig {
  readonly bucket: string
  /** Omitted, use the bucket's configured encryption. */
  readonly encryption?: "AES256" | "aws:kms"
  readonly encryptionKey?: string
}

const storageError = (cause: unknown) => new ColdStorageError({ cause })

/**
 * Uses conditional S3 writes and the SDK's signed, cancellable requests.
 * Configure `endpoint` and `forcePathStyle` for a compatible private store.
 * The caller owns the bucket's replication, encryption, and prefix-scoped
 * credentials; neither a public URL nor client credentials are exposed.
 */
const make = Effect.fnUntraced(function* ({
  bucket,
  encryption,
  encryptionKey,
  ...config
}: S3ColdStorageOptions) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new S3Client({ maxAttempts: 1, ...config })),
    (client) => Effect.sync(() => client.destroy()),
  )

  return {
    get: (key) =>
      Effect.scoped(
        Effect.gen(function* () {
          const controller = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          )
          const object = yield* Effect.tryPromise({
            try: () =>
              client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
                abortSignal: controller.signal,
              }),
            catch: storageError,
          })
          const body = object.Body
          if (body === undefined)
            return yield* storageError(new Error(`Missing body for cold object ${key}`))
          return yield* Effect.tryPromise({
            try: () => body.transformToByteArray(),
            catch: storageError,
          })
        }),
      ),
    put: (key, bytes) =>
      Effect.tryPromise({
        try: (abortSignal) =>
          client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: bytes,
              IfNoneMatch: "*",
              ServerSideEncryption: encryption,
              SSEKMSKeyId: encryptionKey,
            }),
            { abortSignal },
          ),
        catch: storageError,
      }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) =>
            Predicate.hasProperty(error.cause, "name") && error.cause.name === "PreconditionFailed",
          () => Effect.succeed(false),
        ),
      ),
    delete: (key) =>
      Effect.tryPromise({
        try: (abortSignal) =>
          client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal }),
        catch: storageError,
      }).pipe(Effect.asVoid),
    list: (prefix) =>
      Stream.paginate(
        undefined as string | undefined,
        Effect.fnUntraced(function* (continuation) {
          const page = yield* Effect.tryPromise({
            try: (abortSignal) =>
              client.send(
                new ListObjectsV2Command({
                  Bucket: bucket,
                  Prefix: prefix,
                  ContinuationToken: continuation,
                }),
                { abortSignal },
              ),
            catch: storageError,
          })
          if (page.IsTruncated === true && page.NextContinuationToken === undefined)
            return yield* storageError(
              new Error("Truncated cold object listing has no continuation token"),
            )
          const objects = (page.Contents ?? []).flatMap((object) =>
            object.Key !== undefined && object.LastModified !== undefined
              ? [{ key: object.Key, createdAtMs: object.LastModified.getTime() }]
              : [],
          )
          return [
            objects,
            page.IsTruncated === true ? Option.some(page.NextContinuationToken) : Option.none(),
          ] as const
        }),
      ),
  } satisfies ColdStorage
})

/** Import separately so runtimes without S3 cold storage do not load its SDK. */
export const S3ColdStorage = { make }
