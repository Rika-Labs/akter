import type { CheckOptions, CheckReport, StorageUnavailable } from "@rikalabs/akter/server"
import {
  Config,
  Console,
  Context,
  DateTime,
  Effect,
  type FileSystem,
  Option,
  type Path,
  Redacted,
  Schema,
} from "effect"
import { Command, Flag } from "effect/cli"

import { version } from "../../../package.json" with { type: "json" }
import { CommandFailed, fail } from "../../failure.ts"

/** Where the check runs and how to reach it; the credentials never leave this value except into the S3 client. */
export type CheckTarget =
  | {
      readonly kind: "s3"
      readonly bucket: string
      readonly endpoint: string | undefined
      readonly region: string | undefined
      readonly prefix: string
      readonly credentials:
        | {
            readonly accessKeyId: string
            readonly secretAccessKey: string
            readonly sessionToken: string | undefined
          }
        | undefined
    }
  | { readonly kind: "fileSystem"; readonly directory: string }

type Runner = (
  target: CheckTarget,
  options: CheckOptions,
) => Effect.Effect<CheckReport, StorageUnavailable, FileSystem.FileSystem | Path.Path>

/**
 * How `storage check` reaches the framework's probe. The default opens the
 * bucket or directory and runs the probe without creating a store in it; a
 * test provides another runner to put a failing property in front of the
 * command.
 */
export const StorageCheck = Context.Reference<Runner>("akter/cli/StorageCheck", {
  defaultValue: () => (target, options) =>
    Effect.flatMap(
      Effect.promise(() => import("@rikalabs/akter/server")),
      ({ Store }) =>
        target.kind === "s3"
          ? Effect.scoped(
              Store.checkS3(
                {
                  bucket: target.bucket,
                  endpoint: target.endpoint,
                  region: target.region,
                  prefix: target.prefix,
                  credentials: target.credentials,
                },
                options,
              ),
            )
          : Effect.scoped(Store.checkFileSystem(target.directory, options)),
    ),
})

const fromEnvironment = (names: ReadonlyArray<string>) =>
  names
    .slice(1)
    .reduce(
      (config, name) => config.pipe(Config.orElse(() => Config.String(name))),
      Config.String(names[0] ?? ""),
    )
    .pipe(Config.option)

const secretFromEnvironment = (names: ReadonlyArray<string>) =>
  names
    .slice(1)
    .reduce(
      (config, name) => config.pipe(Config.orElse(() => Config.Redacted(name))),
      Config.Redacted(names[0] ?? ""),
    )
    .pipe(Config.option)

const positive = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    Flag.optional,
    Flag.withDescription(description),
  )

const flags = {
  bucket: Flag.String("bucket").pipe(
    Flag.optional,
    Flag.withDescription("The S3-compatible bucket to check (default AKTER_STORAGE_BUCKET)"),
  ),
  endpoint: Flag.String("endpoint").pipe(
    Flag.optional,
    Flag.withDescription(
      "The S3 endpoint URL, without credentials (default AKTER_STORAGE_ENDPOINT or AWS_ENDPOINT_URL_S3)",
    ),
  ),
  region: Flag.String("region").pipe(
    Flag.optional,
    Flag.withDescription(
      "The bucket's region (default AKTER_STORAGE_REGION or AWS_REGION, then us-east-1)",
    ),
  ),
  prefix: Flag.String("prefix").pipe(
    Flag.optional,
    Flag.withDescription("A key prefix inside the bucket (default AKTER_STORAGE_PREFIX)"),
  ),
  directory: Flag.String("directory").pipe(
    Flag.optional,
    Flag.withDescription("Check a local directory with the file-system store instead of a bucket"),
  ),
  writers: positive("writers", "Concurrent writers in each race round (default 16)"),
  rounds: positive("rounds", "Rounds of each race and of the listing probe (default 10)"),
  writes: positive("writes", "Back-to-back writes to one key in the write-rate probe (default 10)"),
  settle: Flag.Int("settle-ms").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.optional,
    Flag.withDescription(
      "Milliseconds between the two identical writes of the last-modified probe (default 2000); it must exceed the provider's timestamp resolution, one second on S3",
    ),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the report as JSON"),
  ),
}

const sentence = (failure: StorageUnavailable) =>
  `${failure.operation} ${failure.key}${failure.status === undefined ? "" : ` (HTTP ${failure.status})`}: ${failure.reason}`

/**
 * `akter storage check`: runs the framework's conformance probe against one
 * bucket or directory and prints each probe's verdict and measured numbers.
 * Credentials come from the environment only, are never printed, and are
 * removed from any provider message before it is shown.
 */
export const storageCheckCommand = Command.make("check", flags, (options) =>
  Effect.gen(function* () {
    const environment = yield* Effect.all({
      bucket: fromEnvironment(["AKTER_STORAGE_BUCKET"]),
      endpoint: fromEnvironment([
        "AKTER_STORAGE_ENDPOINT",
        "AWS_ENDPOINT_URL_S3",
        "AWS_ENDPOINT_URL",
      ]),
      region: fromEnvironment(["AKTER_STORAGE_REGION", "AWS_REGION", "AWS_DEFAULT_REGION"]),
      prefix: fromEnvironment(["AKTER_STORAGE_PREFIX"]),
      accessKeyId: fromEnvironment(["AKTER_STORAGE_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"]),
      secretAccessKey: secretFromEnvironment([
        "AKTER_STORAGE_SECRET_ACCESS_KEY",
        "AWS_SECRET_ACCESS_KEY",
      ]),
      sessionToken: secretFromEnvironment(["AKTER_STORAGE_SESSION_TOKEN", "AWS_SESSION_TOKEN"]),
    })
    const secrets = [environment.secretAccessKey, environment.sessionToken].flatMap((secret) =>
      Option.isSome(secret) && Redacted.value(secret.value) !== ""
        ? [Redacted.value(secret.value)]
        : [],
    )
    const scrub = (text: string) =>
      secrets.reduce((clean, secret) => clean.replaceAll(secret, "[redacted]"), text)
    const usage = (message: string) => fail({ reason: "UsageError", message, exitCode: 2 })

    if (Option.isSome(options.directory) && Option.isSome(options.bucket))
      return yield* usage("Name either --bucket or --directory, not both.")

    const bucket = Option.orElse(options.bucket, () => environment.bucket)
    if (Option.isNone(options.directory) && Option.isNone(bucket))
      return yield* usage(
        "Name the bucket with --bucket or AKTER_STORAGE_BUCKET, or a directory with --directory.",
      )

    const endpoint = Option.getOrUndefined(
      Option.orElse(options.endpoint, () => environment.endpoint),
    )
    const url = endpoint === undefined ? undefined : URL.parse(endpoint)
    if (endpoint !== undefined && url === null) return yield* usage("The endpoint is not a URL.")
    if (url !== undefined && url !== null && (url.username !== "" || url.password !== ""))
      return yield* usage(
        "The endpoint must not carry credentials; set AKTER_STORAGE_ACCESS_KEY_ID and AKTER_STORAGE_SECRET_ACCESS_KEY.",
      )

    if (Option.isSome(environment.accessKeyId) !== Option.isSome(environment.secretAccessKey))
      return yield* usage(
        "Set both the access key id and the secret access key, or neither to use the AWS credential chain.",
      )

    const prefix = Option.getOrElse(
      Option.orElse(options.prefix, () => environment.prefix),
      () => "",
    )
    const target: CheckTarget = Option.isSome(options.directory)
      ? { kind: "fileSystem", directory: options.directory.value }
      : {
          kind: "s3",
          bucket: Option.getOrElse(bucket, () => ""),
          endpoint,
          region: Option.getOrUndefined(Option.orElse(options.region, () => environment.region)),
          prefix: prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`,
          credentials:
            Option.isSome(environment.accessKeyId) && Option.isSome(environment.secretAccessKey)
              ? {
                  accessKeyId: environment.accessKeyId.value,
                  secretAccessKey: Redacted.value(environment.secretAccessKey.value),
                  sessionToken: Option.map(environment.sessionToken, Redacted.value).pipe(
                    Option.getOrUndefined,
                  ),
                }
              : undefined,
        }

    const run = yield* StorageCheck
    const report = yield* run(target, {
      ...(Option.isSome(options.writers) && { writers: options.writers.value }),
      ...(Option.isSome(options.rounds) && { rounds: options.rounds.value }),
      ...(Option.isSome(options.writes) && { writes: options.writes.value }),
      ...(Option.isSome(options.settle) && { settle: options.settle.value }),
    }).pipe(
      Effect.catchTag("StorageUnavailable", (failure) =>
        fail({
          reason: "StorageUnavailable",
          message: scrub(`The storage check could not run: ${sentence(failure)}`),
          exitCode: 2,
        }),
      ),
    )

    const where =
      target.kind === "s3"
        ? {
            kind: "s3",
            bucket: target.bucket,
            endpoint: url === undefined || url === null ? null : url.origin,
            region: target.region ?? "us-east-1",
            prefix: target.prefix,
          }
        : { kind: "fileSystem", directory: target.directory }
    const checkedAt = DateTime.formatIso(yield* DateTime.now)
    const failed = report.probes.filter((probe) => !probe.passed)

    if (options.json)
      yield* Console.log(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          cli: version,
          checkedAt,
          target: where,
          passed: report.passed,
          probes: report.probes,
        }),
      )
    else {
      yield* Console.log(
        `akter storage check ${version}, ${checkedAt}\nTarget: ${
          where.kind === "s3"
            ? `S3 bucket ${where.bucket}${where.prefix === "" ? "" : `, prefix ${where.prefix}`}${where.endpoint === null ? "" : `, endpoint ${where.endpoint}`}, region ${where.region}`
            : `directory ${where.directory}`
        }\nThe probe writes under check/ and removes what it wrote.\n`,
      )
      for (const probe of report.probes)
        yield* Console.log(
          `${probe.passed ? "PASS" : "FAIL"}  ${probe.name} (${probe.measured.elapsedMillis ?? 0} ms)\n      ${probe.detail}`,
        )
      yield* Console.log(
        report.passed
          ? `\nPassed: all ${report.probes.length} probes.`
          : `\nFailed: ${failed.map((probe) => probe.name).join(", ")}. A store needs every one of these properties.`,
      )
    }

    if (!report.passed) return yield* CommandFailed.make({ exitCode: 1, reason: "ProbeFailed" })
  }),
).pipe(
  Command.withDescription(
    "Run the storage conformance probe against a bucket or directory; exit 1 when a required property fails",
  ),
)

/** The `akter storage` commands. */
export const storageCommand = Command.make("storage").pipe(
  Command.withDescription("Check that a bucket or directory can hold an Akter store"),
  Command.withSubcommands([storageCheckCommand]),
)
