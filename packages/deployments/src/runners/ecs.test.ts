import { Credentials } from "@distilled.cloud/aws/Credentials"
import * as Endpoint from "@distilled.cloud/aws/Endpoint"
import { BunCrypto } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Context, Crypto, Effect, Layer, Redacted, type Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { RunnerNotFound, RunnerPlatform, RunnerPlatformError, startToken } from "./contract.ts"
import { ecsRunners, type EcsDefinition } from "./ecs.ts"

const prefix = "AmazonEC2ContainerServiceV20141113."
const west = "arn:aws:ecs:us-west-2:111122223333:task/runners-west/0123456789abcdef"

type Body = { readonly [key: string]: Schema.Json }

interface Call {
  readonly operation: string
  readonly authorization: string
  readonly body: Body
}

interface Reply {
  readonly status?: number
  readonly body: object
}

/**
 * An ECS endpoint speaking the real wire protocol (AWS JSON 1.1 over POST /),
 * recording what Distilled sends and answering from the test's script.
 */
type Selection =
  | { readonly taskDefinition: (image: string) => string }
  | { readonly definition: EcsDefinition; readonly command?: ReadonlyArray<string> }

const callback = { taskDefinition: (image: string) => `runner-${image.split(":")[1]}:7` }

const fake = (script: (call: Call) => Reply, selection: Selection = callback) =>
  Effect.gen(function* () {
    const calls: Array<Call> = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: (request) =>
            request.json().then((body: Body) => {
              const call: Call = {
                operation: (request.headers.get("x-amz-target") ?? "").replace(prefix, ""),
                authorization: request.headers.get("authorization") ?? "",
                body,
              }
              calls.push(call)
              const reply = script(call)
              const headers = new Headers({ "content-type": "application/x-amz-json-1.1" })

              if (reply.status !== undefined)
                headers.set("x-amzn-errortype", String((reply.body as { __type?: string }).__type))

              return new Response(JSON.stringify(reply.body), {
                status: reply.status ?? 200,
                headers,
              })
            }),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )

    const context = yield* Layer.build(
      ecsRunners({
        regions: {
          "us-east-1": {
            cluster: "runners-east",
            subnets: ["subnet-e1"],
            securityGroups: ["sg-e1"],
          },
          "us-west-2": {
            cluster: "runners-west",
            subnets: ["subnet-w1", "subnet-w2"],
            securityGroups: ["sg-w1"],
          },
        },
        ...selection,
        container: "runner",
        port: 8080,
        basePath: "/api",
        scheme: "http",
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            FetchHttpClient.layer,
            BunCrypto.layer,
            Endpoint.of(`http://127.0.0.1:${server.port}`),
            Layer.succeed(
              Credentials,
              Effect.succeed({
                accessKeyId: Redacted.make("AKIDEXAMPLE"),
                secretAccessKey: Redacted.make("secret-for-signing-only"),
                sessionToken: undefined,
                region: "us-east-1" as const,
              }),
            ),
          ),
        ),
      ),
    )

    return {
      calls,
      platform: Context.get(context, RunnerPlatform),
      token: (input: Parameters<typeof startToken>[0]) =>
        startToken(input).pipe(
          Effect.provideService(Crypto.Crypto, Context.get(context, Crypto.Crypto)),
        ),
    }
  })

const task = (overrides: Body = {}) => ({
  taskArn: west,
  lastStatus: "PROVISIONING",
  desiredStatus: "RUNNING",
  attributes: [{ name: "ecs.cpu-architecture", value: "arm64" }],
  ...overrides,
})

const request = {
  deploymentId: "acme",
  region: "us-west-2",
  image: "registry.example/runner:v9",
  environment: { DATABASE_URL: "postgres://u:p@db/x?a=b&c=d", PLAIN: "two words" },
  idempotencyKey: "01JABC.5.start",
}

it.effect(
  "starts an ARM64 Fargate task in the region's cluster with the snapshot and a hashed client token",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, platform, token } = yield* fake(() => ({
          body: { tasks: [task()], failures: [] },
        }))

        const started = yield* platform.start(request)
        yield* platform.start(request)
        yield* platform.start({ ...request, idempotencyKey: "01JABC.6.start" })

        expect(started).toEqual({ id: west, state: "starting", url: null, basePath: "/api" })
        expect(calls.map((call) => call.operation)).toEqual(["RunTask", "RunTask", "RunTask"])
        expect(calls[0]?.authorization).toContain("/us-west-2/ecs/aws4_request")
        expect(calls[0]?.authorization).not.toContain("secret-for-signing-only")
        expect(calls[0]?.body).toEqual({
          cluster: "runners-west",
          taskDefinition: "runner-v9:7",
          count: 1,
          launchType: "FARGATE",
          platformVersion: "LATEST",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: ["subnet-w1", "subnet-w2"],
              securityGroups: ["sg-w1"],
              assignPublicIp: "DISABLED",
            },
          },
          overrides: {
            containerOverrides: [
              {
                name: "runner",
                environment: [
                  { name: "DATABASE_URL", value: "postgres://u:p@db/x?a=b&c=d" },
                  { name: "PLAIN", value: "two words" },
                ],
              },
            ],
          },
          startedBy: "akter-runners",
          group: "deployment:acme",
          tags: [{ key: "akter:deployment", value: "acme" }],
          clientToken: yield* token(request),
        })
        expect(calls[0]?.body.clientToken).toMatch(/^[0-9a-f]{64}$/u)
        expect(calls[1]?.body.clientToken).toBe(calls[0]?.body.clientToken)
        expect(calls[2]?.body.clientToken).not.toBe(calls[0]?.body.clientToken)
      }),
    ),
)

it.live(
  "reads state and the private address from DescribeTasks, and never reports a draining task as running",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let desired = "RUNNING"
        let stoppingReads = 0
        const { calls, platform } = yield* fake((call) =>
          call.operation === "StopTask"
            ? ((desired = "STOPPED"), { body: { task: task() } })
            : {
                body: {
                  tasks: [
                    task({
                      lastStatus:
                        desired === "STOPPED" && ++stoppingReads > 1 ? "STOPPED" : "RUNNING",
                      desiredStatus: desired,
                      attachments: [
                        {
                          type: "ElasticNetworkInterface",
                          details: [
                            { name: "subnetId", value: "subnet-w1" },
                            { name: "privateIPv4Address", value: "10.0.1.7" },
                          ],
                        },
                      ],
                    }),
                  ],
                  failures: [],
                },
              },
        )

        expect(yield* platform.describe(west)).toEqual({
          id: west,
          state: "running",
          url: "http://10.0.1.7:8080",
          basePath: "/api",
        })
        expect(calls[0]?.body).toEqual({ cluster: "runners-west", tasks: [west] })
        expect(calls[0]?.authorization).toContain("/us-west-2/ecs/aws4_request")

        yield* platform.stop(west)

        expect(calls[1]?.operation).toBe("StopTask")
        expect(calls[1]?.body).toMatchObject({ cluster: "runners-west", task: west })
        expect(stoppingReads).toBe(2)
        expect(yield* platform.describe(west)).toMatchObject({ state: "stopped", url: null })
      }),
    ),
)

it.effect(
  "reports a missing task, and refuses a task of an unconfigured region without calling ECS",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, platform } = yield* fake((call) =>
          call.operation === "StopTask"
            ? {
                status: 400,
                body: {
                  __type: "InvalidParameterException",
                  message: "The referenced task was not found.",
                },
              }
            : { body: { tasks: [], failures: [{ arn: west, reason: "MISSING" }] } },
        )

        expect(yield* Effect.flip(platform.describe(west))).toEqual(
          RunnerNotFound.make({ id: west }),
        )
        expect(yield* Effect.flip(platform.stop(west))).toEqual(RunnerNotFound.make({ id: west }))

        const elsewhere = "arn:aws:ecs:eu-west-1:111122223333:task/c/abc"
        const before = calls.length

        expect(yield* Effect.flip(platform.describe(elsewhere))).toEqual(
          RunnerNotFound.make({ id: elsewhere }),
        )
        expect(calls).toHaveLength(before)

        const refused = yield* Effect.flip(platform.start({ ...request, region: "eu-west-1" }))

        expect(refused).toBeInstanceOf(RunnerPlatformError)
        expect(calls).toHaveLength(before)

        const unnamed = yield* Effect.flip(
          platform.start({ ...request, environment: { "BAD NAME": "x" } }),
        )

        expect(unnamed.code).toBe("invalid-input")
        expect(calls).toHaveLength(before)
      }),
    ),
)

it.effect(
  "names the failure by fixed code and provider error name, never by what the provider echoed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = request.environment.DATABASE_URL
        let reply: Reply = {
          body: { tasks: [], failures: [{ arn: "x", reason: "RESOURCE:FARGATE" }] },
        }
        const { platform } = yield* fake(() => reply)

        const capacity = yield* Effect.flip(platform.start(request))
        reply = { body: { tasks: [], failures: [{ arn: "x", reason: `bad ${secret}` }] } }
        const echoed = yield* Effect.flip(platform.start(request))
        reply = {
          status: 400,
          body: {
            __type: "ClusterNotFoundException",
            message: `Cluster not found; overrides were ${secret}`,
          },
        }
        const cluster = yield* Effect.flip(platform.start(request))
        const described = yield* Effect.flip(platform.describe(west))

        expect(capacity).toEqual(
          RunnerPlatformError.make({
            operation: "start",
            code: "no-task",
            message: "the platform started no task (RESOURCE:FARGATE)",
          }),
        )
        expect(echoed.message).toBe("the platform started no task")
        expect(cluster).toEqual(
          RunnerPlatformError.make({
            operation: "start",
            code: "refused",
            message: "the platform refused the request (ClusterNotFoundException)",
          }),
        )
        expect(described.message).toBe(
          "the platform refused the request (ClusterNotFoundException)",
        )

        for (const error of [capacity, echoed, cluster, described])
          expect(`${error._tag} ${error.message}`).not.toContain("postgres://")
      }),
    ),
)

it.effect("stops and refuses a task that did not land on ARM64", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, platform } = yield* fake((call) =>
        call.operation === "RunTask"
          ? {
              body: {
                tasks: [task({ attributes: [{ name: "ecs.cpu-architecture", value: "x86_64" }] })],
              },
            }
          : call.operation === "DescribeTasks"
            ? { body: { tasks: [task({ lastStatus: "STOPPED", desiredStatus: "STOPPED" })] } }
            : { body: { task: task() } },
      )

      const refused = yield* Effect.flip(platform.start(request))

      expect(refused.code).toBe("wrong-architecture")
      expect(refused.message).not.toContain("x86_64")
      expect(calls.map((call) => call.operation)).toEqual(["RunTask", "StopTask", "DescribeTasks"])
      expect(calls[1]?.body).toMatchObject({ cluster: "runners-west", task: west })
    }),
  ),
)

const digest = (letter: string) => `registry.example/runner@sha256:${letter.repeat(64)}`
const familyA = "akter-runner-58dd4954c2c186bf1366c563c60547de"
const familyB = "akter-runner-ed9881746d0920bf2efab2ed1313205b"

const registered = (image: string, overrides: Body = {}) => ({
  taskDefinitionArn: "arn:aws:ecs:us-west-2:111122223333:task-definition/x:1",
  status: "ACTIVE",
  networkMode: "awsvpc",
  runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
  containerDefinitions: [{ name: "runner", image }],
  ...overrides,
})

const definition = {
  definition: { executionRoleArn: "arn:aws:iam::111122223333:role/exec", cpu: "1024" },
  command: ["bun", "migrate.ts"],
} as const

const notRegistered = {
  status: 400,
  body: {
    __type: "ClientException",
    message: `Unable to describe task definition for ${familyA}`,
  },
}

it.effect(
  "registers one immutable ARM64 definition per image digest and runs the task by family",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let known = false
        const { calls, platform } = yield* fake((call) => {
          if (call.operation === "DescribeTaskDefinition")
            return known ? { body: { taskDefinition: registered(digest("a")) } } : notRegistered
          if (call.operation === "RegisterTaskDefinition") {
            known = true
            return { body: { taskDefinition: registered(digest("a")) } }
          }
          return { body: { tasks: [task()] } }
        }, definition)

        yield* platform.start({ ...request, image: digest("a") })
        yield* platform.start({ ...request, image: digest("a") })

        expect(calls.map((call) => call.operation)).toEqual([
          "DescribeTaskDefinition",
          "RegisterTaskDefinition",
          "RunTask",
          "DescribeTaskDefinition",
          "RunTask",
        ])
        expect(calls[0]?.body).toEqual({ taskDefinition: familyA })
        expect(calls[1]?.authorization).toContain("/us-west-2/ecs/aws4_request")
        expect(calls[1]?.body).toEqual({
          family: familyA,
          requiresCompatibilities: ["FARGATE"],
          networkMode: "awsvpc",
          runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
          cpu: "1024",
          memory: "1024",
          executionRoleArn: "arn:aws:iam::111122223333:role/exec",
          containerDefinitions: [
            {
              name: "runner",
              image: digest("a"),
              essential: true,
              portMappings: [{ containerPort: 8080, protocol: "tcp" }],
            },
          ],
        })
        expect(calls[2]?.body).toMatchObject({
          taskDefinition: familyA,
          overrides: { containerOverrides: [{ name: "runner", command: ["bun", "migrate.ts"] }] },
        })
        expect(calls[4]?.body.taskDefinition).toBe(familyA)
        expect(calls[4]?.body.clientToken).toBe(calls[2]?.body.clientToken)
      }),
    ),
)

it.effect("uses a different family for a different digest", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, platform } = yield* fake(
        (call) =>
          call.operation === "DescribeTaskDefinition"
            ? { body: { taskDefinition: registered(digest("b")) } }
            : { body: { tasks: [task()] } },
        definition,
      )

      yield* platform.start({ ...request, image: digest("b") })

      expect(calls[0]?.body).toEqual({ taskDefinition: familyB })
      expect(calls[1]?.body.taskDefinition).toBe(familyB)
    }),
  ),
)

it.effect(
  "refuses an image without a digest, and a family that holds another image or architecture, before RunTask",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let found: Body = registered(digest("a"), {
          containerDefinitions: [{ name: "runner", image: digest("b") }],
        })
        const { calls, platform } = yield* fake(
          () => ({ body: { taskDefinition: found } }),
          definition,
        )

        const mutable = yield* Effect.flip(platform.start({ ...request, image: "runner:latest" }))

        expect(mutable.code).toBe("invalid-input")
        expect(calls).toHaveLength(0)

        const otherImage = yield* Effect.flip(platform.start({ ...request, image: digest("a") }))

        found = registered(digest("a"), { runtimePlatform: { cpuArchitecture: "X86_64" } })

        const otherArchitecture = yield* Effect.flip(
          platform.start({ ...request, image: digest("a") }),
        )

        expect(otherImage.code).toBe("definition-mismatch")
        expect(otherArchitecture.code).toBe("definition-mismatch")
        expect(calls.map((call) => call.operation)).toEqual([
          "DescribeTaskDefinition",
          "DescribeTaskDefinition",
        ])
      }),
    ),
)
