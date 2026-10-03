import * as planetscale from "@distilled.cloud/planetscale"
import { Credentials } from "@distilled.cloud/planetscale/Credentials"
import { isResolved } from "alchemy/Diff"
import { createPhysicalName } from "alchemy/PhysicalName"
import * as Planetscale from "alchemy/Planetscale"
import * as Provider from "alchemy/Provider"
import type { Resource } from "alchemy/Resource"
import { Effect, Redacted } from "effect"
import type { Providers } from "./providers.ts"
import { Neki } from "./resources.ts"

const DEFAULT_ROUTER = "default"

/**
 * Properties of a Neki role. Neki branches are not PostgreSQL branches to
 * PlanetScale's own `PostgresRole`, which refuses them and builds a pooled URL on a
 * port Neki does not listen on, so this resource owns the role and its connection
 * URL.
 */
export interface NekiRoleProps {
  /**
   * PlanetScale organization slug.
   * @default the organization of the PlanetScale credentials
   */
  organization?: string
  /** Neki database name, usually `database.name`. */
  database: string
  /**
   * Branch name, usually `database.branch`.
   * @default "main"
   */
  branch?: string
  /** Role name, lowercase. Defaults to a name generated from the stack, stage and logical id. */
  name?: string
  /** Seconds before the credentials expire. */
  ttl?: number
  /**
   * Built-in roles to inherit, such as `pg_read_all_data` and `pg_write_all_data`
   * for an application, or `postgres` and `neki_viewer` for migrations.
   */
  inheritedRoles: ReadonlyArray<string>
  /** Give the role the REPLICATION attribute; PlanetScale only grants it with `postgres`. */
  withReplication?: boolean
  /**
   * Router group the connection URL targets, which Neki selects by appending the
   * group to the username.
   * @default "default"
   */
  routerGroup?: string
}

export interface NekiRoleAttributes {
  id: string
  name: string
  organization: string
  database: string
  branch: string
  host: string
  /** The generated login, before any router-group suffix. */
  username: string
  password: Redacted.Redacted<string>
  /** The Postgres database inside the cluster, `postgres` unless PlanetScale says otherwise. */
  databaseName: string
  routerGroup: string
  /** Direct URL through the router group on port 5432 with certificate and hostname verification. */
  connectionUrl: Redacted.Redacted<string>
  inheritedRoles: string[]
  withReplication: boolean
  ttl: number | null
  expiresAt: string | null
}

/**
 * A role on a Neki branch with the URL a client connects with. PlanetScale returns
 * the password once, when the role is created, so the password lives in state and a
 * role that is deleted outside the stack is replaced by a new role with a new password.
 *
 * @example
 * ```typescript
 * const app = yield* Neki.Role("App", {
 *   database: db.name,
 *   inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
 * })
 * ```
 */
export type NekiRole = Resource<
  "Planetscale.NekiRole",
  NekiRoleProps,
  NekiRoleAttributes,
  never,
  Providers
>

const resolveName = (id: string, name: string | undefined) =>
  name === undefined
    ? createPhysicalName({ id, lowercase: true, maxLength: 63 })
    : Effect.succeed(name)

const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join()

const attributesOf = (
  role: planetscale.GetRoleOutput,
  password: Redacted.Redacted<string>,
  context: {
    organization: string
    database: string
    branch: string
    routerGroup: string
  },
): NekiRoleAttributes => {
  const login =
    context.routerGroup === DEFAULT_ROUTER
      ? role.username
      : `${role.username}|${context.routerGroup}`
  return {
    id: role.id,
    name: role.name,
    organization: context.organization,
    database: context.database,
    branch: context.branch,
    host: role.access_host_url,
    username: role.username,
    password,
    databaseName: role.database_name,
    routerGroup: context.routerGroup,
    connectionUrl: Redacted.make(
      `postgresql://${encodeURIComponent(login)}:${encodeURIComponent(Redacted.value(password))}@${role.access_host_url}:5432/${role.database_name}?sslmode=verify-full`,
    ),
    inheritedRoles: [...role.inherited_roles],
    withReplication: role.with_replication,
    ttl: role.ttl,
    expiresAt: role.expires_at,
  }
}

export const NekiRoleProvider = Provider.succeed(Neki.Role, {
  stables: ["id"],

  diff: Effect.fn(function* ({ id, news, olds, output }) {
    if (!isResolved(news)) return undefined
    if (
      output !== undefined &&
      ((news.organization !== undefined && news.organization !== output.organization) ||
        news.database !== output.database ||
        (news.branch ?? "main") !== output.branch ||
        news.ttl !== (olds?.ttl ?? output.ttl ?? undefined) ||
        !sameSet(news.inheritedRoles, output.inheritedRoles) ||
        (news.withReplication ?? false) !== output.withReplication)
    )
      return { action: "replace" } as const
    const name = yield* resolveName(id, news.name)
    const current = output?.name ?? (yield* resolveName(id, olds?.name))
    return name !== current || (news.routerGroup ?? DEFAULT_ROUTER) !== output?.routerGroup
      ? ({ action: "update" } as const)
      : undefined
  }),

  read: Effect.fn(function* ({ output }) {
    if (output === undefined) return undefined
    return yield* planetscale
      .getRole({
        organization: output.organization,
        database: output.database,
        branch: output.branch,
        id: output.id,
      })
      .pipe(
        Effect.map((role) => attributesOf(role, output.password, output)),
        Effect.catchTag("NotFound", () => Effect.undefined),
      )
  }),

  reconcile: Effect.fn(function* ({ id, news, output }) {
    const credentials = yield* yield* Credentials
    const organization = news.organization ?? credentials.organization
    const database = news.database
    const branch = news.branch ?? "main"
    const name = yield* resolveName(id, news.name)
    const routerGroup = news.routerGroup ?? DEFAULT_ROUTER

    const observed =
      output === undefined
        ? undefined
        : yield* planetscale
            .getRole({ organization, database, branch, id: output.id })
            .pipe(Effect.catchTag("NotFound", () => Effect.undefined))

    const issue = Effect.gen(function* () {
      const live = yield* Planetscale.waitForBranchReady(organization, database, branch)
      if (live.kind !== "neki")
        return yield* new Planetscale.PlanetscaleConflict({
          message: `Branch "${branch}" of "${database}" has kind "${live.kind}"; a NekiRole needs a Neki branch.`,
        })
      const created = yield* planetscale.createRole({
        organization,
        database,
        branch,
        name,
        ttl: news.ttl,
        inherited_roles: [...news.inheritedRoles],
        with_replication: news.withReplication,
      })
      if (created.password === null)
        return yield* Effect.die(`PlanetScale did not return a password for role "${name}".`)
      return { role: created, password: created.password }
    })
    const reused =
      observed !== undefined && output !== undefined
        ? { role: observed, password: output.password }
        : undefined
    const issued = reused ?? (yield* issue)
    const role =
      issued.role.name === name
        ? issued.role
        : yield* planetscale.updateRole({
            organization,
            database,
            branch,
            id: issued.role.id,
            name,
          })
    return attributesOf(role, issued.password, { organization, database, branch, routerGroup })
  }),

  delete: Effect.fn(function* ({ output }) {
    yield* planetscale
      .deleteRole({
        organization: output.organization,
        database: output.database,
        branch: output.branch,
        id: output.id,
        successor: "postgres",
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.void))
  }),
})
