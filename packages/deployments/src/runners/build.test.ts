import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Context, Crypto, Effect, FileSystem, Layer, Stream } from "effect"
import { BunCrypto } from "@effect/platform-bun"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { BuildFailed, dockerBuilds, ImageBuilds } from "./build.ts"

const services = Layer.mergeAll(BunServices.layer, BunCrypto.layer)

/** Runs the Docker CLI independently of the builder under test. */
const docker = (...args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make("docker", [...args]))
      const [out] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText, Stream.mkString),
          handle.stderr.pipe(Stream.runDrain),
        ],
        { concurrency: 2 },
      )

      return { code: Number(yield* handle.exitCode), out: out.trim() }
    }),
  ).pipe(Effect.orDie)

/** A build context whose image needs no base image pull, removed with the scope. */
const context = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()

  yield* fs.writeFileString(`${directory}/marker`, "built")
  yield* fs.writeFileString(
    `${directory}/Runner.Dockerfile`,
    "FROM scratch\nARG RUNNER_VERSION\nLABEL version=$RUNNER_VERSION\nCOPY marker /marker\n",
  )
  yield* fs.writeFileString(`${directory}/Broken.Dockerfile`, "FROM scratch\nCOPY absent /absent\n")

  return directory
}).pipe(Effect.orDie)

layer(services)("docker image builds", (it) => {
  it.effect(
    "builds a tagged image with its build arguments, points the tag at the latest build, and refuses a broken build without retrying it",
    () =>
      Effect.gen(function* () {
        const directory = yield* context
        const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)
        const tag = `akter-build-test:${suffix}`
        const broken = `akter-build-test:${suffix}-broken`

        yield* Effect.addFinalizer(() => docker("image", "rm", "--force", tag, broken))

        const build = (dockerfile: string, imageTag: string, version: string) =>
          Effect.gen(function* () {
            const built = yield* Layer.build(
              dockerBuilds({ context: directory, dockerfile, platform: "linux/arm64" }).pipe(
                Layer.provide(services),
              ),
            )

            return yield* Context.get(built, ImageBuilds).build({
              tag: imageTag,
              buildArgs: { RUNNER_VERSION: version },
            })
          })

        const first = yield* build("Runner.Dockerfile", tag, "c0ffee1")

        expect(first.imageId).toMatch(/^sha256:[0-9a-f]{64}$/u)
        expect(first.log.some((line) => line.text.includes("COPY marker"))).toBe(true)
        expect((yield* docker("image", "inspect", "--format", "{{.Id}}", tag)).out).toBe(
          first.imageId,
        )
        expect(
          (yield* docker("image", "inspect", "--format", '{{index .Config.Labels "version"}}', tag))
            .out,
        ).toBe("c0ffee1")
        const rebuilt = yield* build("Runner.Dockerfile", tag, "beef002")

        expect((yield* docker("image", "inspect", "--format", "{{.Id}}", tag)).out).toBe(
          rebuilt.imageId,
        )
        expect(
          (yield* docker("image", "inspect", "--format", '{{index .Config.Labels "version"}}', tag))
            .out,
        ).toBe("beef002")

        const refused = yield* build("Broken.Dockerfile", broken, "c0ffee1").pipe(Effect.flip)

        expect(refused).toBeInstanceOf(BuildFailed)
        expect(refused).toMatchObject({ retryable: false })
        expect(refused.reason).toMatch(/^docker build exited with [1-9]/u)
        expect((yield* docker("image", "inspect", broken)).code).not.toBe(0)
      }),
    120_000,
  )

  it.effect(
    "builds an uploaded context from its archive instead of the configured context, and refuses an archive without its Dockerfile",
    () =>
      Effect.gen(function* () {
        const directory = yield* context
        const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)
        const tag = `akter-build-test:${suffix}-uploaded`
        const missing = `akter-build-test:${suffix}-missing`

        yield* Effect.addFinalizer(() => docker("image", "rm", "--force", tag, missing))

        const archive = yield* Effect.promise(() =>
          new Bun.Archive(
            {
              "app/Uploaded.Dockerfile":
                "FROM scratch\nARG RUNNER_VERSION\nLABEL source=archive version=$RUNNER_VERSION\nCOPY uploaded /uploaded\n",
              uploaded: `uploaded ${suffix}`,
            },
            { compress: "gzip" },
          ).bytes(),
        )
        const builds = Context.get(
          yield* Layer.build(
            dockerBuilds({ context: directory, dockerfile: "Runner.Dockerfile" }).pipe(
              Layer.provide(services),
            ),
          ),
          ImageBuilds,
        )

        const built = yield* builds.build({
          tag,
          buildArgs: { RUNNER_VERSION: "a1b2c3d" },
          source: { archive, dockerfile: "app/Uploaded.Dockerfile" },
        })

        expect(built.imageId).toMatch(/^sha256:[0-9a-f]{64}$/u)
        expect(built.log.some((line) => line.text.includes("COPY uploaded"))).toBe(true)
        expect((yield* docker("image", "inspect", "--format", "{{.Id}}", tag)).out).toBe(
          built.imageId,
        )
        expect(
          (yield* docker(
            "image",
            "inspect",
            "--format",
            '{{index .Config.Labels "source"}} {{index .Config.Labels "version"}}',
            tag,
          )).out,
        ).toBe("archive a1b2c3d")

        const refused = yield* builds
          .build({
            tag: missing,
            buildArgs: {},
            source: { archive, dockerfile: "Runner.Dockerfile" },
          })
          .pipe(Effect.flip)

        expect(refused).toBeInstanceOf(BuildFailed)
        expect(refused).toMatchObject({ retryable: false })
        expect((yield* docker("image", "inspect", missing)).code).not.toBe(0)
      }),
    120_000,
  )
})
