import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Stream } from "effect"
import { describeTasks } from "@distilled.cloud/aws/ecs"
import { Credentials } from "@distilled.cloud/aws/Credentials"
import { Region, type RegionName } from "@distilled.cloud/aws/Region"
import { HttpClient } from "effect/http"
import { Option, Schedule } from "effect"
import { decodeStart, startToken, type StartInput } from "./contract.ts"
import { RunnerPlatform } from "./contract.ts"
import { ecsRunners, type EcsOptions } from "./ecs.ts"

/** Migration attempts retain their provider identity so an interrupted worker can recover their result. */
export class MigrationFailed extends Schema.TaggedError<MigrationFailed>()("MigrationFailed", {}) {}

export class ImageMigrations extends Context.Service<
  ImageMigrations,
  {
    readonly run: (input: StartInput) => Effect.Effect<void, MigrationFailed>
  }
>()("@akter/deployments/runners/migrations/ImageMigrations") {}

/** The image owns its migration command; the local provider only runs it and verifies its exit status. */
export const dockerMigrations = (options: {
  readonly command: ReadonlyArray<string>
  readonly network?: string
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
              const created = yield* execute(
                [
                  "create",
                  "--name",
                  name,
                  "--platform",
                  "linux/arm64",
                  ...(options.network === undefined ? [] : ["--network", options.network]),
                  ...Object.keys(input.environment).flatMap((key) => ["--env", key]),
                  input.image,
                  ...options.command,
                ],
                input.environment,
              )
              if (created.code !== 0 && (yield* inspect(name)).code !== 0)
                return yield* MigrationFailed.make({})
            }
            const completed = yield* execute(["start", "--attach", name])
            const status = yield* inspect(name)
            if (completed.code !== 0 || status.code !== 0 || status.output.trim() !== "exited 0")
              return yield* MigrationFailed.make({})
          }).pipe(Effect.mapError(() => MigrationFailed.make({}))),
      }
    }),
  )

/** A successful task stop is insufficient: migration tasks must have exactly one successful container exit. */
export const ecsMigrations = (options: EcsOptions & { readonly command: ReadonlyArray<string> }) =>
  Layer.effect(
    ImageMigrations,
    Effect.gen(function* () {
      const platform = yield* RunnerPlatform
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient>()
      return {
        run: (input) =>
          Effect.gen(function* () {
            const started = yield* platform.start(input)
            const exited = yield* platform.describe(started.id).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (task) => task.terminated === true,
              }),
              Effect.timeoutOption("5 minutes"),
            )
            if (Option.isNone(exited)) {
              yield* platform.stop(started.id)
              return yield* MigrationFailed.make({})
            }
            const placement = options.regions[input.region]
            if (placement === undefined) return yield* MigrationFailed.make({})
            const result = yield* describeTasks({
              cluster: placement.cluster,
              tasks: [started.id],
            }).pipe(
              Effect.provideService(Region, Effect.succeed(input.region as RegionName)),
              Effect.provideContext(context),
            )
            const containers = result.tasks?.[0]?.containers
            if (containers?.length !== 1 || containers[0]?.exitCode !== 0)
              return yield* MigrationFailed.make({})
          }).pipe(Effect.mapError(() => MigrationFailed.make({}))),
      }
    }),
  ).pipe(Layer.provide(ecsRunners(options)))
