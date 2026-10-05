import type { Credentials } from "@distilled.cloud/fly-io/Credentials"
import * as Machines from "@distilled.cloud/fly-io/machines"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Stream } from "effect"
import type { HttpClient } from "effect/http"
import { Option, Schedule } from "effect"
import { decodeStart, startToken, type StartInput } from "./contract.ts"
import { RunnerPlatform } from "./contract.ts"
import type { RunnerAuthority } from "@rikalabs/akter/runtime"
import { peerEnvironment } from "./docker.ts"
import { exitOf, flyRunners, splitRunnerId, type FlyOptions } from "./fly.ts"

/** Migration attempts retain their provider identity so an interrupted worker can recover their result. */
export class MigrationFailed extends Schema.TaggedError<MigrationFailed>()("MigrationFailed", {}) {}

export class ImageMigrations extends Context.Service<
  ImageMigrations,
  {
    readonly run: (input: StartInput) => Effect.Effect<void, MigrationFailed>
  }
>()("@akter/deployments/runners/migrations/ImageMigrations") {}

/**
 * The image owns its migration command; the local provider only runs it and
 * verifies its exit status. With `peering`, the migration builds the same
 * mutual TLS runner wiring as the deployment's runners and gets its own
 * certificate for the deployment, valid for an hour. A successful migration's
 * container is removed so its key does not outlive it; a retry after that
 * runs the idempotent migration again.
 */
export const dockerMigrations = (options: {
  readonly command: ReadonlyArray<string>
  readonly network?: string
  readonly peering?: RunnerAuthority
  /** Default `linux/arm64`, the architecture of a development machine. */
  readonly platform?: string
}) =>
  Layer.effect(
    ImageMigrations,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof startToken>>>()
      const execute = (
        args: ReadonlyArray<string>,
        environment?: Readonly<Record<string, string>>,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(
                "docker",
                args,
                environment === undefined
                  ? undefined
                  : { env: { ...environment }, extendEnv: true },
              ),
            )
            const [output] = yield* Effect.all(
              [
                handle.stdout.pipe(Stream.decodeText, Stream.mkString),
                handle.stderr.pipe(Stream.runDrain),
              ],
              { concurrency: 2 },
            )
            return { code: Number(yield* handle.exitCode), output }
          }),
        ).pipe(Effect.mapError(() => MigrationFailed.make({})))
      const inspect = (name: string) =>
        execute(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name])
      return {
        run: (input) =>
          Effect.gen(function* () {
            yield* decodeStart(input).pipe(Effect.mapError(() => MigrationFailed.make({})))
            if (
              Object.keys(input.environment).some(
                (key) => ["PATH", "HOME"].includes(key) || key.startsWith("DOCKER_"),
              )
            )
              return yield* MigrationFailed.make({})
            const name = `akter-migrate-${(yield* startToken(input).pipe(Effect.provideContext(context))).slice(0, 32)}`
            const found = yield* inspect(name)
            if (found.code === 0 && found.output.trim() === "exited 0") return
            if (found.code !== 0) {
              const environment =
                options.peering === undefined
                  ? input.environment
                  : {
                      ...input.environment,
                      ...(yield* peerEnvironment({
                        authority: options.peering,
                        deploymentId: input.deploymentId,
                        validFor: "1 hour",
                      })),
                    }
              const created = yield* execute(
                [
                  "create",
                  "--name",
                  name,
                  "--platform",
                  options.platform ?? "linux/arm64",
                  ...(options.network === undefined ? [] : ["--network", options.network]),
                  ...Object.keys(environment).flatMap((key) => ["--env", key]),
                  input.image,
                  ...options.command,
                ],
                environment,
              )
              if (created.code !== 0 && (yield* inspect(name)).code !== 0)
                return yield* MigrationFailed.make({})
            }
            const completed = yield* execute(["start", "--attach", name])
            const status = yield* inspect(name)
            if (completed.code !== 0 || status.code !== 0 || status.output.trim() !== "exited 0")
              return yield* MigrationFailed.make({})
            yield* execute(["rm", name])
          }).pipe(Effect.mapError(() => MigrationFailed.make({}))),
      }
    }),
  )

/**
 * A migration is one machine in the deployment's app that runs `command` once.
 * It succeeds only when Fly recorded the process's exit with code 0, not when
 * the machine merely stopped. Once started, the machine is stopped and
 * destroyed however the run ends, by success, failure or interruption, so its
 * environment does not outlive it; a failure to remove it does not replace the
 * migration's own result. A retry after that runs the idempotent migration
 * again.
 */
export const flyMigrations = (options: FlyOptions & { readonly command: ReadonlyArray<string> }) =>
  Layer.effect(
    ImageMigrations,
    Effect.gen(function* () {
      const platform = yield* RunnerPlatform
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient>()
      return {
        run: (input) =>
          Effect.acquireUseRelease(
            platform.start(input),
            (started) =>
              Effect.gen(function* () {
                const exited = yield* platform.describe(started.id).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("1 second"),
                    until: (machine) => machine.terminated === true,
                  }),
                  Effect.timeoutOption("5 minutes"),
                )
                const named = splitRunnerId(started.id)
                if (Option.isNone(exited) || named === undefined)
                  return yield* MigrationFailed.make({})
                const machine = yield* Machines.getMachine({
                  app_name: named.app,
                  machine_id: named.machine,
                }).pipe(Effect.provideContext(context))
                if (exitOf(machine)?.code !== 0) return yield* MigrationFailed.make({})
              }),
            (started) => platform.stop(started.id).pipe(Effect.ignore),
          ).pipe(Effect.mapError(() => MigrationFailed.make({}))),
      }
    }),
  ).pipe(Layer.provide(flyRunners(options)))
