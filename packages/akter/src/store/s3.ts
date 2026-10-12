import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import { Effect, Option, Predicate } from "effect"
import { type Bucket, Condition, type Listed, type ListOptions } from "./bucket.ts"
import { StoreUnavailable } from "./errors.ts"

/** Where the store's bucket is and how to reach it. */
export interface S3Options {
  readonly bucket: string
  /** An S3-compatible endpoint such as R2, Tigris or MinIO; path-style addressing is used with it. */
  readonly endpoint?: string
  /** Defaults to `us-east-1`, which R2 and MinIO accept. */
  readonly region?: string
  /** Static keys or a provider that refreshes temporary ones; defaults to the SDK's credential chain. */
  readonly credentials?: S3ClientConfig["credentials"]
  /** Prepended to every key, so stores can share one bucket. */
  readonly prefix?: string
}

/** Keys per `DeleteObjects` request, the S3 maximum. */
const DELETE_BATCH = 1000

/**
 * Milliseconds one request may take before the SDK abandons it. A bound on
 * request time is part of the trim safety margin: a write sent by a paused
 * owner cannot land arbitrarily late.
 */
const REQUEST_TIMEOUT = 30_000

const PRECONDITION_FAILED = 412

const NOT_FOUND = 404

const statusOf = (cause: unknown) =>
  Predicate.hasProperty(cause, "$metadata") &&
  Predicate.hasProperty(cause.$metadata, "httpStatusCode") &&
  Predicate.isNumber(cause.$metadata.httpStatusCode)
    ? cause.$metadata.httpStatusCode
    : undefined

/**
 * A bucket on an S3-compatible service through the AWS SDK, used as the
 * request signer. Conditional writes are `If-None-Match: *` and `If-Match`;
 * a 412 is a condition that did not hold. A 409 (a concurrent conditional
 * write on AWS) and every other failure is `StoreUnavailable`, with an unknown
 * outcome for writes. Checksums are sent and validated only where the API
 * requires them, which R2 needs, and no server-side encryption headers are
 * sent: the bucket's default encryption applies.
 */
export const s3Bucket = Effect.fnUntraced(function* (options: S3Options) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new S3Client({
          region: options.region ?? "us-east-1",
          endpoint: options.endpoint,
          forcePathStyle: options.endpoint !== undefined,
          credentials: options.credentials,
          maxAttempts: 1,
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
          requestHandler: { requestTimeout: REQUEST_TIMEOUT },
        }),
    ),
    (opened) => Effect.sync(() => opened.destroy()),
  )
  const prefix = options.prefix ?? ""
  const Bucket = options.bucket

  /**
   * Sends one request. An idempotent one is sent again, once and at once, when
   * its connection was reset before any response: a server may close a
   * keep-alive connection right after a response without saying so, as MinIO
   * RELEASE.2025-09-07 does after a 412 to a conditional PUT, and the next
   * request on it fails.
   * The SDK would resend these itself, but its retries are off so that the
   * store's schedule governs every other repeat, and a write is never resent
   * here because its outcome is unknown.
   */
  const call = <A>(
    operation: string,
    key: string,
    run: (signal: AbortSignal) => Promise<A>,
    resend: "idempotent" | "never" = "never",
  ): Effect.Effect<A, StoreUnavailable> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => ({
        reset:
          statusOf(cause) === undefined &&
          Predicate.hasProperty(cause, "code") &&
          cause.code === "ECONNRESET",
        error: StoreUnavailable.make({
          operation,
          key,
          status: statusOf(cause),
          reason:
            Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
              ? cause.message
              : String(cause),
        }),
      }),
    }).pipe(
      Effect.retry({ times: resend === "idempotent" ? 1 : 0, while: (failure) => failure.reset }),
      Effect.mapError((failure) => failure.error),
    )

  /** Turns the given status into a value instead of a failure. */
  const recover =
    <B>(status: number, value: () => B) =>
    <A>(effect: Effect.Effect<A, StoreUnavailable>): Effect.Effect<A | B, StoreUnavailable> =>
      Effect.catchIf(
        effect,
        (error) => error.status === status,
        () => Effect.sync(value),
      )

  const read = (key: string) =>
    call(
      "get",
      key,
      (abortSignal) =>
        client.send(new GetObjectCommand({ Bucket, Key: `${prefix}${key}` }), { abortSignal }),
      "idempotent",
    ).pipe(
      Effect.flatMap((object) => {
        const body = object.Body
        if (body === undefined)
          return Effect.fail(
            StoreUnavailable.make({ operation: "get", key, reason: "the response has no body" }),
          )
        return call("get", key, () => body.transformToByteArray()).pipe(
          Effect.map((bytes) =>
            Option.some({ body: Uint8Array.from(bytes), etag: object.ETag ?? "" }),
          ),
        )
      }),
      recover(NOT_FOUND, () =>
        Option.none<{ readonly body: Uint8Array<ArrayBuffer>; readonly etag: string }>(),
      ),
    )

  const put = (operation: string, key: string, body: Uint8Array, condition: Condition) =>
    call(operation, key, (abortSignal) =>
      client.send(
        new PutObjectCommand({
          Bucket,
          Key: `${prefix}${key}`,
          Body: body,
          ContentLength: body.length,
          IfNoneMatch: Condition.$is("Absent")(condition) ? "*" : undefined,
          IfMatch: Condition.$is("Matches")(condition) ? condition.etag : undefined,
        }),
        { abortSignal },
      ),
    ).pipe(
      Effect.map((output) => Option.some(output.ETag ?? "")),
      recover(PRECONDITION_FAILED, () => Option.none<string>()),
    )

  const listed = (listPrefix: string, options: ListOptions = {}) =>
    Effect.gen(function* () {
      const found: Array<Listed> = []
      let continuation: string | undefined
      do {
        const remaining = options.limit === undefined ? undefined : options.limit - found.length
        const page = yield* call(
          "list",
          listPrefix,
          (abortSignal) =>
            client.send(
              new ListObjectsV2Command({
                Bucket,
                Prefix: `${prefix}${listPrefix}`,
                StartAfter:
                  continuation === undefined && options.startAfter !== undefined
                    ? `${prefix}${options.startAfter}`
                    : undefined,
                ContinuationToken: continuation,
                MaxKeys: remaining === undefined ? undefined : Math.min(remaining, 1000),
              }),
              { abortSignal },
            ),
          "idempotent",
        )
        for (const object of page.Contents ?? [])
          if (object.Key !== undefined)
            found.push({ key: object.Key.slice(prefix.length), etag: object.ETag ?? "" })
        continuation = page.IsTruncated === true ? page.NextContinuationToken : undefined
        if (page.IsTruncated === true && continuation === undefined)
          return yield* StoreUnavailable.make({
            operation: "list",
            key: listPrefix,
            reason: "a truncated listing has no continuation token",
          })
      } while (
        continuation !== undefined &&
        (options.limit === undefined || found.length < options.limit)
      )
      return found
    })

  const bucket: Bucket = {
    get: (key) =>
      Effect.map(
        read(key),
        Option.map((object) => object.body),
      ),
    exists: (key) =>
      call(
        "exists",
        key,
        (abortSignal) =>
          client.send(new HeadObjectCommand({ Bucket, Key: `${prefix}${key}` }), { abortSignal }),
        "idempotent",
      ).pipe(
        Effect.as(true),
        recover(NOT_FOUND, () => false),
      ),
    create: (key, body) => Effect.map(put("create", key, body, Condition.Absent()), Option.isSome),
    put: (key, body) => Effect.asVoid(put("put", key, body, Condition.Always())),
    list: (listPrefix, options) =>
      Effect.map(listed(listPrefix, options), (objects) => objects.map((object) => object.key)),
    delete: (keys) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(keys.length / DELETE_BATCH) }, (_, index) =>
          keys.slice(index * DELETE_BATCH, (index + 1) * DELETE_BATCH),
        ),
        (batch) =>
          call(
            "delete",
            batch[0] ?? "",
            (abortSignal) =>
              client.send(
                new DeleteObjectsCommand({
                  Bucket,
                  Delete: {
                    Objects: batch.map((key) => ({ Key: `${prefix}${key}` })),
                    Quiet: true,
                  },
                }),
                { abortSignal },
              ),
            "idempotent",
          ).pipe(
            Effect.flatMap((output) => {
              const failed = output.Errors?.[0]
              return failed === undefined
                ? Effect.void
                : Effect.fail(
                    StoreUnavailable.make({
                      operation: "delete",
                      key: (failed.Key ?? "").slice(prefix.length),
                      reason: `${failed.Code ?? "Error"}: ${failed.Message ?? "the key was not deleted"}`,
                    }),
                  )
            }),
          ),
        { discard: true },
      ),
    leases: {
      read,
      write: (key, body, condition) => put("lease.write", key, body, condition),
      list: (leasePrefix) => listed(leasePrefix),
      remove: (key) =>
        call(
          "lease.remove",
          key,
          (abortSignal) =>
            client.send(new DeleteObjectCommand({ Bucket, Key: `${prefix}${key}` }), {
              abortSignal,
            }),
          "idempotent",
        ).pipe(Effect.asVoid),
    },
  }
  return bucket
})
