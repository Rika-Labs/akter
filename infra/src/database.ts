import * as Output from "alchemy/Output"
import { retain } from "alchemy/RemovalPolicy"
import { Config, Effect, Redacted } from "effect"
import { stackName, type Deployment, type SharedLayout, type SharedOutputs } from "./config.ts"
import { Neki } from "./neki/resources.ts"
import { controlTables } from "./placement.ts"

const nekiRegion = "us-east"

const serviceRoles = ["postgres", "neki_viewer"] as const

/**
 * Names the logical database in a role's connection URL, which is the
 * cluster's `postgres` database until a preview creates its own.
 */
export const withDatabase = (input: {
  readonly url: Redacted.Redacted<string>
  readonly name: string
}) => {
  const { url, name } = input
  const parsed = new URL(Redacted.value(url))
  parsed.pathname = `/${name}`
  return Redacted.make(parsed.toString())
}

/**
 * A Neki database with the control tables kept on the authoritative shard. `prod` runs two
 * replicas and two routers per cell and is protected from deletion and retained when its stage is
 * destroyed. The `preview` stage's cluster is the smallest the sizes allow: one shard, no
 * replicas and a single router. Both read their sizes from the stage's environment.
 */
const cluster = Effect.fn(function* (input: {
  readonly organization: string
  readonly production: boolean
  readonly name: string
}) {
  const { organization, production, name } = input
  return yield* Neki.Database("Database", {
    organization,
    name,
    region: nekiRegion,
    clusterSize: yield* Config.String("NEKI_CLUSTER_SIZE"),
    replicas: production ? 2 : 0,
    shardCount: production ? yield* Config.Int("NEKI_SHARD_COUNT").pipe(Config.withDefault(1)) : 1,
    routers: [
      {
        name: "default",
        size: yield* Config.String("NEKI_ROUTER_SIZE"),
        replicasPerCell: production ? 2 : 1,
      },
    ],
    unshardedTables: controlTables,
    deletionProtected: production,
  }).pipe(retain(production))
})

/**
 * The database every pull request preview shares. The `preview` stage declares only the cluster:
 * each preview brings its own role and logical database, so nothing here holds a credential.
 */
export const sharedDatabase = (input: {
  readonly layout: SharedLayout
  readonly planetscaleOrganization: string
}) =>
  Effect.gen(function* () {
    const { layout, planetscaleOrganization: organization } = input
    const database = yield* cluster({
      organization,
      production: false,
      name: `akter-${layout.stage}`,
    })
    return {
      neki: {
        organization: database.organization,
        database: database.name,
        branch: database.branch,
      },
    }
  })

/**
 * The control-plane database. `prod` owns a Neki database. A pull request preview borrows the
 * `preview` stage's cluster, where it creates a role of its own and a logical database named
 * `akter_pr_<n>`, and drops both when the stage is destroyed. Services connect with a role that may
 * create tables because the API applies its schema when it boots.
 */
export const controlPlane = (deployment: Deployment) =>
  Effect.gen(function* () {
    const { layout, planetscaleOrganization: organization } = deployment
    if (layout.kind === "pr") {
      const shared = (yield* Output.stackRef<SharedOutputs>(stackName, {
        stage: "preview",
      })) as Output.ToOutput<SharedOutputs>
      const role = yield* Neki.Role("PreviewRole", {
        organization: shared.neki.organization,
        database: shared.neki.database,
        branch: shared.neki.branch,
        inheritedRoles: serviceRoles,
      })
      const logical = yield* Neki.LogicalDatabase("PreviewDatabase", {
        name: `akter_pr_${layout.pullRequest}`,
        connectionUrl: role.connectionUrl,
      })
      return {
        url: Output.all(role.connectionUrl, logical.name).pipe(
          Output.map(([url, name]) => withDatabase({ url, name })),
        ),
        neki: shared.neki,
      }
    }
    const database = yield* cluster({
      organization,
      production: true,
      name: `akter-${layout.stage}`,
    })
    const role = yield* Neki.Role("ServiceRole", {
      organization,
      database: database.name,
      branch: database.branch,
      inheritedRoles: serviceRoles,
    })
    return {
      url: role.connectionUrl,
      neki: {
        organization: database.organization,
        database: database.name,
        branch: database.branch,
      },
    }
  })
