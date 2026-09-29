import { Actor } from "@durable-actors/core"
import { bigint, pgTable, primaryKey, text } from "drizzle-orm/pg-core"
import { Schema } from "effect"

export const DeploymentId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/))

export const Region = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/))

/** A hosted tenant, with the limits the served protocol puts on every tenant. */
export const TenantName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/))

/** `<deployment>/<tenant>`: neither part can contain a slash, so the key splits one way. */
export const TenantHomeKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\/[A-Za-z0-9._:-]{1,128}$/),
)

export const tenantHomeKey = (home: { readonly deployment: string; readonly tenant: string }) =>
  `${home.deployment}/${home.tenant}`

/**
 * The tenant directory: one row per tenant with a recorded home. The edge
 * reads it with plain SQL; only `TenantHome` writes it, and the migration's
 * trigger gives every change a new, commit-ordered `version`.
 */
export const tenantDirectory = Actor.table(
  pgTable(
    "tenant_directory",
    {
      deploymentId: text("deployment_id").notNull(),
      tenant: text("tenant").notNull(),
      region: text("region").notNull(),
      state: text("state", { enum: ["active", "moving"] }).notNull(),
      version: bigint("version", { mode: "number" }).notNull().default(0),
    },
    (table) => [primaryKey({ columns: [table.deploymentId, table.tenant] })],
  ),
)

export class UnknownDeployment extends Schema.TaggedError<UnknownDeployment>()(
  "UnknownDeployment",
  { deployment: Schema.String },
) {}

/** Until regions are built, a tenant's home can only be its deployment's primary region. */
export class NotPrimaryRegion extends Schema.TaggedError<NotPrimaryRegion>()("NotPrimaryRegion", {
  region: Schema.String,
  primaryRegion: Schema.String,
}) {}

/** The tenant already has a home elsewhere; changing it is a move, which isn't built yet. */
export class TenantAlreadyHomed extends Schema.TaggedError<TenantAlreadyHomed>()(
  "TenantAlreadyHomed",
  { region: Schema.String },
) {}

export const Home = Schema.Struct({
  deployment: Schema.String,
  tenant: Schema.String,
  region: Schema.String,
  state: Schema.Literals(["active", "moving"]),
})

/** Records the tenant's home region; creating it again with the same region returns it unchanged. */
export const Create = Actor.command("Create", {
  input: Schema.Struct({ region: Region }),
  output: Home,
  errors: [UnknownDeployment, NotPrimaryRegion, TenantAlreadyHomed],
})

export const Lookup = Actor.query("Lookup", { output: Schema.UndefinedOr(Home) })

/** Where one hosted tenant lives, keyed by `<deployment>/<tenant>`. */
export const TenantHome = Actor.make("TenantHome", {
  key: TenantHomeKey,
  tables: [tenantDirectory],
  api: { Create, Lookup },
})
