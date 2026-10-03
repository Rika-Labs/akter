import { createHash, createHmac } from "node:crypto"
import {
  ActivationRefused,
  PlatformFailure,
  Region,
  RolloutPlatform,
  RolloutRouting,
} from "@akter/deployments/lifecycle"
import { Runners, runnerActor } from "@akter/deployments/runners"
import { Context, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/sql"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { ApiOptions } from "./config.ts"
import { Repository } from "./repository.ts"

/** The control-plane service credential is deployment-bound and only its hash is stored at the edge. */
export const serviceCredential = (secret: Redacted.Redacted<string>, deploymentId: string) =>
  Redacted.make(
    createHmac("sha256", Redacted.value(secret))
      .update(`akter-control-plane/v1\0${deploymentId}`)
      .digest("hex"),
  )

export const environmentHost = (options: ApiOptions, projectId: string, environment: string) =>
  `${projectId.replaceAll("_", "-")}-${environment}.${options.deploymentDomain ?? "localhost"}`

const Snapshot = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

/** The environment pointer, host mapping and lifecycle status share the same fenced actor transaction. */
export const rolloutRouting = (options: ApiOptions) =>
  Layer.effect(
    RolloutRouting,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const repository = yield* Repository
      return {
        register: Effect.fn(function* (release) {
          const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(release.envSnapshot).pipe(
            Effect.catch(() =>
              Effect.die(new Error("The recorded environment snapshot is invalid")),
            ),
          )
          const [source] =
            release.rolledBackFrom == null
              ? []
              : yield* sql<{
                  environment: Readonly<Record<string, string>>
                }>`SELECT environment_snapshot AS environment FROM deployment WHERE id = ${release.rolledBackFrom}`.pipe(
                  Effect.orDie,
                )
          if (release.rolledBackFrom != null && source === undefined)
            return yield* Effect.die(new Error("The rollback environment snapshot is unavailable"))
          const tier = options.enterpriseOrganizations?.includes(release.organizationId)
            ? "enterprise"
            : options.paidOrganizations?.includes(release.organizationId)
              ? "pro"
              : "free"
          const environment = {
            ...(source?.environment ?? { ...snapshot, ...options.runnerEnvironment }),
            DEPLOYMENT_ID: release.deploymentId,
            ASSERTION_AUDIENCE: release.deploymentId,
            ASSERTION_REGION: release.regions[0] ?? "us-east-1",
            RUNNER_REGION: release.regions[0] ?? "us-east-1",
          }
          yield* sql`INSERT INTO deployment (id, primary_region, scale_to_zero, tier, image, environment_snapshot, serving) VALUES (${release.deploymentId}, ${release.regions[0] ?? "us-east-1"}, ${tier === "free"}, ${tier}, ${release.imageDigest}, ${JSON.stringify(environment)}::jsonb, false) ON CONFLICT (id) DO NOTHING`.pipe(
            Effect.orDie,
          )
          const hash = createHash("sha256")
            .update(Redacted.value(serviceCredential(options.secret, release.deploymentId)))
            .digest("hex")
          yield* sql`INSERT INTO hosted_api_key (key_hash, deployment_id, tenant, subject) VALUES (${hash}, ${release.deploymentId}, 'default', 'akter-control-plane') ON CONFLICT (key_hash) DO NOTHING`.pipe(
            Effect.orDie,
          )
          yield* sql`INSERT INTO deployment_host (host, deployment_id) VALUES (${`${release.deploymentId}.${options.deploymentDomain ?? "localhost"}`}, ${release.deploymentId}) ON CONFLICT (host) DO NOTHING`.pipe(
            Effect.orDie,
          )
        }),
        activate: Effect.fn(function* (release) {
          const subject = release.initiator
          if (
            subject === undefined ||
            (!subject.startsWith("user:") && !subject.startsWith("api-key:"))
          )
            return yield* Effect.die(
              new Error("Deployment activation requires verified audit attribution"),
            )
          const kind = subject.startsWith("api-key:") ? ("api-key" as const) : ("user" as const)
          const actorId = subject.slice(kind === "api-key" ? 8 : 5)
          const changed = yield* repository.activateDeployment({
            ...release,
            actor: { kind, id: actorId },
          })
          if (!changed)
            return yield* ActivationRefused.make({
              reason: "The live environment changed before activation",
            })
          const host = environmentHost(options, release.projectId, release.environment)
          yield* sql`INSERT INTO deployment_host (host, deployment_id) VALUES (${host}, ${release.deploymentId}) ON CONFLICT (host) DO UPDATE SET deployment_id = EXCLUDED.deployment_id`.pipe(
            Effect.orDie,
          )
          yield* sql`UPDATE deployment SET serving = id = ${release.deploymentId}, last_activity_at = CASE WHEN id = ${release.deploymentId} THEN now() ELSE last_activity_at END WHERE id IN (${release.deploymentId}, ${release.previousDeploymentId})`.pipe(
            Effect.orDie,
          )
          if (release.previousDeploymentId !== null) {
            yield* sql`UPDATE deployment_host SET deployment_id = ${release.deploymentId} WHERE deployment_id = ${release.previousDeploymentId} AND host <> ${`${release.previousDeploymentId}.${options.deploymentDomain ?? "localhost"}`}`.pipe(
              Effect.orDie,
            )
            yield* sql`INSERT INTO deployment_jwt (deployment_id, issuer, audience, jwks_url, algorithms, tenant_claim, tenant_fixed, subject_claim) SELECT ${release.deploymentId}, issuer, audience, jwks_url, algorithms, tenant_claim, tenant_fixed, subject_claim FROM deployment_jwt WHERE deployment_id = ${release.previousDeploymentId} ON CONFLICT (deployment_id) DO NOTHING`.pipe(
              Effect.orDie,
            )
            yield* sql`UPDATE hosted_api_key SET deployment_id = ${release.deploymentId} WHERE deployment_id = ${release.previousDeploymentId} AND subject <> 'akter-control-plane'`.pipe(
              Effect.orDie,
            )
            yield* sql`UPDATE hosted_api_key SET revoked_at = now() WHERE deployment_id = ${release.previousDeploymentId} AND subject = 'akter-control-plane'`.pipe(
              Effect.orDie,
            )
          }
        }),
      } satisfies RolloutRouting["Service"]
    }),
  )

/** Rollout jobs request durable runner capacity, then wait for the same readiness route the edge uses. */
export const rolloutPlatform = (
  options: ApiOptions,
  migrate: RolloutPlatform["Service"]["migrate"],
) =>
  Layer.effect(
    RolloutPlatform,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const runtime = Context.omit(SqlClient.SqlClient, PgClient.PgClient)(yield* Effect.context<Effect.Services<ReturnType<typeof Runners.get>>>())
      const drain = (deploymentId: string, regions: ReadonlyArray<string>) =>
        Effect.forEach(regions, (region) =>
          Effect.gen(function* () {
            const runner = yield* runnerActor(deploymentId, region)
            yield* runner.Drain()
            const completed = yield* runner.Lookup().pipe(
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: (capacity) => ["stopped", "failed", "stop-failed"].includes(capacity.status),
              }),
              Effect.timeoutOption("3 minutes"),
            )
            if (Option.isNone(completed) || completed.value.status === "stop-failed")
              return yield* PlatformFailure.make({
                reason: "Runner did not complete its drain",
                retryable: true,
              })
          }),
        ).pipe(Effect.provideContext(runtime), Effect.asVoid)
      return {
        migrate,
        start: (release) =>
          Effect.forEach(release.regions, (region) =>
            Effect.gen(function* () {
              const checkedRegion = yield* Schema.decodeUnknownEffect(Region)(region).pipe(
                Effect.mapError(() =>
                  PlatformFailure.make({ reason: "Unsupported runner region", retryable: false }),
                ),
              )
              const runner = yield* runnerActor(release.deploymentId, region)
              yield* runner.Wake()
              const ready = yield* runner.Lookup().pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("100 millis"),
                  until: (capacity) => capacity.url !== null || capacity.status === "failed",
                }),
                Effect.timeoutOption("5 minutes"),
              )
              if (Option.isNone(ready) || ready.value.url === null)
                return yield* PlatformFailure.make({
                  reason: "Runner did not register before the cold-start deadline",
                  retryable: true,
                })
              const probe = yield* client
                .execute(
                  HttpClientRequest.get(
                    `${options.edgeOrigin ?? "http://127.0.0.1:3002"}/ready`,
                  ).pipe(
                    HttpClientRequest.setHeaders({
                      host: `${release.deploymentId}.${options.deploymentDomain ?? "localhost"}`,
                      authorization: `Bearer ${Redacted.value(serviceCredential(options.secret, release.deploymentId))}`,
                    }),
                  ),
                )
                .pipe(
                  Effect.map((response) => response.status === 200),
                  Effect.timeoutOption("1 second"),
                  Effect.map(Option.getOrElse(() => false)),
                  Effect.orElseSucceed(() => false),
                  Effect.repeat({
                    schedule: Schedule.spaced("100 millis"),
                    until: (ready) => ready,
                  }),
                  Effect.timeoutOption("30 seconds"),
                )
              if (Option.isNone(probe) || !probe.value)
                return yield* PlatformFailure.make({
                  reason: "Runner did not become ready before the cold-start deadline",
                  retryable: true,
                })
              return {
                id: ready.value.taskId ?? release.deploymentId,
                region: checkedRegion,
                actorCount: null,
                cpuPercent: null,
                health: "healthy" as const,
              }
            }).pipe(Effect.provideContext(runtime)),
          ).pipe(
            Effect.mapError((error) =>
              error instanceof PlatformFailure
                ? error
                : PlatformFailure.make({ reason: "Runner startup failed", retryable: true }),
            ),
            Effect.onError(() => drain(release.deploymentId, release.regions).pipe(Effect.orDie)),
          ),
        drain: (input) =>
          drain(input.deploymentId, ["us-east-1", "us-west-2"]).pipe(
            Effect.mapError(() =>
              PlatformFailure.make({ reason: "Runner drain failed", retryable: true }),
            ),
          ),
      } satisfies RolloutPlatform["Service"]
    }),
  )
