import { BunCrypto, BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import {
  Context,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import { RunnerAddress, ShardingConfig } from "effect/cluster"
import { RpcSerialization } from "effect/rpc"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { X509Certificate } from "node:crypto"
import { Runner, RunnerAuthority } from "@rikalabs/akter/runtime"
import { RunnerNotFound, RunnerPlatform, RunnerPlatformError, startToken } from "./contract.ts"
import { dockerRunners } from "./docker.ts"
import { dockerMigrations, ImageMigrations } from "./migrations.ts"

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

/** A container's environment as Docker records it, which anyone with Docker access can read. */
const environment = (id: string) =>
  Effect.flatMap(container(id, "{{json .Config.Env}}"), (json) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(json).pipe(
      Effect.orDie,
      Effect.map((entries) =>
        Object.fromEntries(
          entries.map((entry) => [
            entry.slice(0, entry.indexOf("=")),
            entry.slice(entry.indexOf("=") + 1),
          ]),
        ),
      ),
    ),
  )

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

  it.effect(
    "issues each new container its own runner certificate for its deployment through the environment",
    () =>
      Effect.gen(function* () {
        const authority = yield* RunnerAuthority.make()
        const platform = Context.get(
          yield* Layer.build(
            dockerRunners({
              port: 8000,
              platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
              command: ["python", "-c", server],
              drainTimeout: 1,
              peering: authority,
            }).pipe(Layer.provide(services)),
          ),
          RunnerPlatform,
        )
        const key = `${yield* unique}.01HZX.peering`
        const first = yield* platform.start(input(key, "peered"))
        yield* Effect.addFinalizer(() => remove(first.id))
        const second = yield* platform.start(input(`${key}.second`, "peered"))
        yield* Effect.addFinalizer(() => remove(second.id))
        const [one, two] = [yield* environment(first.id), yield* environment(second.id)]
        const peering = (deployment: string) =>
          Layer.build(
            Runner.mtls({
              deployment,
              credentials: Effect.succeed({
                ca: one.RUNNER_PEER_CA!,
                certificate: one.RUNNER_PEER_CERTIFICATE!,
                key: Redacted.make(one.RUNNER_PEER_KEY!),
              }),
            }).pipe(
              Layer.provide(
                ShardingConfig.layer({
                  runnerAddress: Option.some(
                    RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port: 0 }),
                  ),
                }),
              ),
              Layer.provide(RpcSerialization.layerNdjson),
            ),
          ).pipe(Effect.scoped, Effect.exit)

        expect(one.RUNNER_PEER_DEPLOYMENT).toBe("runners-test")
        expect(one.RUNNER_PEER_CA).toBe(authority.certificate)
        expect((yield* peering("runners-test"))._tag).toBe("Success")
        expect(String(yield* peering("another-deployment"))).toContain(
          Runner.identity("another-deployment"),
        )
        expect(two.RUNNER_PEER_KEY).not.toBe(one.RUNNER_PEER_KEY)
        expect(one.SNAPSHOT).toBe("peered")
        expect(yield* container(first.id, "{{json .Args}}")).not.toContain("PRIVATE KEY")
      }).pipe(Effect.scoped),
    180_000,
  )

  it.effect(
    "gives a migration an hour-long certificate and removes its container, and its key, once it succeeds",
    () =>
      Effect.gen(function* () {
        const authority = yield* RunnerAuthority.make()
        const key = `${yield* unique}.01HZX.migrate`
        const migrations = (code: number) =>
          Effect.map(
            Layer.build(
              dockerMigrations({
                command: ["python", "-c", `import sys; sys.exit(${code})`],
                peering: authority,
                platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
              }).pipe(Layer.provide(services)),
            ),
            (context) => Context.get(context, ImageMigrations),
          )
        const name = (idempotencyKey: string) =>
          Effect.map(
            startToken({ deploymentId: "runners-test", idempotencyKey }),
            (token) => `akter-migrate-${token.slice(0, 32)}`,
          ).pipe(Effect.orDie)
        const failing = `${key}.failing`
        yield* Effect.addFinalizer(() => Effect.flatMap(name(failing), remove))

        expect(
          (yield* Effect.exit((yield* migrations(3)).run(input(failing, "migrate"))))._tag,
        ).toBe("Failure")
        const leaf = new X509Certificate(
          (yield* environment(yield* name(failing))).RUNNER_PEER_CERTIFICATE!,
        )
        expect(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)).toBe(60 * 60_000)

        yield* (yield* migrations(0)).run(input(key, "migrate"))
        expect(yield* container(yield* name(key), "{{.State.Status}}")).toBe("")
      }).pipe(Effect.scoped),
    360_000,
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
