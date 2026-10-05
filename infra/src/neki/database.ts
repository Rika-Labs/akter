import * as planetscale from "@distilled.cloud/planetscale"
import { Credentials } from "@distilled.cloud/planetscale/Credentials"
import { havePropsChanged, isResolved } from "alchemy/Diff"
import { createPhysicalName } from "alchemy/PhysicalName"
import * as Planetscale from "alchemy/Planetscale"
import * as Provider from "alchemy/Provider"
import type { Resource } from "alchemy/Resource"
import { Effect, Schema, Stream } from "effect"
import type { Providers } from "./providers.ts"
import { Neki } from "./resources.ts"
import {
  checkShardCount,
  dataShardsOf,
  dataTopology,
  LiveTopology,
  placementOf,
  type TopologyScope,
} from "./topology.ts"

const DEFAULT_ROUTER = "default"

/**
 * A router group. The `default` group exists on every Neki branch and can be
 * resized but not created or deleted; any other name creates a group that clients
 * select by appending it to the username.
 */
export interface NekiRouterGroup {
  name: string
  /** Router size SKU, for example `NKR_1`. */
  size?: string
  /** Router instances per availability zone. */
  replicasPerCell?: number
}

/**
 * Properties of a Neki database. `shardCount`, `logicalDatabase`, `schema` and
 * `routedTables` shape the data topology, which this resource writes when it
 * creates the database and otherwise only reads; see {@link NekiDatabase}.
 */
export interface NekiDatabaseProps {
  /**
   * PlanetScale organization slug.
   * @default the organization of the PlanetScale credentials
   */
  organization?: string
  /**
   * Database name, lowercase. Cannot be changed after creation.
   * @default generated from the stack, stage and logical id
   */
  name?: string
  /** Region slug. Cannot be changed after creation. */
  region?: string
  /** Cluster size SKU of the default configuration profile, applied to every shard. */
  clusterSize: string
  /** Replicas per shard: `0` for none, `2` or more for high availability. */
  replicas?: number
  /** PostgreSQL major version. Cannot be changed after creation. */
  majorVersion?: string
  /**
   * Shards that hold actor data. `1` keeps the data on the authoritative shard,
   * which is the unsharded start. `2` or more creates that many further shards and
   * splits the 256 `routing_key >> 56` buckets across them, leaving the
   * authoritative shard as a standalone control shard.
   * @default 1
   */
  shardCount?: number
  /** Router groups to size or create, applied in addition to the default group. */
  routers?: ReadonlyArray<NekiRouterGroup>
  /**
   * Postgres database the topology names its schema under.
   * @default "postgres"
   */
  logicalDatabase?: string
  /**
   * Schema whose tables are routed by `routing_key`.
   * @default "public"
   */
  schema?: string
  /**
   * Tables in the schema routed by `routing_key` across the data shards. Every other
   * table stays on the authoritative shard.
   */
  routedTables?: ReadonlyArray<string>
  /**
   * Asks PlanetScale to refuse deleting the database. Left unset, the setting is not touched.
   */
  deletionProtected?: boolean
}

export interface NekiDatabaseAttributes {
  id: string
  name: string
  organization: string
  state: string
  /** The default branch, which every shard, router and role below belongs to. */
  branch: string
  region: string
  htmlUrl: string
  createdAt: string
  updatedAt: string
  /** Cluster size of the default configuration profile as PlanetScale reports it. */
  clusterSize: string
  replicas: number
  configurationProfile: string
  /** The control shard: the topology's authoritative group. */
  authoritativeShard: string
  /** Shards the live topology routes `routing_key` to, in key order. */
  dataShards: string[]
  /** Router groups other than the default one that this resource created. */
  routerGroups: string[]
}

/**
 * A PlanetScale Neki database: horizontally sharded Postgres.
 *
 * Creating it makes the database, waits for its first shard, adds data shards when
 * `shardCount` is above one, and writes a data topology that routes the `routedTables` of
 * the schema by a `range` shard index on `routing_key` and keeps every other table on the
 * authoritative shard. The key space is split on
 * bucket boundaries, `routing_key >> 56`, read as the unsigned top byte of the
 * two's-complement key; see `bucketHex` in `./topology.ts`.
 *
 * After creation the topology is only read. Neki moves rows through its own
 * resharding workflows, which this resource does not run, and writing a topology
 * that moves a range without them leaves the rows on shards that no longer own
 * them. A live placement that differs from the props, whether the props changed or
 * a reshard completed, therefore fails the reconcile instead of being overwritten. The one
 * exception is a database that has, and is meant to have, a single shard. The authoritative and
 * the data shard group are then the same shard, so every row already sits where any topology
 * places it and writing one moves nothing. That covers a database created in the dashboard and
 * adopted, a run that placed it but stopped before saving, and a change to the list of routed
 * tables before the first reshard. Shards are never deleted, and deleting the database deletes
 * them with it.
 *
 * @example
 * ```typescript
 * const db = yield* Neki.Database("Cells", {
 *   clusterSize: "PS_80",
 *   replicas: 2,
 *   shardCount: 4,
 *   routers: [{ name: "default", size: "NKR_2", replicasPerCell: 2 }],
 * })
 * ```
 */
export type NekiDatabase = Resource<
  "Planetscale.NekiDatabase",
  NekiDatabaseProps,
  NekiDatabaseAttributes,
  never,
  Providers
>

const decodeTopology = Schema.decodeUnknownEffect(LiveTopology)

const resolveName = (id: string, name: string | undefined) =>
  name === undefined
    ? createPhysicalName({ id, lowercase: true, maxLength: 63 })
    : Effect.succeed(name)

const listShards = (organization: string, database: string, branch: string) =>
  planetscale.listShards.pages({ organization, database, branch }).pipe(
    Stream.runCollect,
    Effect.map((pages) => Array.from(pages).flatMap((page) => page.data)),
  )

const listProfiles = (organization: string, database: string, branch: string) =>
  planetscale.listShardConfigurationProfiles({ organization, database, branch })

const defaultProfile = (
  profiles: ReadonlyArray<planetscale.GetShardConfigurationProfileOutput>,
  database: string,
) => {
  const profile = profiles.find((candidate) => candidate.default)
  return profile === undefined
    ? Effect.fail(
        new Planetscale.PlanetscaleConflict({
          message: `Neki database "${database}" has no default configuration profile.`,
        }),
      )
    : Effect.succeed(profile)
}

const liveTopology = (organization: string, database: string, branch: string) =>
  planetscale
    .getDataTopology({ organization, database, branch })
    .pipe(Effect.flatMap((response) => decodeTopology(response.data_topology)))

const attributesOf = (
  organization: string,
  database: planetscale.GetDatabaseOutput,
  profile: planetscale.GetShardConfigurationProfileOutput,
  topology: { authoritativeShard: string; dataShards: string[] },
  routerGroups: string[],
): NekiDatabaseAttributes => ({
  id: database.id,
  name: database.name,
  organization,
  state: database.state,
  branch: database.default_branch ?? "main",
  region: database.region.slug,
  htmlUrl: database.html_url,
  createdAt: database.created_at,
  updatedAt: database.updated_at,
  clusterSize: profile.cluster_size,
  replicas: profile.replicas,
  configurationProfile: profile.name,
  authoritativeShard: topology.authoritativeShard,
  dataShards: topology.dataShards,
  routerGroups,
})

const requireNeki = (database: planetscale.GetDatabaseOutput) =>
  database.kind === "neki"
    ? Effect.void
    : Effect.fail(
        new Planetscale.PlanetscaleConflict({
          message: `PlanetScale database "${database.name}" has kind "${database.kind}" but this resource is a NekiDatabase. Delete the existing database and retry.`,
        }),
      )

export const NekiDatabaseProvider = Provider.succeed(Neki.Database, {
  stables: ["id", "name", "organization", "region"],

  diff: ({ news, olds, output }) =>
    Effect.sync(() => {
      if (!isResolved(news)) return undefined
      checkShardCount({ shardCount: news.shardCount ?? 1, routedTables: news.routedTables ?? [] })
      if (
        output !== undefined &&
        ((news.organization !== undefined && news.organization !== output.organization) ||
          (news.name !== undefined && news.name !== output.name) ||
          (news.region !== undefined && news.region !== output.region) ||
          (olds !== undefined && news.majorVersion !== olds.majorVersion))
      )
        return { action: "replace" } as const
      return havePropsChanged(olds, news) ? ({ action: "update" } as const) : undefined
    }),

  read: Effect.fn(function* ({ id, output, olds }) {
    const credentials = yield* yield* Credentials
    const organization = output?.organization ?? olds?.organization ?? credentials.organization
    const name = output?.name ?? (yield* resolveName(id, olds?.name))
    const database = yield* planetscale
      .getDatabase({ organization, database: name })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined))
    if (database === undefined) return undefined
    yield* requireNeki(database)
    const branch = database.default_branch ?? "main"
    const profile = yield* defaultProfile(yield* listProfiles(organization, name, branch), name)
    const shards = yield* listShards(organization, name, branch)
    const live = yield* liveTopology(organization, name, branch).pipe(
      Effect.catchTag("SchemaError", () => Effect.undefined),
    )
    return attributesOf(
      organization,
      database,
      profile,
      {
        authoritativeShard: shards.find((shard) => shard.authoritative)?.name ?? "",
        dataShards: live === undefined ? [] : dataShardsOf(live),
      },
      output?.routerGroups ?? [],
    )
  }),

  reconcile: Effect.fn(function* ({ id, news, output, session }) {
    const credentials = yield* yield* Credentials
    const organization = news.organization ?? credentials.organization
    const name = output?.name ?? (yield* resolveName(id, news.name))
    const shardCount = news.shardCount ?? 1
    checkShardCount({ shardCount, routedTables: news.routedTables ?? [] })
    const scope: TopologyScope = {
      database: news.logicalDatabase ?? "postgres",
      schema: news.schema ?? "public",
    }
    const placement = placementOf(scope)

    const existing = yield* planetscale
      .getDatabase({ organization, database: name })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined))
    const fresh = output === undefined || existing === undefined
    if (existing === undefined) yield* session.note("Creating database...")
    const created =
      existing ??
      (yield* planetscale.createDatabase({
        organization,
        name,
        region: news.region,
        kind: "neki",
        cluster_size: news.clusterSize,
        replicas: news.replicas,
        major_version: news.majorVersion,
      }))
    yield* requireNeki(created)
    const database = yield* Planetscale.waitForDatabaseReady(organization, name, session)
    if (
      news.deletionProtected !== undefined &&
      database.deletion_protected !== news.deletionProtected
    ) {
      yield* session.note("Updating deletion protection...")
      yield* planetscale.updateDatabaseSettings({
        organization,
        database: name,
        deletion_protected: news.deletionProtected,
      })
    }
    const branch = database.default_branch ?? "main"
    yield* Planetscale.waitForBranchReady(organization, name, branch, session)

    const profiles = yield* listProfiles(organization, name, branch)
    const initialProfile = yield* defaultProfile(profiles, name)
    const sizeChanged =
      initialProfile.cluster_size !== news.clusterSize ||
      (news.replicas !== undefined && initialProfile.replicas !== news.replicas)
    const profile = yield* planetscale.getShardConfigurationProfile({
      organization,
      database: name,
      branch,
      configuration_profile: initialProfile.name,
    })

    const shards = yield* listShards(organization, name, branch)
    const authoritative = shards.find((shard) => shard.authoritative)
    if (authoritative === undefined)
      return yield* new Planetscale.PlanetscaleConflict({
        message: `Neki database "${name}" has no authoritative shard.`,
      })
    const desiredFor = (dataShards: ReadonlyArray<string>) =>
      dataTopology({
        authoritativeShard: authoritative.name,
        dataShards,
        ...scope,
        routedTables: news.routedTables ?? [],
      })

    const live = fresh
      ? undefined
      : yield* liveTopology(organization, name, branch).pipe(
          Effect.catchTag("SchemaError", () => Effect.undefined),
        )
    const singleShard = shards.length === 1 && shardCount === 1
    const mayRewrite = fresh || singleShard

    const sortedSpare = (all: typeof shards) =>
      all
        .filter((shard) => !shard.authoritative)
        .sort(
          (left, right) =>
            left.created_at.localeCompare(right.created_at) || left.name.localeCompare(right.name),
        )
    let dataShards: string[]
    if (!mayRewrite) {
      dataShards = output?.dataShards ?? []
      if (
        live === undefined ||
        dataShards.length !== shardCount ||
        placement(live) !== placement(desiredFor(dataShards))
      )
        return yield* new Planetscale.PlanetscaleConflict({
          message:
            `Neki database "${name}" places data differently from its props. Neki moves rows only through its resharding workflows, ` +
            `so this resource will not overwrite the live topology. Run the reshard with Neki and update the props to the resulting layout.`,
        })
    } else if (shardCount === 1) {
      dataShards = [authoritative.name]
    } else {
      const missing = shardCount - sortedSpare(shards).length
      if (missing > 0) {
        yield* session.note("Creating shards...")
        yield* planetscale.bulkCreateShardConfigurationProfileShards({
          organization,
          database: name,
          branch,
          configuration_profile: profile.name,
          count: missing,
        })
      }
      const ready = yield* Planetscale.pollUntil(
        `${shardCount} data shards ready`,
        listShards(organization, name, branch),
        (all) => sortedSpare(all).filter((shard) => shard.ready).length >= shardCount,
      )
      dataShards = sortedSpare(ready)
        .filter((shard) => shard.ready)
        .slice(0, shardCount)
        .map((shard) => shard.name)
    }

    if (mayRewrite) {
      const desired = desiredFor(dataShards)
      const unchanged = live !== undefined && placement(live) === placement(desired)
      if (!unchanged) {
        yield* session.note("Applying data topology...")
        yield* planetscale.updateDataTopology({
          organization,
          database: name,
          branch,
          data_topology: desired,
        })
        yield* Planetscale.pollUntil(
          "data topology applied",
          liveTopology(organization, name, branch).pipe(
            Effect.map((topology) => placement(topology)),
            Effect.catchTag("SchemaError", () => Effect.succeed("")),
          ),
          (applied) => applied === placement(desired),
        )
      }
    }

    if (sizeChanged) {
      yield* session.note("Resizing shards...")
      yield* planetscale.updateShardConfigurationProfile({
        organization,
        database: name,
        branch,
        configuration_profile: initialProfile.name,
        cluster_size: news.clusterSize,
        replicas: news.replicas,
      })
      yield* Planetscale.pollUntil(
        `configuration profile "${initialProfile.name}" ready`,
        planetscale.getShardConfigurationProfile({
          organization,
          database: name,
          branch,
          configuration_profile: initialProfile.name,
        }),
        (profile) => profile.state === "ready",
      )
    }
    const finalProfile = yield* planetscale.getShardConfigurationProfile({
      organization,
      database: name,
      branch,
      configuration_profile: initialProfile.name,
    })
    const routers = news.routers ?? []
    const liveRouters = yield* planetscale.listRouters({ organization, database: name, branch })
    for (const router of routers) {
      const current = liveRouters.find((candidate) => candidate.name === router.name)
      if (current === undefined && router.name === DEFAULT_ROUTER)
        return yield* new Planetscale.PlanetscaleConflict({
          message: `Neki database "${name}" has no "${DEFAULT_ROUTER}" router group to size.`,
        })
      if (current === undefined) {
        yield* session.note(`Creating router group "${router.name}"...`)
        yield* planetscale.createRouter({
          organization,
          database: name,
          branch,
          name: router.name,
          router_size: router.size,
          replicas_per_cell: router.replicasPerCell,
        })
      } else if (
        (router.size !== undefined && router.size !== current.router_size) ||
        (router.replicasPerCell !== undefined &&
          router.replicasPerCell !== current.replicas_per_cell)
      ) {
        yield* session.note(`Resizing router group "${router.name}"...`)
        yield* planetscale.updateRouter({
          organization,
          database: name,
          branch,
          router: router.name,
          router_size: router.size,
          replicas_per_cell: router.replicasPerCell,
        })
      }
    }
    const routerGroups = routers
      .filter((router) => router.name !== DEFAULT_ROUTER)
      .map((router) => router.name)
    for (const stale of (output?.routerGroups ?? []).filter(
      (group) => !routerGroups.includes(group),
    ))
      yield* planetscale
        .deleteRouter({ organization, database: name, branch, router: stale })
        .pipe(Effect.catchTag("NotFound", () => Effect.void))
    if (routers.length > 0)
      yield* Planetscale.pollUntil(
        "router groups ready",
        planetscale.listRouters({ organization, database: name, branch }),
        (all) =>
          routers.every(
            (router) => all.find((candidate) => candidate.name === router.name)?.state === "ready",
          ),
      )

    return attributesOf(
      organization,
      database,
      finalProfile,
      { authoritativeShard: authoritative.name, dataShards },
      routerGroups,
    )
  }),

  delete: Effect.fn(function* ({ output }) {
    yield* planetscale
      .deleteDatabase({ organization: output.organization, database: output.name })
      .pipe(Effect.catchTag("NotFound", () => Effect.void))
  }),
})
