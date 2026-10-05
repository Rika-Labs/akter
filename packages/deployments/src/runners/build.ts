import { Context, Duration, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** One line of a build's output. */
export interface BuildLine {
  readonly stream: "stdout" | "stderr"
  readonly text: string
}

/**
 * What to build: the tag the image gets, the build arguments it is built
 * with, and, for a deployment whose context was uploaded, that context as a
 * gzip-compressed tar with the path of its Dockerfile inside it. Without
 * `source` the builder builds its own configured context.
 */
export interface BuildInput {
  readonly tag: string
  readonly buildArgs: Readonly<Record<string, string>>
  readonly source?: {
    readonly archive: Uint8Array
    readonly dockerfile: string
  }
}

/** A built image: the local image id a runner starts from, and the build's last lines of output. */
export interface BuiltImage {
  readonly imageId: string
  readonly log: ReadonlyArray<BuildLine>
}

/**
 * The build did not produce an image. `reason` ends with the build's last
 * line of output, which names the error; `retryable` is true only when the
 * builder itself could not be reached or read.
 */
export class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {
  reason: Schema.String,
  retryable: Schema.Boolean,
}) {}

/** Builds deployment images where no external build system reports them. */
export class ImageBuilds extends Context.Service<
  ImageBuilds,
  { readonly build: (input: BuildInput) => Effect.Effect<BuiltImage, BuildFailed> }
>()("@akter/deployments/runners/build/ImageBuilds") {}

/** The most output lines a build keeps, the last ones, which hold the result or the error. */
const LOG_LINES = 400

const ImageId = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))

const isImageId = Schema.is(ImageId)

/**
 * Where a local build reads its source: the build `context` directory and the
 * `dockerfile` path inside it. `platform` defaults to `linux/arm64`, the
 * architecture the local runners start with, which is not the hosted
 * architecture (linux/amd64). A build that runs longer than
 * `timeout` (default 15 minutes) is stopped and fails. An uploaded context
 * may unpack to at most `maxContextBytes` (default 512 MiB) in at most
 * `maxContextEntries` tar entries (default 100,000).
 */
export interface DockerBuildOptions {
  readonly context: string
  readonly dockerfile: string
  readonly platform?: string
  readonly binary?: string
  readonly timeout?: Duration.Input
  readonly maxContextBytes?: number
  readonly maxContextEntries?: number
}

const BLOCK = 512

/** The size an entry's tar header records: octal ASCII, or base-256 when its first byte has the high bit set. */
const entrySize = (header: Uint8Array) => {
  const field = header.subarray(124, 136)

  if ((field[0]! & 0x80) !== 0)
    return field.subarray(1).reduce((size, byte) => size * 256 + byte, field[0]! & 0x7f)

  const digits = new TextDecoder()
    .decode(field)
    .replace(/[\0 ]+$/u, "")
    .trim()

  return /^[0-7]+$/u.test(digits) ? Number.parseInt(digits, 8) : Number.NaN
}

/** Whether a tar header's checksum, the byte sum with its own field read as spaces, matches the one it records. */
const checksumMatches = (header: Uint8Array) => {
  const recorded = Number.parseInt(
    new TextDecoder()
      .decode(header.subarray(148, 156))
      .replace(/[\0 ]+$/u, "")
      .trim(),
    8,
  )
  const sum = header.reduce(
    (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
    0,
  )

  return recorded === sum
}

/**
 * Walks an uploaded context's tar headers as it decompresses, without
 * keeping its contents, and fails before Docker sees it when it is not a
 * gzip-compressed tar or unpacks past `limits`. A context's compressed size
 * says nothing about what it unpacks to.
 */
const checkContext = (
  archive: Uint8Array,
  limits: { readonly bytes: number; readonly entries: number },
) => {
  const refused = (reason: string) => BuildFailed.make({ reason, retryable: false })
  const state = { bytes: 0, entries: 0, skip: 0, filled: 0, ended: false }
  const header = new Uint8Array(BLOCK)

  const read = (chunk: Uint8Array) => {
    state.bytes += chunk.byteLength
    if (state.bytes > limits.bytes)
      return Effect.fail(refused(`The build context unpacks to more than ${limits.bytes} bytes`))

    let offset = 0

    while (offset < chunk.byteLength) {
      if (state.skip > 0) {
        const skipped = Math.min(state.skip, chunk.byteLength - offset)
        state.skip -= skipped
        offset += skipped
        continue
      }

      const taken = Math.min(BLOCK - state.filled, chunk.byteLength - offset)
      header.set(chunk.subarray(offset, offset + taken), state.filled)
      state.filled += taken
      offset += taken

      if (state.filled < BLOCK) continue

      state.filled = 0

      if (header.every((byte) => byte === 0)) {
        state.ended = true
        continue
      }

      if (state.ended || !checksumMatches(header))
        return Effect.fail(refused("The build context is not a tar archive"))

      state.entries += 1
      if (state.entries > limits.entries)
        return Effect.fail(refused(`The build context holds more than ${limits.entries} entries`))

      const size = entrySize(header)

      if (!Number.isSafeInteger(size) || size > limits.bytes)
        return Effect.fail(refused(`The build context unpacks to more than ${limits.bytes} bytes`))

      state.skip = Math.ceil(size / BLOCK) * BLOCK
    }

    return Effect.void
  }

  return Stream.fromReadableStream({
    evaluate: () =>
      new Blob([new Uint8Array(archive)]).stream().pipeThrough(new DecompressionStream("gzip")),
    onError: () => refused("The build context is not a gzip-compressed tar archive"),
  }).pipe(
    Stream.runForEach(read),
    Effect.flatMap(() =>
      state.ended && state.skip === 0 && state.filled === 0
        ? Effect.void
        : Effect.fail(refused("The build context is not a complete tar archive")),
    ),
  )
}

/** The last `LOG_LINES` non-empty lines of one output stream, kept as they arrive. */
const tail = <E>(output: Stream.Stream<Uint8Array, E>, stream: BuildLine["stream"]) =>
  output.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runFold(
      () => new Array<BuildLine>(),
      (kept, text) => {
        if (text.trim() === "") return kept
        kept.push({ stream, text })
        if (kept.length > LOG_LINES) kept.shift()
        return kept
      },
    ),
  )

/**
 * `ImageBuilds` over the local Docker CLI with BuildKit, for the development
 * stack and tests; hosted images are built and pushed by CI. An uploaded
 * context is `docker build -`'s stdin as its tar, where `--file` names a
 * path inside it, after its headers are walked against the context limits.
 * It reaches stdin from a private temporary file that the shell redirects,
 * never through a pipe this process writes: a Docker CLI that exits without
 * reading its context would otherwise break that pipe, and Bun reports the
 * failed write as an uncaught exception that no caller can handle.
 * A build is stopped at its timeout, which interrupts the Docker CLI and so
 * ends the BuildKit session. Only the last lines of output are held while
 * it runs. A retried build reuses the Docker build cache, and the
 * image id, not the mutable tag, is what a runner starts, so a later build
 * under the same tag cannot change a recorded deployment.
 */
export const dockerBuilds = (options: DockerBuildOptions) =>
  Layer.effect(
    ImageBuilds,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const binary = options.binary ?? "docker"

      const timeout = Duration.fromInputUnsafe(options.timeout ?? "15 minutes")
      const limits = {
        bytes: options.maxContextBytes ?? 512 * 1024 * 1024,
        entries: options.maxContextEntries ?? 100_000,
      }

      const docker = (args: ReadonlyArray<string>, archive?: Uint8Array) =>
        Effect.gen(function* () {
          const environment = {
            env: { DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain" },
            extendEnv: true,
            forceKillAfter: Duration.seconds(10),
          }

          let command = ChildProcess.make(binary, [...args], environment)

          if (archive !== undefined) {
            const file = `${yield* fs.makeTempDirectoryScoped()}/context.tar.gz`

            yield* fs.writeFile(file, archive, { mode: 0o600 })
            command = ChildProcess.make(
              "sh",
              ["-c", 'archive=$1; shift; exec "$@" < "$archive"', "sh", file, binary, ...args],
              environment,
            )
          }

          const handle = yield* spawner.spawn(command)
          const [stdout, stderr] = yield* Effect.all(
            [tail(handle.stdout, "stdout"), tail(handle.stderr, "stderr")],
            { concurrency: 2 },
          )

          return { code: Number(yield* handle.exitCode), stdout, stderr }
        }).pipe(
          Effect.scoped,
          Effect.mapError(() =>
            BuildFailed.make({ reason: "The Docker CLI could not run", retryable: true }),
          ),
        )

      return ImageBuilds.of({
        build: Effect.fnUntraced(function* (input) {
          if (input.source !== undefined) yield* checkContext(input.source.archive, limits)

          const built = yield* docker(
            [
              "build",
              "--file",
              input.source === undefined
                ? `${options.context.replace(/\/+$/u, "")}/${options.dockerfile}`
                : input.source.dockerfile,
              "--platform",
              options.platform ?? "linux/arm64",
              "--tag",
              input.tag,
              ...Object.entries(input.buildArgs).flatMap(([key, value]) => [
                "--build-arg",
                `${key}=${value}`,
              ]),
              input.source === undefined ? options.context : "-",
            ],
            input.source?.archive,
          ).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  BuildFailed.make({
                    reason: `The build did not finish within ${Duration.format(timeout)}`,
                    retryable: false,
                  }),
                ),
            }),
          )
          const log = [...built.stdout, ...built.stderr].slice(-LOG_LINES)

          if (built.code !== 0)
            return yield* BuildFailed.make({
              reason: [`docker build exited with ${String(built.code)}`, log.at(-1)?.text]
                .filter((part) => part !== undefined)
                .join(": "),
              retryable: false,
            })

          const inspected = yield* docker(["image", "inspect", "--format", "{{.Id}}", input.tag])
          const imageId = inspected.stdout.at(-1)?.text.trim() ?? ""

          if (inspected.code !== 0 || !isImageId(imageId))
            return yield* BuildFailed.make({
              reason: "The built image could not be read",
              retryable: true,
            })

          return { imageId, log }
        }),
      })
    }),
  )
