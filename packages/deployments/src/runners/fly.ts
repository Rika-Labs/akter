import type { Credentials } from "@distilled.cloud/fly-io/Credentials"
import * as Machines from "@distilled.cloud/fly-io/machines"
import { Crypto, Effect, Layer, Option, Predicate, Schedule, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { Region } from "../tenant-home/contract.ts"
import {
  decodeStart,
  hashHex,
  platformError,
  RunnerNotFound,
  RunnerPlatform,
  startToken,
  type Runner,
  type RunnerPlatformError,
  type RunnerState,
  type StartInput,
} from "./contract.ts"

const FlyRegionCode = Schema.String.check(Schema.isPattern(/^[a-z]{3}$/u))

/**
 * What the operator decides about hosted runners, as the JSON of
 * `RUNNER_FLY_CONFIG`.
 *
 * Every deployment gets its own Fly app, named `appPrefix` followed by a hash
 * of the deployment id cut to fit Fly's 30-character app names, in
 * `organization` and on a private network of the same name, so no two
 * deployments share a network. `regions` is keyed by the Akter region a start
 * names; a region not listed is refused. Its `region` is the Fly region the
 * machine starts in, and a `fallbackRegions` entry is tried in order when Fly
 * has no capacity there. `port` is where the runner listens; `guest` sizes
 * its machine.
 */
export const FlyConfig = Schema.Struct({
  organization: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u)),
  regions: Schema.Record(
    Region,
    Schema.Struct({
      region: FlyRegionCode,
      fallbackRegions: Schema.optional(Schema.Array(FlyRegionCode)),
    }),
  ),
  appPrefix: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,21}$/u)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  guest: Schema.Struct({
    cpuKind: Schema.Literals(["shared", "performance"]),
    cpus: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
    memoryMb: Schema.Int.check(Schema.isGreaterThanOrEqualTo(256)),
  }),
  basePath: Schema.optional(Schema.String),
})

/**
 * `FlyConfig` plus `command`, which makes every machine a one-shot process
 * (a migration) that has no public service and replaces the image's command.
 * The layer reads no credentials or environment and takes `Credentials` and
 * `HttpClient` from its context.
 */
export type FlyOptions = typeof FlyConfig.Type & { readonly command?: ReadonlyArray<string> }

const IMAGE = /^registry\.fly\.io\/[a-z][a-z0-9-]{0,62}@sha256:[0-9a-f]{64}$/u
const APP_NAME_LENGTH = 30
const DRAIN = "30s"
const DEPLOYMENT_KEY = "akter.deployment"
const REGION_KEY = "akter.region"

const CAPACITY = /capacity|insufficient resources/iu

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))

const TRANSIENT = new Set([
  "HttpClientError",
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
])

const ExitEvent = Schema.Struct({
  type: Schema.Literal("exit"),
  timestamp: Schema.optional(Schema.Finite),
  request: Schema.Struct({
    exit_event: Schema.Struct({ exit_code: Schema.optional(Schema.Finite) }),
  }),
})

const decodeExit = Schema.decodeUnknownOption(ExitEvent)

/**
 * The newest exit Fly recorded for a machine, with the process's exit code
 * when Fly reported one, or undefined while no exit has been observed.
 */
export const exitOf = (machine: Machines.Machine) => {
  let newest: typeof ExitEvent.Type | undefined

  for (const event of machine.events ?? []) {
    const exit = Option.getOrUndefined(decodeExit(event))

    if (
      exit !== undefined &&
      (newest === undefined || (exit.timestamp ?? 0) > (newest.timestamp ?? 0))
    )
      newest = exit
  }

  return newest === undefined ? undefined : { code: newest.request.exit_event.exit_code }
}

/** The app and machine a runner id names, or undefined for an id this layer never issued. */
export const splitRunnerId = (id: string) => {
  const [app, machine, ...extra] = id.split("/")

  return app === undefined || machine === undefined || extra.length > 0
    ? undefined
    : { app, machine }
}

const FINISHED = new Set(["stopped", "suspended", "destroying", "destroyed"])

const stateOf = (state: string | undefined): RunnerState => {
  switch (state) {
    case "started":
      return "running"
    case "stopping":
    case "suspending":
    case "stopped":
    case "suspended":
    case "destroying":
    case "destroyed":
      return "stopped"
    default:
      return "starting"
  }
}

/**
 * `RunnerPlatform` over Fly Machines through Distilled's Fly client. A
 * deployment's runners live in that deployment's own app on its own private
 * network, which is created on the first start together with its public
 * addresses, so `https://<app>.fly.dev` reaches the runner through Fly's
 * proxy. A runner's id is `<app>/<machine id>`, and any id outside the
 * configured app prefix is not found without calling Fly.
 *
 * A machine is named for the hash of its start's deployment and idempotency
 * key, so a repeated start finds the machine it already made instead of
 * creating another, whether or not the first answer arrived. An image must
 * be pinned by digest in `registry.fly.io`, so a deployment always runs the
 * bytes CI pushed. Machines never restart themselves: a process that exits
 * leaves a stopped machine whose exit Fly recorded, which is what `terminated`
 * reports, and the platform decides whether to replace it. Stopping a runner
 * drains it, waits for Fly to report it stopped and then destroys the
 * machine, so scale-to-zero cycles leave no machines behind.
 *
 * A machine that Fly cannot place is retried in each fallback region in
 * turn, and when none has capacity the start fails with the transient
 * `capacity` code. The environment is the machine's own, readable by anyone
 * who can read the app's machines.
 */
export const flyRunners = (options: FlyOptions) =>
  Layer.effect(
    RunnerPlatform,
    Effect.gen(function* () {
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient>()
      const crypto = yield* Crypto.Crypto
      const basePath = options.basePath ?? ""
      const oneShot = options.command !== undefined

      const inFly = <A, E>(effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>) =>
        effect.pipe(Effect.provideContext(context))

      const failure =
        (operation: "start" | "describe" | "stop") => (error: { readonly _tag: string }) =>
          platformError({
            operation,
            code: TRANSIENT.has(error._tag) ? "unavailable" : "refused",
            name: error._tag,
          })

      const machineConfig = (input: StartInput): Machines.FlyMachineConfig => ({
        image: input.image,
        env: input.environment,
        guest: {
          cpu_kind: options.guest.cpuKind,
          cpus: options.guest.cpus,
          memory_mb: options.guest.memoryMb,
        },
        restart: { policy: "no" },
        stop_config: { signal: "SIGTERM", timeout: DRAIN },
        metadata: { [DEPLOYMENT_KEY]: input.deploymentId, [REGION_KEY]: input.region },
        ...(options.command === undefined
          ? {
              services: [
                {
                  protocol: "tcp",
                  internal_port: options.port,
                  autostart: false,
                  autostop: "off",
                  concurrency: { type: "connections", soft_limit: 1000, hard_limit: 2000 },
                  ports: [
                    { port: 443, handlers: ["tls", "http"] },
                    { port: 80, handlers: ["http"], force_https: true },
                  ],
                },
              ],
            }
          : { init: { cmd: [...options.command] } }),
      })

      const runner = Effect.fnUntraced(function* (
        operation: "start" | "describe",
        app: string,
        machine: Machines.Machine,
      ) {
        if (machine.id === undefined) return yield* platformError({ operation, code: "unreadable" })

        const state = stateOf(machine.state)
        const observed: Runner = {
          id: `${app}/${machine.id}`,
          state,
          url: state === "stopped" || oneShot ? null : `https://${app}.fly.dev`,
          basePath,
        }

        return state === "stopped" && exitOf(machine) !== undefined
          ? { ...observed, terminated: true }
          : observed
      })

      const locate = (id: string) => {
        const named = splitRunnerId(id)

        return named !== undefined &&
          named.app.startsWith(options.appPrefix) &&
          /^[a-z][a-z0-9-]{0,29}$/u.test(named.app) &&
          /^[a-z0-9]{1,32}$/u.test(named.machine)
          ? Effect.succeed(named)
          : Effect.fail(RunnerNotFound.make({ id }))
      }

      const read = (operation: "describe" | "stop", app: string, machine: string) =>
        inFly(Machines.getMachine({ app_name: app, machine_id: machine })).pipe(
          Effect.mapError((error): RunnerNotFound | RunnerPlatformError =>
            Predicate.isTagged(error, "NotFound")
              ? RunnerNotFound.make({ id: `${app}/${machine}` })
              : failure(operation)(error),
          ),
        )

      const destroy = (app: string, machine: string, force: boolean) =>
        inFly(Machines.deleteMachine({ app_name: app, machine_id: machine, force })).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.asVoid,
          Effect.mapError(failure("stop")),
        )

      const stop = Effect.fnUntraced(function* (id: string) {
        const { app, machine } = yield* locate(id)
        const found = yield* read("stop", app, machine)

        if (found.state === "created" || found.state === "starting")
          return yield* destroy(app, machine, true)

        if (found.state === "started")
          yield* inFly(
            Machines.stopMachine({
              app_name: app,
              machine_id: machine,
              signal: "SIGTERM",
              timeout: DRAIN,
            }),
          ).pipe(Effect.mapError(failure("stop")))

        const settled = yield* inFly(
          Machines.getMachine({ app_name: app, machine_id: machine }),
        ).pipe(
          Effect.asSome,
          Effect.catchTag("NotFound", () => Effect.succeedNone),
          Effect.mapError(failure("stop")),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (current) => Option.isNone(current) || FINISHED.has(current.value.state ?? ""),
          }),
          Effect.timeoutOption("2 minutes"),
        )

        if (Option.isNone(settled))
          return yield* platformError({ operation: "stop", code: "unavailable" })

        const last = settled.value

        if (
          Option.isSome(last) &&
          (last.value.state === "stopped" || last.value.state === "suspended")
        )
          yield* destroy(app, machine, false)
      })

      const ensureApp = Effect.fnUntraced(function* (app: string, key: string) {
        const existing = yield* inFly(Machines.getApp({ app_name: app })).pipe(
          Effect.asSome,
          Effect.catchTag("NotFound", () => Effect.succeedNone),
          Effect.mapError(failure("start")),
        )

        if (Option.isNone(existing))
          yield* inFly(
            Machines.createApp({
              name: app,
              org_slug: options.organization,
              network: app,
              idempotency_key: key,
            }),
          ).pipe(
            Effect.catchTags({
              Conflict: () => Effect.void,
              UnprocessableEntity: () => Effect.void,
            }),
            Effect.mapError(failure("start")),
          )

        const current = Option.isSome(existing)
          ? existing.value
          : yield* inFly(Machines.getApp({ app_name: app })).pipe(
              Effect.retry({
                schedule: Schedule.spaced("500 millis"),
                times: 10,
                while: (error) => Predicate.isTagged(error, "NotFound"),
              }),
              Effect.mapError(failure("start")),
            )

        if (
          current.organization?.slug !== undefined &&
          current.organization.slug !== options.organization
        )
          return yield* platformError({ operation: "start", code: "refused" })

        if (oneShot) return

        const addresses = yield* inFly(Machines.listAppIPAssignments({ app_name: app })).pipe(
          Effect.map((response) =>
            (response.ips ?? []).filter(
              (assignment) =>
                assignment.ip !== undefined &&
                assignment.egress !== true &&
                (assignment.network === undefined || assignment.network === null),
            ),
          ),
          Effect.mapError(failure("start")),
        )

        for (const type of ["shared_v4", "v6"] as const) {
          if (addresses.some((assignment) => assignment.ip?.includes(":") === (type === "v6")))
            continue

          yield* inFly(Machines.createAppIPAssignment({ app_name: app, type })).pipe(
            Effect.catchTag("Conflict", () => Effect.void),
            Effect.mapError(failure("start")),
          )
        }
      })

      const findMachine = Effect.fnUntraced(function* (
        app: string,
        name: string,
        deploymentId: string,
      ) {
        const machines = yield* inFly(Machines.listMachines({ app_name: app })).pipe(
          Effect.mapError(failure("start")),
        )

        const foreign = machines.some(
          (machine) =>
            machine.config?.metadata?.[DEPLOYMENT_KEY] !== undefined &&
            machine.config.metadata[DEPLOYMENT_KEY] !== deploymentId,
        )

        if (foreign) return yield* platformError({ operation: "start", code: "refused" })

        return Option.fromNullishOr(machines.find((machine) => machine.name === name))
      })

      const place = (
        app: string,
        name: string,
        deploymentId: string,
        config: Machines.FlyMachineConfig,
        regions: ReadonlyArray<string>,
      ): Effect.Effect<Machines.Machine, RunnerPlatformError> =>
        inFly(Machines.createMachine({ app_name: app, name, region: regions[0], config })).pipe(
          Effect.catch((error) => {
            if (hasMessage(error) && CAPACITY.test(error.message))
              return regions.length > 1
                ? place(app, name, deploymentId, config, regions.slice(1))
                : Effect.fail(platformError({ operation: "start", code: "capacity" }))

            return findMachine(app, name, deploymentId).pipe(
              Effect.orElseSucceed(() => Option.none<Machines.Machine>()),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(failure("start")(error)),
                  onSome: Effect.succeed,
                }),
              ),
            )
          }),
        )

      return RunnerPlatform.of({
        start: Effect.fnUntraced(function* (request) {
          const input = yield* decodeStart(request)

          if (!Object.hasOwn(options.regions, input.region))
            return yield* platformError({ operation: "start", code: "unknown-region" })

          if (!IMAGE.test(input.image))
            return yield* platformError({ operation: "start", code: "invalid-input" })

          const placement = options.regions[input.region]!
          const token = yield* startToken(input).pipe(Effect.provideService(Crypto.Crypto, crypto))
          const digest = yield* hashHex(`akter-runner-app\0${input.deploymentId}`).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          )
          const app = `${options.appPrefix}${digest.slice(0, APP_NAME_LENGTH - options.appPrefix.length)}`
          const name = `run-${token.slice(0, 32)}`

          yield* ensureApp(app, digest.slice(0, 32))

          const existing = yield* findMachine(app, name, input.deploymentId)

          if (Option.isSome(existing)) return yield* runner("start", app, existing.value)

          return yield* runner(
            "start",
            app,
            yield* place(app, name, input.deploymentId, machineConfig(input), [
              placement.region,
              ...(placement.fallbackRegions ?? []),
            ]),
          )
        }),

        describe: Effect.fnUntraced(function* (id) {
          const { app, machine } = yield* locate(id)

          return yield* runner("describe", app, yield* read("describe", app, machine))
        }),

        stop,
      })
    }),
  )
