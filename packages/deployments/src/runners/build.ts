import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** One line of a build's output. */
export interface BuildLine {
  readonly stream: "stdout" | "stderr"
  readonly text: string
}

/** What to build: the tag the image gets and the build arguments it is built with. */
export interface BuildInput {
  readonly tag: string
  readonly buildArgs: Readonly<Record<string, string>>
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
 * architecture the local runners start with.
 */
export interface DockerBuildOptions {
  readonly context: string
  readonly dockerfile: string
  readonly platform?: string
  readonly binary?: string
}

/**
 * `ImageBuilds` over the local Docker CLI with BuildKit, for the development
 * stack and tests; hosted images are built and pushed by CI. A retried build
 * reuses the Docker build cache, and the image id, not the mutable tag, is
 * what a runner starts, so a later build under the same tag cannot change a
 * recorded deployment.
 */
export const dockerBuilds = (options: DockerBuildOptions) =>
  Layer.effect(
    ImageBuilds,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const binary = options.binary ?? "docker"

      const lines = (stream: BuildLine["stream"], text: string) =>
        text
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line): BuildLine => ({ stream, text: line }))

      const docker = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(binary, [...args], {
              env: { DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain" },
              extendEnv: true,
            }),
          )
          const [stdout, stderr] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText, Stream.mkString),
              handle.stderr.pipe(Stream.decodeText, Stream.mkString),
            ],
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
          const built = yield* docker([
            "build",
            "--file",
            `${options.context.replace(/\/+$/u, "")}/${options.dockerfile}`,
            "--platform",
            options.platform ?? "linux/arm64",
            "--tag",
            input.tag,
            ...Object.entries(input.buildArgs).flatMap(([key, value]) => [
              "--build-arg",
              `${key}=${value}`,
            ]),
            options.context,
          ])
          const log = [...lines("stdout", built.stdout), ...lines("stderr", built.stderr)].slice(
            -LOG_LINES,
          )

          if (built.code !== 0)
            return yield* BuildFailed.make({
              reason: [`docker build exited with ${String(built.code)}`, log.at(-1)?.text]
                .filter((part) => part !== undefined)
                .join(": "),
              retryable: false,
            })

          const inspected = yield* docker(["image", "inspect", "--format", "{{.Id}}", input.tag])
          const imageId = inspected.stdout.trim()

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
