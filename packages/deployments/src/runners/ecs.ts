import {
  describeTaskDefinition,
  describeTasks,
  registerTaskDefinition,
  runTask,
  stopTask,
  type Task,
  type TaskDefinition,
} from "@distilled.cloud/aws/ecs"
import { Credentials } from "@distilled.cloud/aws/Credentials"
import { Region, type RegionName } from "@distilled.cloud/aws/Region"
import { Crypto, Effect, Layer, Option, Predicate, Schedule } from "effect"
import { HttpClient } from "effect/http"
import {
  decodeStart,
  hashHex,
  startToken,
  type Runner,
  RunnerNotFound,
  RunnerPlatform,
  platformError,
  type RunnerState,
} from "./contract.ts"

/** The cluster and awsvpc network a region's runners are placed in. */
export interface EcsRegion {
  readonly cluster: string
  readonly subnets: ReadonlyArray<string>
  readonly securityGroups: ReadonlyArray<string>
}

/**
 * The Fargate task definition the layer registers for each image, in the
 * family `akter-runner-<hash of the image>`: awsvpc, ARM64, one essential
 * container named `container` that listens on `port`. `cpu` and `memory` are
 * Fargate's units and default to 512 and 1024.
 */
export interface EcsDefinition {
  readonly executionRoleArn: string
  readonly taskRoleArn?: string
  readonly cpu?: string
  readonly memory?: string
}

/**
 * What the caller decides about hosted runners; the layer reads no
 * credentials or environment, and takes `Credentials` and `HttpClient` from
 * its context.
 *
 * `regions` is keyed by AWS region name, which is also the Akter region a
 * start names; a region not listed is refused. `RunTask` cannot change the
 * image, so a task definition has to hold it, and the caller picks how:
 * `taskDefinition` names an ARM64 Fargate definition (family:revision or ARN)
 * that already runs `image`; or `definition` has the layer register one per
 * image, which requires `image` to end in `@sha256:<digest>` so a family
 * always means one image. `container` is the container in the definition that
 * receives the environment snapshot, and `command` replaces its command, as a
 * one-shot task needs. `port` is where the runner listens on the task's
 * private address.
 */
export type EcsOptions = {
  readonly regions: Readonly<Record<string, EcsRegion>>
  readonly container: string
  readonly port: number
  readonly basePath?: string
  readonly scheme?: "http" | "https"
  readonly command?: ReadonlyArray<string>
} & (
  | { readonly taskDefinition: (image: string) => string; readonly definition?: undefined }
  | { readonly definition: EcsDefinition; readonly taskDefinition?: undefined }
)

const starting = new Set(["PROVISIONING", "PENDING", "ACTIVATING"])

/** ECS names its failure reasons in capitals (`RESOURCE:FARGATE`); anything else is dropped. */
const failureName = (reason: string | undefined) =>
  reason !== undefined && /^[A-Z][A-Z0-9:_-]{0,63}$/u.test(reason) ? reason : undefined

/**
 * `RunnerPlatform` over ECS Fargate through Distilled's `RunTask`,
 * `DescribeTasks` and `StopTask`. A runner's id is its task ARN, which names
 * its region. The hash of the start's deployment and idempotency key is the `RunTask` client token, so a
 * repeated start returns the same task.
 *
 * ECS starts a task in `PROVISIONING` and attaches its network interface a
 * little later, so a start usually returns no url; `describe` returns it once
 * the interface has a private address.
 */
export const ecsRunners = (options: EcsOptions) =>
  Layer.effect(
    RunnerPlatform,
    Effect.gen(function* () {
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient>()
      const crypto = yield* Crypto.Crypto
      const basePath = options.basePath ?? ""

      const runner = (task: Task): Runner => {
        const address = task.attachments
          ?.find((attachment) => attachment.type === "ElasticNetworkInterface")
          ?.details?.find((detail) => detail.name === "privateIPv4Address")?.value

        const state: RunnerState =
          task.desiredStatus === "STOPPED"
            ? "stopped"
            : starting.has(task.lastStatus ?? "")
              ? "starting"
              : task.lastStatus === "RUNNING"
                ? "running"
                : "stopped"

        const observed: Runner = {
          id: task.taskArn ?? "",
          state,
          url:
            state === "stopped" || address === undefined
              ? null
              : `${options.scheme ?? "https"}://${address}:${options.port}`,
          basePath,
        }

        return task.lastStatus === "STOPPED" ? { ...observed, terminated: true } : observed
      }

      const locate = (id: string) => {
        const region = id.split(":")[3] ?? ""
        const placement = options.regions[region]

        return placement === undefined
          ? Effect.fail(RunnerNotFound.make({ id }))
          : Effect.succeed({ region: region as RegionName, cluster: placement.cluster })
      }

      const inRegion = <A, E>(
        region: string,
        effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
      ) =>
        effect.pipe(
          Effect.provideService(Region, Effect.succeed(region as RegionName)),
          Effect.provideContext(context),
        )

      const stop = Effect.fnUntraced(function* (id: string) {
        const { region, cluster } = yield* locate(id)

        yield* inRegion(
          region,
          stopTask({ cluster, task: id, reason: "drain requested by runner platform" }),
        ).pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error, "InvalidParameterException") &&
            /not found/iu.test(error.message ?? "")
              ? RunnerNotFound.make({ id })
              : platformError({ operation: "stop", code: "refused", name: error._tag }),
          ),
        )
        const stopped = yield* inRegion(region, describeTasks({ cluster, tasks: [id] })).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (response) =>
              response.tasks?.[0]?.lastStatus === "STOPPED" ||
              response.failures?.some((failure) => failure.reason === "MISSING") === true,
          }),
          Effect.timeoutOption("2 minutes"),
          Effect.mapError(() => platformError({ operation: "stop", code: "unavailable" })),
        )
        if (Option.isNone(stopped))
          return yield* platformError({ operation: "stop", code: "unavailable" })
      })

      const ensureDefinition = Effect.fnUntraced(function* (
        region: string,
        image: string,
        definition: EcsDefinition,
      ) {
        if (!/@sha256:[0-9a-f]{64}$/u.test(image))
          return yield* platformError({ operation: "start", code: "invalid-input" })

        const family = `akter-runner-${(yield* hashHex(image).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        )).slice(0, 32)}`

        const matches = (found: TaskDefinition | undefined) =>
          found?.status === "ACTIVE" &&
          found.networkMode === "awsvpc" &&
          found.runtimePlatform?.cpuArchitecture === "ARM64" &&
          found.containerDefinitions?.length === 1 &&
          found.containerDefinitions[0]?.name === options.container &&
          found.containerDefinitions[0].image === image

        const existing = yield* inRegion(
          region,
          describeTaskDefinition({ taskDefinition: family }),
        ).pipe(
          Effect.map((response) => response.taskDefinition),
          Effect.catchTag("ClientException", () => Effect.succeed(null)),
          Effect.mapError((error) =>
            platformError({ operation: "start", code: "refused", name: error._tag }),
          ),
        )

        if (existing !== null)
          return matches(existing)
            ? family
            : yield* platformError({ operation: "start", code: "definition-mismatch" })

        const registered = yield* inRegion(
          region,
          registerTaskDefinition({
            family,
            requiresCompatibilities: ["FARGATE"],
            networkMode: "awsvpc",
            runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
            cpu: definition.cpu ?? "512",
            memory: definition.memory ?? "1024",
            executionRoleArn: definition.executionRoleArn,
            taskRoleArn: definition.taskRoleArn,
            containerDefinitions: [
              {
                name: options.container,
                image,
                essential: true,
                portMappings: [{ containerPort: options.port, protocol: "tcp" }],
              },
            ],
          }),
        ).pipe(
          Effect.mapError((error) =>
            platformError({ operation: "start", code: "refused", name: error._tag }),
          ),
        )

        return matches(registered.taskDefinition)
          ? family
          : yield* platformError({ operation: "start", code: "definition-mismatch" })
      })

      return RunnerPlatform.of({
        start: Effect.fnUntraced(function* (request) {
          const input = yield* decodeStart(request)
          const placement = options.regions[input.region]
          const token = yield* startToken(input).pipe(Effect.provideService(Crypto.Crypto, crypto))

          if (placement === undefined)
            return yield* platformError({ operation: "start", code: "unknown-region" })

          const taskDefinition =
            options.definition === undefined
              ? options.taskDefinition(input.image)
              : yield* ensureDefinition(input.region, input.image, options.definition)

          const response = yield* inRegion(
            input.region,
            runTask({
              cluster: placement.cluster,
              taskDefinition,
              count: 1,
              launchType: "FARGATE",
              platformVersion: "LATEST",
              networkConfiguration: {
                awsvpcConfiguration: {
                  subnets: [...placement.subnets],
                  securityGroups: [...placement.securityGroups],
                  assignPublicIp: "DISABLED",
                },
              },
              overrides: {
                containerOverrides: [
                  {
                    name: options.container,
                    command: options.command === undefined ? undefined : [...options.command],
                    environment: Object.entries(input.environment).map(([name, value]) => ({
                      name,
                      value,
                    })),
                  },
                ],
              },
              startedBy: "akter-runners",
              group: `deployment:${input.deploymentId}`,
              tags: [{ key: "akter:deployment", value: input.deploymentId }],
              clientToken: token,
            }),
          ).pipe(
            Effect.mapError((error) =>
              platformError({ operation: "start", code: "refused", name: error._tag }),
            ),
          )

          const task = response.tasks?.[0]

          if (task === undefined) {
            return yield* platformError({
              operation: "start",
              code: "no-task",
              name: failureName(response.failures?.[0]?.reason),
            })
          }

          const architecture = task.attributes?.find(
            (attribute) => attribute.name === "ecs.cpu-architecture",
          )?.value

          if (architecture !== undefined && architecture !== "arm64") {
            yield* stop(task.taskArn ?? "").pipe(Effect.ignore)

            return yield* platformError({ operation: "start", code: "wrong-architecture" })
          }

          return runner(task)
        }),

        describe: Effect.fnUntraced(function* (id) {
          const { region, cluster } = yield* locate(id)

          const response = yield* inRegion(region, describeTasks({ cluster, tasks: [id] })).pipe(
            Effect.mapError((error) =>
              platformError({ operation: "describe", code: "refused", name: error._tag }),
            ),
          )

          const task = response.tasks?.[0]

          if (task !== undefined) return runner(task)

          const failure = response.failures?.[0]

          if (failure === undefined || failure.reason === "MISSING")
            return yield* RunnerNotFound.make({ id })

          return yield* platformError({
            operation: "describe",
            code: "refused",
            name: failureName(failure.reason),
          })
        }),

        stop,
      })
    }),
  )
