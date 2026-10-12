import { CreateBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { describe, expect, it } from "@effect/vitest"
import { Config, Effect, Predicate, Random, Schema } from "effect"
import { runCliWith } from "../../testing.ts"

/**
 * `TEST_S3_URL` names an S3-compatible endpoint, its credentials and a bucket
 * as `http://<access key>:<secret>@<host>:<port>/<bucket>`, such as the MinIO
 * service in `packages/akter/compose.yaml`; each test checks under a fresh key
 * prefix in the bucket, which is created if missing.
 */
const target = Effect.gen(function* () {
  const url = new URL(yield* Config.String("TEST_S3_URL"))
  const options = {
    endpoint: `${url.protocol}//${url.host}`,
    bucket: url.pathname.replace(/^\/+|\/+$/gu, ""),
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
  }
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new S3Client({
          region: "us-east-1",
          endpoint: options.endpoint,
          forcePathStyle: true,
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }),
    ),
    (opened) => Effect.sync(() => opened.destroy()),
  )
  yield* Effect.tryPromise(() =>
    client.send(new CreateBucketCommand({ Bucket: options.bucket })),
  ).pipe(
    Effect.catchIf(
      (error) =>
        Predicate.hasProperty(error.cause, "name") &&
        (error.cause.name === "BucketAlreadyOwnedByYou" ||
          error.cause.name === "BucketAlreadyExists"),
      () => Effect.void,
    ),
  )
  const keysUnder = (prefix: string) =>
    Effect.tryPromise(() =>
      client.send(new ListObjectsV2Command({ Bucket: options.bucket, Prefix: prefix })),
    ).pipe(Effect.map((page) => (page.Contents ?? []).map((object) => object.Key ?? "")))
  return { ...options, keysUnder }
})

const probeNames = [
  "conditional create race",
  "compare-and-swap race",
  "list after write",
  "overwrite refreshes last-modified",
  "per-key write rate",
  "batch delete",
]

const Report = Schema.Struct({
  target: Schema.Struct({
    kind: Schema.String,
    bucket: Schema.String,
    endpoint: Schema.NullOr(Schema.String),
    region: Schema.String,
    prefix: Schema.String,
  }),
  passed: Schema.Boolean,
  probes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      passed: Schema.Boolean,
      measured: Schema.Record(Schema.String, Schema.Finite),
    }),
  ),
})

const freshPrefix = Effect.map(
  Effect.all([Random.nextIntBetween(0, 0xffff_ffff), Random.nextIntBetween(0, 0xffff_ffff)]),
  ([high, low]) => `cli-${high.toString(16)}-${low.toString(16)}/`,
)

describe("akter storage check on an S3-compatible bucket (TEST_S3_URL)", () => {
  it.live(
    "passes every probe against the bucket with credentials from the AKTER_STORAGE_* variables, exits 0, leaves nothing behind and prints no secret (rejects a check that opens a store, or leaves probe objects)",
    () =>
      Effect.gen(function* () {
        const s3 = yield* target
        const prefix = yield* freshPrefix

        const text = yield* runCliWith({
          env: {
            AKTER_STORAGE_BUCKET: s3.bucket,
            AKTER_STORAGE_ENDPOINT: s3.endpoint,
            AKTER_STORAGE_PREFIX: prefix.slice(0, -1),
            AKTER_STORAGE_ACCESS_KEY_ID: s3.accessKeyId,
            AKTER_STORAGE_SECRET_ACCESS_KEY: s3.secretAccessKey,
          },
        })(["storage", "check", "--writers", "8", "--rounds", "4", "--writes", "4"])

        expect(text.exitCode).toBe(0)
        expect(text.stderr).toBe("")
        expect(text.stdout).toContain(
          `Target: S3 bucket ${s3.bucket}, prefix ${prefix}, endpoint ${s3.endpoint}, region us-east-1`,
        )
        for (const name of probeNames)
          expect(text.stdout).toMatch(new RegExp(`^PASS  ${name} \\(\\d+ ms\\)$`, "m"))
        expect(text.stdout).toContain("8 writers x 4 rounds: 0 rounds with two successful creators")
        expect(text.stdout).toContain("Passed: all 6 probes.")
        expect(text.stdout + text.stderr).not.toContain(s3.secretAccessKey)
        expect(yield* s3.keysUnder(prefix)).toEqual([])
      }),
  )

  it.live(
    "takes the bucket and endpoint from flags and the credentials and region from the AWS_* variables, and prints a JSON report that carries no secret",
    () =>
      Effect.gen(function* () {
        const s3 = yield* target
        const prefix = yield* freshPrefix

        const machine = yield* runCliWith({
          env: {
            AWS_ACCESS_KEY_ID: s3.accessKeyId,
            AWS_SECRET_ACCESS_KEY: s3.secretAccessKey,
            AWS_REGION: "us-east-1",
          },
        })([
          "storage",
          "check",
          "--bucket",
          s3.bucket,
          "--endpoint",
          s3.endpoint,
          "--prefix",
          prefix,
          "--writers",
          "8",
          "--rounds",
          "4",
          "--writes",
          "4",
          "--json",
        ])
        const report = yield* Schema.decodeEffect(Schema.fromJsonString(Report))(machine.stdout)

        expect(machine.exitCode).toBe(0)
        expect(report.passed).toBe(true)
        expect(report.target).toEqual({
          kind: "s3",
          bucket: s3.bucket,
          endpoint: s3.endpoint,
          region: "us-east-1",
          prefix,
        })
        expect(report.probes.map((probe) => probe.name)).toEqual(probeNames)
        const modified = report.probes.find(
          (probe) => probe.name === "overwrite refreshes last-modified",
        )
        expect(modified?.measured.settleMillis).toBe(2000)
        expect(modified?.measured.advancedMillis).toBeGreaterThanOrEqual(1000)
        expect(machine.stdout + machine.stderr).not.toContain(s3.secretAccessKey)
        expect(yield* s3.keysUnder(prefix)).toEqual([])
      }),
  )

  it.live(
    "exits 2 and prints neither the wrong secret nor a probe verdict when the credentials are refused",
    () =>
      Effect.gen(function* () {
        const s3 = yield* target
        const wrong = "synthetic-wrong-secret"

        const refused = yield* runCliWith({
          env: {
            AKTER_STORAGE_BUCKET: s3.bucket,
            AKTER_STORAGE_ENDPOINT: s3.endpoint,
            AKTER_STORAGE_ACCESS_KEY_ID: s3.accessKeyId,
            AKTER_STORAGE_SECRET_ACCESS_KEY: wrong,
          },
        })(["storage", "check", "--rounds", "1", "--writes", "1"])

        expect(refused.exitCode).toBe(2)
        expect(refused.reason).toBe("StorageUnavailable")
        expect(refused.stderr).toContain("The storage check could not run:")
        expect(refused.stdout + refused.stderr).not.toContain(wrong)
        expect(refused.stdout).not.toMatch(/PASS|FAIL/)
      }),
  )
})
