import type { RunnerAuthority } from "@rikalabs/akter/runtime"
import { Crypto, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  decodeStart,
  startToken,
  type Runner,
  RunnerNotFound,
  RunnerPlatform,
  platformError,
  type RunnerState,
} from "./contract.ts"

/**
 * What the caller decides about local containers; the layer reads nothing
 * from the process environment.
 *
 * `port` is the container port the runner listens on; each runner publishes
 * it on a random port of `publishHost`, and that origin is the runner's url.
 * `network` joins the containers to an existing Docker network, so a runner
 * can reach a database by name there. `basePath` is where the runner mounts
 * its routes. `command` replaces the image's command when given.
 * `drainTimeout` is how many seconds a stopped runner has to finish after
 * SIGTERM before Docker kills it. `platform` defaults to `linux/arm64`, the
 * architecture hosted runners run on. `peering` issues each new container its
 * own runner certificate for its deployment (see `peerEnvironment`).
 */
export interface DockerOptions {
  readonly port: number
  readonly basePath?: string
  readonly network?: string
  readonly routeViaNetwork?: boolean
  readonly publishHost?: string
  readonly binary?: string
  readonly platform?: string
  readonly command?: ReadonlyArray<string>
  readonly drainTimeout?: number
  readonly peering?: RunnerAuthority
}

/**
 * The variables a local runner reads its mutual TLS credentials from: a fresh
 * key and a certificate that names only `deploymentId`, so runners of other
 * deployments on the same Docker network cannot exchange runner messages with
 * it. They travel like the rest of the environment, never in arguments.
 */
export const peerEnvironment = (options: {
  readonly authority: RunnerAuthority
  readonly deploymentId: string
}) =>
  Effect.map(options.authority.issue({ deployment: options.deploymentId }), (credentials) => ({
    RUNNER_PEER_DEPLOYMENT: options.deploymentId,
    RUNNER_PEER_CA: credentials.ca,
    RUNNER_PEER_CERTIFICATE: credentials.certificate,
    RUNNER_PEER_KEY: Redacted.value(credentials.key),
  }))

const Inspected = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    State: Schema.Struct({ Status: Schema.String }),
    NetworkSettings: Schema.Struct({
      Networks: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ IPAddress: Schema.String })),
      ),
      Ports: Schema.Record(
        Schema.String,
        Schema.NullOr(Schema.Array(Schema.Struct({ HostPort: Schema.String }))),
      ),
    }),
  }),
)

const stateOf = (status: string): RunnerState => {
  switch (status) {
    case "running":
    case "paused":
      return "running"
    case "removing":
    case "exited":
    case "dead":
      return "stopped"
    default:
      return "starting"
  }
}

/**
 * `RunnerPlatform` over the local Docker CLI, starting real containers. The
 * environment snapshot travels through the CLI's environment, with only
 * variable names in arguments. This platform is for development and tests;
 * hosted runners use ECS.
 *
 * A container is named for its deployment and the hash of its idempotency
 * key, so a repeated start finds the container it already made. Containers
 * belong to Docker, not to the layer: closing its scope, or restarting the
 * process that holds it, neither stops nor removes them.
 */
export const dockerRunners = (options: DockerOptions) =>
  Layer.effect(
    RunnerPlatform,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const crypto = yield* Crypto.Crypto
      const binary = options.binary ?? "docker"
      const drainTimeout = options.drainTimeout ?? 30

      const docker = (
        operation: "start" | "describe" | "stop",
        args: ReadonlyArray<string>,
        environment?: Readonly<Record<string, string>>,
      ) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              binary,
              [...args],
              environment === undefined ? undefined : { env: { ...environment }, extendEnv: true },
            ),
          )
          const [stdout, stderr] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText, Stream.mkString),
              handle.stderr.pipe(Stream.decodeText, Stream.mkString),
            ],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode

          return { code, stdout: stdout.trim(), stderr }
        }).pipe(
          Effect.scoped,
          Effect.mapError(() => platformError({ operation: operation, code: "unavailable" })),
        )

      const inspect = Effect.fnUntraced(function* (operation: "start" | "describe", id: string) {
        const result = yield* docker(operation, ["container", "inspect", id])

        if (result.code !== 0 && /no such/iu.test(result.stderr))
          return yield* RunnerNotFound.make({ id })

        if (result.code !== 0)
          return yield* platformError({ operation: operation, code: "refused" })

        const [container] = yield* Schema.decodeEffect(Schema.fromJsonString(Inspected))(
          result.stdout,
        ).pipe(Effect.mapError(() => platformError({ operation: operation, code: "unreadable" })))

        if (container === undefined) return yield* RunnerNotFound.make({ id })

        const state = stateOf(container.State.Status)
        const bound = container.NetworkSettings.Ports[`${options.port}/tcp`]?.[0]
        const privateAddress =
          options.network === undefined
            ? undefined
            : container.NetworkSettings.Networks?.[options.network]?.IPAddress

        const origin =
          options.routeViaNetwork === true
            ? privateAddress === undefined || privateAddress === ""
              ? null
              : `http://${privateAddress}:${options.port}`
            : bound === undefined
              ? null
              : `http://${options.publishHost ?? "127.0.0.1"}:${bound.HostPort}`

        return {
          id: container.Id,
          state,
          url: state === "running" ? origin : null,
          basePath: options.basePath ?? "",
        } satisfies Runner
      })

      const stop = (id: string) =>
        Effect.gen(function* () {
          const result = yield* docker("stop", [
            "container",
            "stop",
            "--time",
            String(drainTimeout),
            id,
          ])

          if (result.code === 0) return
          if (/no such/iu.test(result.stderr)) return yield* RunnerNotFound.make({ id })

          return yield* platformError({ operation: "stop", code: "refused" })
        })

      return RunnerPlatform.of({
        start: Effect.fnUntraced(function* (request) {
          const input = yield* decodeStart(request)
          if (options.routeViaNetwork === true && options.network === undefined)
            return yield* platformError({ operation: "start", code: "invalid-input" })
          if (
            Object.keys(input.environment).some(
              (key) => ["PATH", "HOME"].includes(key) || key.startsWith("DOCKER_"),
            )
          )
            return yield* platformError({ operation: "start", code: "invalid-input" })
          const name = `akter-runner-${input.deploymentId}-${yield* startToken(input).pipe(Effect.provideService(Crypto.Crypto, crypto))}`

          const found = yield* inspect("start", name).pipe(
            Effect.catchTag("RunnerNotFound", () => Effect.succeed(null)),
          )

          if (found !== null) return found

          const environment =
            options.peering === undefined
              ? input.environment
              : {
                  ...input.environment,
                  ...(yield* peerEnvironment({
                    authority: options.peering,
                    deploymentId: input.deploymentId,
                  })),
                }

          const result = yield* docker(
            "start",
            [
              "run",
              "--detach",
              "--name",
              name,
              "--platform",
              options.platform ?? "linux/arm64",
              "--stop-timeout",
              String(drainTimeout),
              "--publish",
              `${options.publishHost ?? "127.0.0.1"}::${options.port}`,
              ...(options.network === undefined ? [] : ["--network", options.network]),
              "--label",
              `akter.deployment=${input.deploymentId}`,
              "--label",
              `akter.region=${input.region}`,
              ...Object.keys(environment).flatMap((key) => ["--env", key]),
              input.image,
              ...(options.command ?? []),
            ],
            environment,
          )

          if (result.code !== 0 && !/already in use/iu.test(result.stderr))
            return yield* platformError({ operation: "start", code: "refused" })

          return yield* inspect("start", name).pipe(
            Effect.catchTag("RunnerNotFound", () =>
              platformError({ operation: "start", code: "unreadable" }),
            ),
          )
        }),

        describe: (id) => inspect("describe", id),

        stop,
      })
    }),
  )
