import { NotFound } from "@akter/cloud-api"
import {
  DeploymentLifecycleLive,
  ensureLifecycleTables,
  PlatformFailure,
} from "@akter/deployments/lifecycle"
import {
  dockerBuilds,
  dockerMigrations,
  dockerRunners,
  ecsMigrations,
  ecsRunners,
  ImageBuilds,
  ImageMigrations,
  RunnerLayers,
  RunnerPoller,
} from "@akter/deployments/runners"
import { fromNodeProviderChain } from "@distilled.cloud/aws/Credentials"
import { migrate } from "@akter/postgres/migrate"
import { Actors, Database, RunnerAuthority } from "@rikalabs/akter/runtime"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import type { ApiOptions } from "./config.ts"
import {
  environmentHost,
  rolloutPlatform,
  rolloutRouting,
  SERVICE_TENANT,
  serviceCredential,
} from "./rollout.ts"
import { RuntimeEdge } from "./runtime.ts"
import { MeteringRepositoryLive } from "./metering-repository.ts"
import { RepositoryLive } from "./repository.ts"
import { Sources, SourcesLive } from "./sources.ts"

/**
 * The local platform's runner peer authority: the one saved in `directory`,
 * or a new one saved there on first use, or, without a directory, one that
 * lasts as long as this process. Certificate and key share one file, which a
 * new authority reaches only through a hard link that fails when the file
 * exists, so processes starting together all end up with the one that won.
 */
export const localAuthority = (directory: string | undefined) =>
  Effect.gen(function* () {
    if (directory === undefined) return yield* RunnerAuthority.make()
    const fs = yield* FileSystem.FileSystem
    const bundle = `${directory}/authority.bundle.pem`
    if (!(yield* fs.exists(bundle))) {
      const created = yield* RunnerAuthority.make({ name: "akter local runner authority" })
      yield* fs.makeDirectory(directory, { recursive: true })
      const staging = yield* fs.makeTempDirectory({ directory, prefix: ".authority-" })
      const staged = `${staging}/authority.bundle.pem`
      yield* fs.writeFileString(staged, `${created.certificate}${Redacted.value(created.key)}`, {
        mode: 0o600,
      })
      yield* fs.link(staged, bundle).pipe(Effect.ignore)
      yield* fs.remove(staging, { recursive: true })
    }
    const text = yield* fs.readFileString(bundle)
    const block = (label: string) =>
      text.match(
        new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----\\n`, "u"),
      )?.[0] ?? ""
    return yield* RunnerAuthority.from({
      certificate: block("CERTIFICATE"),
      key: Redacted.make(block("PRIVATE KEY")),
    })
  }).pipe(Effect.orDie)

/** A caller's environment is resolved to an edge host; runner addresses and signing keys never reach API handlers. */
export const runtimeEdge = (options: ApiOptions) =>
  Layer.effect(
    RuntimeEdge,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return {
        resolve: ({ organizationId, projectId, environment }) =>
          Effect.gen(function* () {
            const [row] = yield* sql<{
              id: string
              host: string
            }>`SELECT e.current_deployment_id AS id, h.host FROM cloud_environment e JOIN deployment_host h ON h.deployment_id = e.current_deployment_id WHERE e.organization_id = ${organizationId} AND e.project_id = ${projectId} AND e.name = ${environment} AND h.host = ${environmentHost(options, projectId, environment)}`.pipe(
              Effect.orDie,
            )
            if (row === undefined)
              return yield* NotFound.make({
                resource: "live deployment",
                id: `${projectId}/${environment}`,
              })
            return {
              origin: options.edgeOrigin ?? "http://127.0.0.1:3002",
              host: row.host,
              credential: serviceCredential(options.secret, row.id),
              tenant: SERVICE_TENANT,
              requestTimeout: `${options.runtimeRequestTimeoutSeconds ?? 35} seconds`,
            }
          }),
      } satisfies RuntimeEdge["Service"]
    }),
  )

/** Serving migrations deliberately exclude the retired identity schema; Better Auth owns identity tables. */
export const cloudDatabase = (options: ApiOptions) =>
  Layer.unwrap(
    Effect.promise(() => migrate(Redacted.value(options.databaseUrl), { startAt: "0002_" })).pipe(
      Effect.map(() => Database.postgres({ url: options.databaseUrl, maxConnections: 10 })),
    ),
  )

/** The local control plane uses the same durable actors and SQL authority as hosted orchestration. */
export const cloudRuntime = (options: ApiOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (options.production && options.runnerEcs === undefined)
        return yield* Effect.die(
          new Error("Production deployment orchestration requires ECS runner configuration"),
        )
      if (options.production && options.runnerEcs?.scheme === "http")
        return yield* Effect.die(new Error("Production edge-to-runner traffic requires TLS"))
      yield* ensureLifecycleTables
      const actors = Actors.layer({ relay: { poll: "100 millis" } })
      const runners = RunnerLayers.pipe(Layer.provideMerge(actors))
      const sources = SourcesLive({ builds: options.localBuild !== undefined })
      const platform = Layer.unwrap(
        Effect.gen(function* () {
          const migrations = yield* ImageMigrations
          const builds = yield* Effect.serviceOption(ImageBuilds)
          const uploaded = yield* Sources
          return rolloutPlatform(options, {
            migrate: (release) =>
              Schema.decodeEffect(
                Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
              )(release.envSnapshot).pipe(
                Effect.mapError(() =>
                  PlatformFailure.make({
                    reason: "Invalid environment snapshot",
                    retryable: false,
                  }),
                ),
                Effect.flatMap((snapshot) =>
                  migrations.run({
                    deploymentId: release.deploymentId,
                    region: release.regions[0] ?? "us-east-1",
                    image: release.imageDigest,
                    environment: { ...snapshot, ...options.runnerEnvironment },
                    idempotencyKey: release.jobId,
                  }),
                ),
                Effect.mapError(() =>
                  PlatformFailure.make({ reason: "Image migration failed", retryable: false }),
                ),
              ),
            build: Option.match(builds, {
              onNone: () => undefined,
              onSome: (builder) => (request) =>
                uploaded.forDeployment(request.deploymentId).pipe(
                  Effect.mapError(() =>
                    PlatformFailure.make({
                      reason: "The deployment's source could not be read",
                      retryable: true,
                    }),
                  ),
                  Effect.flatMap((source) =>
                    builder
                      .build({
                        tag: `akter-build:${request.deploymentId}`,
                        buildArgs: { RUNNER_VERSION: request.commitSha.slice(0, 7) },
                        ...Option.match(source, {
                          onNone: () => ({}),
                          onSome: (found) => ({ source: found }),
                        }),
                      })
                      .pipe(
                        Effect.map((built) => ({ imageDigest: built.imageId, log: built.log })),
                        Effect.mapError((failure) =>
                          PlatformFailure.make({
                            reason: failure.reason,
                            retryable: failure.retryable,
                          }),
                        ),
                      ),
                  ),
                ),
            }),
          })
        }),
      ).pipe(Layer.provide(runners), Layer.provide(sources))
      return DeploymentLifecycleLive.pipe(
        Layer.provide(platform),
        Layer.provide(
          rolloutRouting(options).pipe(
            Layer.provide(Layer.mergeAll(RepositoryLive, MeteringRepositoryLive)),
          ),
        ),
        Layer.provideMerge(runners),
        Layer.provideMerge(sources),
      )
    }),
  ).pipe(
    Layer.provide(
      options.runnerEcs === undefined
        ? Layer.unwrap(
            Effect.map(localAuthority(options.runnerPeerAuthority), (peering) =>
              Layer.mergeAll(
                dockerRunners({
                  port: options.runnerPort ?? 8080,
                  network: options.runnerNetwork,
                  routeViaNetwork: options.runnerRouteViaNetwork,
                  peering,
                }),
                dockerMigrations({
                  command: options.migrationCommand ?? ["bun", "run", "migrate"],
                  network: options.runnerNetwork,
                  peering,
                }),
              ),
            ),
          ).pipe(Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer)))
        : Layer.mergeAll(
            ecsRunners(options.runnerEcs),
            ecsMigrations({
              ...options.runnerEcs,
              command: options.migrationCommand ?? ["bun", "run", "migrate"],
            }),
          ).pipe(
            Layer.provide(
              Layer.mergeAll(fromNodeProviderChain(), FetchHttpClient.layer, BunCrypto.layer),
            ),
          ),
    ),
    Layer.provide(
      options.localBuild === undefined
        ? Layer.empty
        : dockerBuilds(options.localBuild).pipe(Layer.provide(BunServices.layer)),
    ),
    Layer.provideMerge(cloudDatabase(options)),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(BunCrypto.layer),
  )

export const runnerReconciliation = (options: ApiOptions) =>
  RunnerPoller(options.runnerIdleSeconds ?? 300)
