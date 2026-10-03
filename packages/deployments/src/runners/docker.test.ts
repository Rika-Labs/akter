import { BunCrypto, BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Context, Crypto, Effect, Exit, FileSystem, Layer, Schedule, Scope, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RunnerNotFound, RunnerPlatform, RunnerPlatformError } from "./contract.ts"
import { dockerRunners } from "./docker.ts"

const image = "python:3.13-slim"

const server = `
import os, signal, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(os.environ["SNAPSHOT"].encode())

    def log_message(self, *args):
        pass

signal.signal(signal.SIGTERM, lambda *args: sys.exit(0))
HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
`

const services = Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)

const runners = dockerRunners({
  port: 8000,
  basePath: "/api",
  platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
  command: ["python", "-c", server],
  drainTimeout: 20,
}).pipe(Layer.provideMerge(services))

/** The container's own record, read with the CLI independently of the service under test. */
const container = (id: string, format: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make("docker", ["container", "inspect", "--format", format, id]),
    )

    return (yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString)).trim()
  }).pipe(Effect.scoped)

const remove = (id: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make("docker", ["rm", "--force", id]))
      yield* Effect.all(
        [handle.stdout.pipe(Stream.runDrain), handle.stderr.pipe(Stream.runDrain)],
        { concurrency: 2 },
      )
      yield* handle.exitCode
    }),
  ).pipe(Effect.orDie)

const unique = Effect.gen(function* () {
  return (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
})

const input = (idempotencyKey: string, snapshot: string) => ({
  deploymentId: "runners-test",
  region: "us-east-1",
  image,
  environment: { SNAPSHOT: snapshot },
  idempotencyKey,
})

const retryUntil = <A, E, R>(effect: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(done),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 160 }),
  )

const answer = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    return yield* (yield* client.get(url)).text
  })

layer(runners, { excludeTestServices: true })("docker runners", (it) => {
  it.effect(
    "runs a real container with its environment snapshot, finds it again for the same key, and drains it on SIGTERM",
    () =>
      Effect.gen(function* () {
        const platform = yield* RunnerPlatform
        const key = `${yield* unique}.01HZX.start`
        const snapshot = "value with spaces; and = signs"

        const first = yield* platform.start(input(key, snapshot))
        yield* Effect.addFinalizer(() => remove(first.id))
        const again = yield* platform.start(input(key, "ignored: the key already started a runner"))
        const other = yield* platform.start(input(`${key}.other`, "another"))
        yield* Effect.addFinalizer(() => remove(other.id))

        expect(again.id).toBe(first.id)
        expect(other.id).not.toBe(first.id)

        const running = yield* retryUntil(
          platform.describe(first.id),
          (runner) => runner.state === "running" && runner.url !== null,
        )

        expect(running.basePath).toBe("/api")
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
        expect(yield* retryUntil(answer(running.url ?? ""), (body) => body !== "")).toBe(snapshot)
        expect(yield* container(first.id, "{{.Config.Image}}")).toBe(image)

        yield* platform.stop(first.id)
        yield* platform.stop(first.id)

        const stopped = yield* platform.describe(first.id)

        expect(stopped.state).toBe("stopped")
        expect(stopped.url).toBeNull()
        expect(yield* container(first.id, "{{.State.ExitCode}}")).toBe("0")

        expect((yield* platform.describe(other.id)).state).not.toBe("stopped")
        yield* platform.stop(other.id)
      }).pipe(Effect.scoped),
    180_000,
  )

  it.effect(
    "reports a missing runner and refuses a malformed start",
    () =>
      Effect.gen(function* () {
        const platform = yield* RunnerPlatform

        expect(yield* Effect.flip(platform.describe("akter-runner-missing"))).toEqual(
          RunnerNotFound.make({ id: "akter-runner-missing" }),
        )
        expect(yield* Effect.flip(platform.stop("akter-runner-missing"))).toBeInstanceOf(
          RunnerNotFound,
        )

        const refused = yield* Effect.flip(
          platform.start({ ...input("key", "x"), environment: { "BAD NAME": "x" } }),
        )
        const keyless = yield* Effect.flip(platform.start(input("", "x")))

        expect(refused).toBeInstanceOf(RunnerPlatformError)
        expect(refused.code).toBe("invalid-input")
        expect(keyless.code).toBe("invalid-input")
      }),
    180_000,
  )

  it.effect(
    "leaves a runner running when the layer that started it closes, and a new layer finds and stops it",
    () =>
      Effect.gen(function* () {
        const key = `${yield* unique}.01HZX.start`
        const scope = yield* Scope.make()
        const first = Context.get(yield* Layer.buildWithScope(runners, scope), RunnerPlatform)
        const started = yield* first.start(input(key, "survives"))
        yield* Effect.addFinalizer(() => remove(started.id))

        yield* Scope.close(scope, Exit.void)

        expect(yield* container(started.id, "{{.State.Status}}")).toBe("running")

        const second = Context.get(yield* Layer.build(runners), RunnerPlatform)

        expect((yield* second.start(input(key, "survives"))).id).toBe(started.id)
        yield* second.stop(started.id)

        expect(yield* container(started.id, "{{.State.Status}}")).toBe("exited")
      }).pipe(Effect.scoped),
    180_000,
  )

  it.effect("never repeats a docker command's output or arguments in its failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const echoing = `${directory}/docker`

      yield* fs.writeFileString(echoing, '#!/bin/sh\necho "failed: $@" >&2\nexit 1\n')
      yield* fs.chmod(echoing, 0o755)

      const secret = "postgres://user:hunter2@db/app"
      const build = (binary: string) =>
        Layer.build(dockerRunners({ port: 8000, binary }).pipe(Layer.provide(services)))

      const refusing = Context.get(yield* build(echoing), RunnerPlatform)
      const missing = Context.get(yield* build(`${directory}/absent`), RunnerPlatform)

      const refused = yield* Effect.flip(refusing.start(input("key", secret)))
      const unavailable = yield* Effect.flip(missing.start(input("key", secret)))
      const stopped = yield* Effect.flip(refusing.stop("abc"))

      expect(refused).toEqual(
        RunnerPlatformError.make({
          operation: "start",
          code: "refused",
          message: "the platform refused the request",
        }),
      )
      expect(unavailable.code).toBe("unavailable")
      expect(stopped).toEqual(
        RunnerPlatformError.make({
          operation: "stop",
          code: "refused",
          message: "the platform refused the request",
        }),
      )

      for (const error of [refused, unavailable, stopped])
        expect(`${error._tag} ${error.message}`).not.toMatch(/hunter2|postgres|absent|failed:/u)
    }).pipe(Effect.scoped),
  )
})
