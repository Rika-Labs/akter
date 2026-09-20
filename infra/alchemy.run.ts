import * as Alchemy from "alchemy"
import * as Railway from "alchemy/Railway"
import * as Planetscale from "alchemy/Planetscale"
import * as Axiom from "alchemy/Axiom"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { Clock, Config, Schema } from "effect"
import * as Layer from "effect/Layer"
import { retain } from "alchemy/RemovalPolicy"
import * as Output from "alchemy/Output"
import { deployment, DeploymentJson } from "./src/lifecycle.ts"
import { loadSecrets, secretsLayer } from "./src/secrets.ts"

const spec = await Effect.runPromise(
  Effect.gen(function* () {
    const input = yield* Schema.decodeEffect(DeploymentJson)(
      yield* Config.String("PROJECT_DEPLOYMENT"),
    )

    const operation = yield* Config.String("PROJECT_OPERATION").pipe(Config.withDefault("plan"))

    return deployment({
      input,
      now: yield* Clock.currentTimeMillis,
      destroying: operation === "destroy",
    })
  }),
)

if (spec.appOrigin === undefined || new URL(spec.appOrigin).protocol !== "https:")
  throw new Error("Manifest appOrigin must be an HTTPS origin for auth callbacks")

const appOrigin = spec.appOrigin

export default Alchemy.Stack(
  spec.key,
  {
    providers: Railway.providers().pipe(
      Layer.provideMerge(Planetscale.providers()),
      Layer.provideMerge(Cloudflare.providers()),
      Layer.provideMerge(Axiom.providers()),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Railway.Project("Project", {
      name: spec.key,
      description: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        owner: spec.owner,
        expiresAt: spec.expiresAt,
        managedBy: "alchemy",
      }).pipe(Effect.orDie),
    }).pipe(retain(!spec.ephemeral))

    const database = yield* Planetscale.PostgresDatabase("Database", {
      name: spec.key,
      clusterSize: "PS_10",
      migrations: "./packages/database/migrations",
    }).pipe(retain(!spec.ephemeral))

    const role = yield* Planetscale.PostgresRole("AppRole", {
      database,
      inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
    })

    const dataset = yield* Axiom.Dataset("Logs", { name: spec.key }).pipe(retain(!spec.ephemeral))

    const infisicalProject = yield* Config.String("INFISICAL_PROJECT_ID").pipe(
      Config.withDefault(""),
    )

    const secrets = yield* Effect.scoped(
      Effect.gen(function* () {
        if (infisicalProject === "") return {}
        const context = yield* Layer.build(secretsLayer)

        return yield* loadSecrets(infisicalProject, spec.stage, `/deployments/${spec.id}`).pipe(
          Effect.provideContext(context),
          Effect.orDie,
        )
      }),
    )

    const api = yield* Railway.Service("Api", {
      project,
      environment: project,
      name: "server",
      context: ".",
      dockerfilePath: "infra/docker/server.Dockerfile",
      port: 3001,
      publicDomain: true,
      healthcheck: "/health",
      env: {
        ...secrets,
        NODE_ENV: "production",
        APP_ORIGIN: spec.appOrigin,
        DATABASE_URL: role.connectionUrlPooled,
        AXIOM_DATASET: dataset.name,
      },
    })

    const web = yield* Railway.Service("Web", {
      project,
      environment: project,
      name: "console",
      context: ".",
      dockerfilePath: "infra/docker/console.Dockerfile",
      port: 3000,
      publicDomain: true,
      healthcheck: "/health",
      env: { NODE_ENV: "production", APP_ORIGIN: spec.appOrigin, API_ORIGIN: api.url },
    })

    // Cloudflare is DNS/proxy only; all application execution stays on Railway.
    const zoneId = yield* Config.String("CLOUDFLARE_ZONE_ID").pipe(Config.withDefault(""))

    if (zoneId !== "") {
      const hostname = new URL(appOrigin).hostname
      yield* Railway.CustomDomain("WebDomain", {
        service: web,
        environment: project,
        domain: hostname,
        targetPort: 3000,
      })
      yield* Cloudflare.DNS.Record("WebEdge", {
        zoneId,
        name: hostname,
        type: "CNAME",
        content: web.domain.pipe(
          Output.map((domain) => {
            if (domain === undefined) throw new Error("Railway public domain unavailable")

            return domain
          }),
        ),
        proxied: true,
        ttl: 1,
      })
    }

    return {
      key: spec.key,
      owner: spec.owner,
      expiresAt: spec.expiresAt,
      projectId: project.projectId,
      environmentId: project.environmentId,
      apiId: api.serviceId,
      webId: web.serviceId,
      apiUrl: api.url,
      webUrl: web.url,
      databaseId: database.id,
      dataset: dataset.name,
    }
  }),
)
