import { afterAll, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Schema } from "effect"
import { preview, previewLayer } from "./preview.ts"

const runtime = ManagedRuntime.make(previewLayer)
afterAll(() => runtime.dispose())

const Ingress = Schema.Struct({
  ipProtocol: Schema.String,
  fromPort: Schema.Int,
  toPort: Schema.Int,
  referencedGroupId: Schema.optional(Schema.String),
  cidrIpv4: Schema.optional(Schema.String),
})
const SecurityGroup = Schema.Struct({ ingress: Schema.optional(Schema.Array(Ingress)) })
const Statement = Schema.Struct({
  Effect: Schema.String,
  Action: Schema.Array(Schema.String),
  Resource: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  Condition: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
})
const Role = Schema.Struct({
  managedPolicyArns: Schema.optional(Schema.Array(Schema.String)),
  inlinePolicies: Schema.Record(
    Schema.String,
    Schema.Struct({ Statement: Schema.Array(Statement) }),
  ),
})
const TaskDefinition = Schema.Struct({
  containerDefinitions: Schema.Array(
    Schema.Struct({
      environment: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
      secrets: Schema.Array(Schema.Struct({ name: Schema.String, valueFrom: Schema.String })),
    }),
  ),
})
const Service = Schema.Struct({ securityGroups: Schema.Array(Schema.String) })
const RunnerPlacement = Schema.fromJsonString(
  Schema.Struct({
    regions: Schema.Record(
      Schema.String,
      Schema.Struct({ cluster: Schema.String, securityGroups: Schema.Array(Schema.String) }),
    ),
    definition: Schema.Record(Schema.String, Schema.String),
  }),
)

const decodeGroup = Schema.decodeUnknownEffect(SecurityGroup)
const decodeRole = Schema.decodeUnknownEffect(Role)
const decodeTask = Schema.decodeUnknownEffect(TaskDefinition)
const decodeService = Schema.decodeUnknownEffect(Service)
const decodePlacement = Schema.decodeUnknownEffect(RunnerPlacement)

const accounts = { dev: "111111111111", staging: "222222222222", prod: "333333333333" }

describe("credential-free resource graph", () => {
  for (const stage of ["dev", "staging", "prod"] as const) {
    for (const region of ["us-east-1", "us-west-2"] as const) {
      it(`registers all services and their providers in ${stage}/${region}`, () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const graph = yield* preview({ stage, region })
            expect(graph.stage).toBe(stage)
            expect(graph.name).toBe(`akter-${region}`)
            expect(graph.deletionProtection).toEqual({
              nlb: stage === "prod" ? "true" : "false",
              database: stage === "prod",
            })
            for (const name of ["api", "edge", "console"]) {
              expect(graph.resources).toContainEqual({
                id: `${name}/Task`,
                type: "AWS.ECS.TaskDefinition",
              })
              expect(graph.resources).toContainEqual({
                id: `${name}/Service`,
                type: "AWS.ECS.Service",
              })
              expect(graph.resources).toContainEqual({
                id: `${name}/Target`,
                type: "AWS.ELBv2.TargetGroup",
              })
              expect(graph.resources).toContainEqual({
                id: `${name}/Listener`,
                type: "AWS.ELBv2.Listener",
              })
            }
            expect(graph.resources).toContainEqual({
              id: "CustomerEnvironmentKey",
              type: "AWS.KMS.Key",
            })
            expect(graph.resources).toContainEqual({
              id: "EmailIdentity",
              type: "AWS.SES.EmailIdentity",
            })
            expect(graph.resources).toContainEqual({ id: "ServiceErrors", type: "Axiom.Monitor" })
            expect(graph.resources).toContainEqual({
              id: "Database",
              type: "Planetscale.NekiDatabase",
            })
            expect(graph.resources).toContainEqual({
              id: "RuntimeRole",
              type: "Planetscale.NekiRole",
            })
            expect(graph.resources).toContainEqual({
              id: "CustomerHosts/app.customer.example",
              type: "Cloudflare.CustomHostname.CustomHostname",
            })
          }),
        ))

      it(`lets only the edge reach runners and the API launch only scoped runner tasks in ${stage}/${region}`, () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const graph = yield* preview({ stage, region })
            const account = accounts[stage]
            const groups = yield* Effect.forEach(
              graph.resources.filter(({ type }) => type === "AWS.EC2.SecurityGroup"),
              ({ id }) =>
                decodeGroup(graph.declarations[id]).pipe(
                  Effect.map(({ ingress }) => ({ id, ingress: ingress ?? [] })),
                ),
            )
            const services = yield* Effect.forEach(
              graph.resources.filter(({ type }) => type === "AWS.ECS.Service"),
              ({ id }) =>
                decodeService(graph.declarations[id]).pipe(
                  Effect.map(({ securityGroups }) => ({ id, securityGroups })),
                ),
            )
            const ingressOf = (id: string) => groups.find((group) => group.id === id)?.ingress

            expect(
              graph.resources.filter(({ type }) => type === "AWS.EC2.SecurityGroupRule"),
            ).toEqual([])
            expect(graph.resources.map(({ id }) => id)).not.toContain("RunnerEnvironment")
            expect(
              groups.flatMap(({ ingress }) =>
                ingress.filter((rule) => rule.fromPort <= 9000 && 9000 <= rule.toPort),
              ),
            ).toEqual([])
            expect(ingressOf("RunnerGroup")).toEqual([
              {
                ipProtocol: "tcp",
                fromPort: 8080,
                toPort: 8080,
                referencedGroupId: "EdgeGroup.groupId",
              },
            ])
            expect(ingressOf("EdgeGroup")).toEqual([
              {
                ipProtocol: "tcp",
                fromPort: 3002,
                toPort: 3002,
                referencedGroupId: "LoadBalancerGroup.groupId",
              },
            ])
            expect(
              services.flatMap(({ id, securityGroups }) =>
                securityGroups.includes("EdgeGroup.groupId") ? [id] : [],
              ),
            ).toEqual(["edge/Service"])
            expect(services.find(({ id }) => id === "edge/Service")?.securityGroups).toEqual([
              "EdgeGroup.groupId",
            ])

            const runner = yield* decodeRole(graph.declarations["RunnerExecutionRole"])

            expect(runner.managedPolicyArns ?? []).toEqual([])
            expect(
              Object.values(runner.inlinePolicies).flatMap(({ Statement }) => Statement),
            ).toEqual([
              { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
              {
                Effect: "Allow",
                Action: [
                  "ecr:BatchCheckLayerAvailability",
                  "ecr:GetDownloadUrlForLayer",
                  "ecr:BatchGetImage",
                ],
                Resource: [
                  "RunnerBase.repositoryArn",
                  `arn:aws:ecr:${region}:${account}:repository/akter/runners/*`,
                ],
              },
            ])

            const api = yield* decodeRole(graph.declarations["ApiRole"])
            const apiStatements = Object.values(api.inlinePolicies).flatMap(
              ({ Statement }) => Statement,
            )
            const runnerFamily = `arn:aws:ecs:${region}:${account}:task-definition/akter-runner-*`
            const clusterTasks = `arn:aws:ecs:${region}:${account}:task/Cluster.clusterName/*`
            const passRunnerRole = {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: "RunnerExecutionRole.roleArn",
              Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
            }

            expect(api.inlinePolicies["RunnerProvisioning"]?.Statement).toEqual([
              { Effect: "Allow", Action: ["ecs:RegisterTaskDefinition"], Resource: runnerFamily },
              { Effect: "Allow", Action: ["ecs:DescribeTaskDefinition"], Resource: "*" },
              {
                Effect: "Allow",
                Action: ["ecs:RunTask"],
                Resource: runnerFamily,
                Condition: { ArnEquals: { "ecs:cluster": "Cluster.clusterArn" } },
              },
              {
                Effect: "Allow",
                Action: ["ecs:StopTask", "ecs:DescribeTasks"],
                Resource: clusterTasks,
                Condition: {
                  ArnEquals: { "ecs:cluster": "Cluster.clusterArn" },
                  Null: { "aws:ResourceTag/akter:deployment": "false" },
                },
              },
              {
                Effect: "Allow",
                Action: ["ecs:TagResource"],
                Resource: clusterTasks,
                Condition: { StringEquals: { "ecs:CreateAction": "RunTask" } },
              },
              passRunnerRole,
            ])
            expect(
              apiStatements.filter(({ Action }) =>
                Action.some((action) => action.startsWith("iam:")),
              ),
            ).toEqual([passRunnerRole])
            expect(apiStatements.filter(({ Resource }) => Resource === "*")).toEqual([
              { Effect: "Allow", Action: ["ecs:DescribeTaskDefinition"], Resource: "*" },
            ])

            const [container] = (yield* decodeTask(graph.declarations["api/Task"]))
              .containerDefinitions
            const placement = yield* decodePlacement(
              container?.environment.find(({ name }) => name === "RUNNER_ECS_CONFIG")?.value,
            )

            expect(placement.definition).toEqual({
              executionRoleArn: "RunnerExecutionRole.roleArn",
            })
            expect(placement.regions[region]).toEqual({
              cluster: "Cluster.clusterArn",
              securityGroups: ["RunnerGroup.groupId"],
            })
            expect(
              [...(container?.environment ?? []), ...(container?.secrets ?? [])].map(
                ({ name }) => name,
              ),
            ).not.toContain("RUNNER_ENVIRONMENT")
            expect(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(graph.declarations),
            ).not.toContain("nonfunctional-offline-placeholder")
          }),
        ))
    }
  }
})
