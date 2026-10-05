import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Context, Crypto, type Duration, Effect, FileSystem, Layer, Stream } from "effect"
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

layer(services, { excludeTestServices: true })("docker image builds", (it) => {
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

  it.effect(
    "refuses an uploaded context that is not a gzip-compressed tar, or unpacks past its byte or entry limit, before Docker runs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const marker = `${directory}/docker-ran`
        const binary = `${directory}/docker`

        yield* fs.writeFileString(binary, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 })

        const builds = Context.get(
          yield* Layer.build(
            dockerBuilds({
              context: directory,
              dockerfile: "Dockerfile",
              binary,
              maxContextBytes: 64 * 1024,
              maxContextEntries: 3,
            }).pipe(Layer.provide(services)),
          ),
          ImageBuilds,
        )
        const archive = (files: Record<string, string | Uint8Array>) =>
          Effect.promise(() => new Bun.Archive(files, { compress: "gzip" }).bytes())
        const refusal = (bytes: Uint8Array) =>
          builds
            .build({
              tag: "akter-build-test:refused",
              buildArgs: {},
              source: { archive: bytes, dockerfile: "Dockerfile" },
            })
            .pipe(Effect.flip)

        for (const [bytes, reason] of [
          [new TextEncoder().encode("not gzip at all"), "not a gzip-compressed tar archive"],
          [Bun.gzipSync(new Uint8Array(2048).fill(7)), "not a tar archive"],
          [
            yield* archive({ Dockerfile: "FROM scratch\n", a: "1", b: "2", c: "3" }),
            "holds more than 3 entries",
          ],
          [
            yield* archive({ Dockerfile: "FROM scratch\n", big: new Uint8Array(80 * 1024) }),
            "unpacks to more than 65536 bytes",
          ],
          [Bun.gzipSync(new Uint8Array(10 * 1024 * 1024)), "unpacks to more than 65536 bytes"],
        ] as const) {
          const refused = yield* refusal(bytes)

          expect(refused).toBeInstanceOf(BuildFailed)
          expect(refused.retryable).toBe(false)
          expect(refused.reason).toContain(reason)
        }

        expect(yield* fs.exists(marker), "Docker never ran on a refused context").toBe(false)

        const fits = yield* refusal(yield* archive({ Dockerfile: "FROM scratch\n", a: "1" }))

        expect(fits.reason).toMatch(/^docker build exited with 1/u)
        expect(yield* fs.exists(marker)).toBe(true)
      }),
  )

  it.effect(
    "gives docker the uploaded archive on its stdin byte for byte, and survives a docker that exits without reading it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const received = `${directory}/received`
        const reader = `${directory}/reader`
        const deaf = `${directory}/deaf`

        yield* fs.writeFileString(reader, `#!/bin/sh\ncat > ${received}\nexit 1\n`, { mode: 0o755 })
        yield* fs.writeFileString(deaf, "#!/bin/sh\nexit 1\n", { mode: 0o755 })

        const noise = new Uint8Array(512 * 1024)

        for (let offset = 0; offset < noise.length; offset += 65_536)
          crypto.getRandomValues(noise.subarray(offset, offset + 65_536))

        const archive = yield* Effect.promise(() =>
          new Bun.Archive({ Dockerfile: "FROM scratch\n", noise }, { compress: "gzip" }).bytes(),
        )
        const refusal = (binary: string) =>
          Effect.flatMap(
            Layer.build(
              dockerBuilds({ context: directory, dockerfile: "Dockerfile", binary }).pipe(
                Layer.provide(services),
              ),
            ),
            (built) =>
              Context.get(built, ImageBuilds)
                .build({
                  tag: "akter-build-test:stdin",
                  buildArgs: {},
                  source: { archive, dockerfile: "Dockerfile" },
                })
                .pipe(Effect.flip),
          )

        expect(archive.byteLength).toBeGreaterThan(256 * 1024)
        expect((yield* refusal(reader)).reason).toMatch(/^docker build exited with 1/u)
        expect(yield* fs.readFile(received)).toEqual(archive)
        expect((yield* refusal(deaf)).reason).toMatch(/^docker build exited with 1/u)
      }),
  )

  it.effect(
    "keeps only the last 400 lines of a build's output as it streams, and stops a build at its timeout",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const noisy = `${directory}/noisy`
        const built = `${directory}/built`
        const slow = `${directory}/slow`
        const pidFile = `${directory}/pid`

        yield* fs.writeFileString(
          noisy,
          '#!/bin/sh\ni=0\nwhile [ $i -lt 5000 ]; do echo "line $i"; i=$((i+1)); done\necho "the last error" >&2\nexit 3\n',
          { mode: 0o755 },
        )
        yield* fs.writeFileString(
          built,
          `#!/bin/sh\nif [ "$1" = image ]; then echo sha256:${"e".repeat(64)}; exit 0; fi\ni=0\nwhile [ $i -lt 5000 ]; do echo "line $i"; i=$((i+1)); done\n`,
          { mode: 0o755 },
        )
        yield* fs.writeFileString(slow, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`, {
          mode: 0o755,
        })

        const builder = (binary: string, timeout: Duration.Input) =>
          Effect.map(
            Layer.build(
              dockerBuilds({ context: directory, dockerfile: "Dockerfile", binary, timeout }).pipe(
                Layer.provide(services),
              ),
            ),
            (built) => Context.get(built, ImageBuilds),
          )

        const failed = yield* (yield* builder(noisy, "1 minute"))
          .build({ tag: "akter-build-test:noisy", buildArgs: {} })
          .pipe(Effect.flip)

        expect(failed.reason).toBe("docker build exited with 3: the last error")

        const image = yield* (yield* builder(built, "1 minute")).build({
          tag: "akter-build-test:built",
          buildArgs: {},
        })

        expect(image.imageId).toBe(`sha256:${"e".repeat(64)}`)
        expect(image.log).toHaveLength(400)
        expect(image.log[0]).toEqual({ stream: "stdout", text: "line 4600" })
        expect(image.log.at(-1)).toEqual({ stream: "stdout", text: "line 4999" })

        const started = performance.now()
        const stopped = yield* (yield* builder(slow, "1 second"))
          .build({ tag: "akter-build-test:slow", buildArgs: {} })
          .pipe(Effect.flip)

        expect(stopped).toMatchObject({
          reason: "The build did not finish within 1s",
          retryable: false,
        })
        expect(performance.now() - started).toBeLessThan(10_000)

        const pid = Number((yield* fs.readFileString(pidFile)).trim())
        const alive = Effect.try(() => process.kill(pid, 0)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )

        expect(yield* alive, "the stopped build's process was killed").toBe(false)
      }),
    30_000,
  )
})
