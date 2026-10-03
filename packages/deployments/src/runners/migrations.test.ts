import { Credentials } from "@distilled.cloud/aws/Credentials"
import * as Endpoint from "@distilled.cloud/aws/Endpoint"
import { BunCrypto } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ecsMigrations, ImageMigrations } from "./migrations.ts"

const taskArn = "arn:aws:ecs:us-east-1:111122223333:task/cluster/migration"

for (const exitCode of [0, 19, undefined]) {
  it.effect(
    `requires the migration container's actual successful exit, not only STOPPED (${String(exitCode)})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: Array<{ operation: string; body: Record<string, unknown> }> = []
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                fetch: async (request) => {
                  const operation = request.headers.get("x-amz-target")?.split(".").at(-1) ?? ""
                  const body = (await request.json()) as Record<string, unknown>
                  calls.push({ operation, body })
                  const task = {
                    taskArn,
                    lastStatus: "STOPPED",
                    desiredStatus: "STOPPED",
                    attributes: [{ name: "ecs.cpu-architecture", value: "arm64" }],
                    containers: [{ name: "runner", exitCode }],
                  }
                  return Response.json({ tasks: [task], failures: [] })
                },
              }),
            ),
            (server) => Effect.promise(() => server.stop(true)),
          )
          const context = yield* Layer.build(
            ecsMigrations({
              regions: {
                "us-east-1": {
                  cluster: "cluster",
                  subnets: ["subnet-one"],
                  securityGroups: ["sg-one"],
                },
              },
              taskDefinition: () => "example:7",
              container: "runner",
              port: 8080,
              command: ["bun", "run", "migrate"],
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  FetchHttpClient.layer,
                  BunCrypto.layer,
                  Endpoint.of(`http://127.0.0.1:${server.port}`),
                  Layer.succeed(
                    Credentials,
                    Effect.succeed({
                      accessKeyId: Redacted.make("AKIDEXAMPLE"),
                      secretAccessKey: Redacted.make("fake-http-only"),
                      sessionToken: undefined,
                      region: "us-east-1" as const,
                    }),
                  ),
                ),
              ),
            ),
          )
          const result = yield* Context.get(context, ImageMigrations)
            .run({
              deploymentId: "migration-test",
              region: "us-east-1",
              image: `example@sha256:${"a".repeat(64)}`,
              environment: { DATABASE_URL: "postgres://cell/db" },
              idempotencyKey: "migration-job",
            })
            .pipe(Effect.exit)
          expect(result._tag).toBe(exitCode === 0 ? "Success" : "Failure")
          expect(calls.map(({ operation }) => operation)).toEqual([
            "RunTask",
            "DescribeTasks",
            "DescribeTasks",
          ])
          expect(calls[0]?.body.overrides).toEqual({
            containerOverrides: [
              {
                name: "runner",
                environment: [{ name: "DATABASE_URL", value: "postgres://cell/db" }],
                command: ["bun", "run", "migrate"],
              },
            ],
          })
        }),
      ),
  )
}
