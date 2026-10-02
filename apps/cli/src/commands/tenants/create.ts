import { Actor, User } from "@rikalabs/akter"
import { Actors, Database } from "@rikalabs/akter/runtime"
import {
  DeploymentId,
  DeploymentsLive,
  Region,
  TenantHome,
  TenantHomeCommands,
  tenantHomeKey,
  TenantHomeReads,
  TenantName,
} from "@akter/deployments"
import { BunCrypto } from "@effect/platform-bun"
import { Console, Effect, Layer, type Redacted } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { UsageError, fail } from "../../failure.ts"

const flags = {
  tenant: Argument.String("tenant").pipe(
    Argument.withSchema(TenantName),
    Argument.withDescription("The tenant's name: 1 to 128 of A-Z a-z 0-9 . _ : -"),
  ),
  deployment: Flag.String("deployment").pipe(
    Flag.withSchema(DeploymentId),
    Flag.withDescription("The deployment the tenant belongs to"),
  ),
  region: Flag.String("region").pipe(
    Flag.withSchema(Region),
    Flag.withDescription("The tenant's home region: the deployment's primary region"),
  ),
  databaseUrl: Flag.Redacted("database-url").pipe(
    Flag.withDescription("The control plane's Postgres URL"),
  ),
  operator: Flag.String("operator").pipe(
    Flag.withDescription("The subject of the User the directory change's receipt records"),
  ),
}

/** Parsed arguments of `tenants create`. */
export type CreateOptions = Command.Command.Config.Infer<typeof flags>

/** The control plane's actors, embedded against its database; only operators run this. */
export const controlPlane = (databaseUrl: Redacted.Redacted) =>
  Layer.mergeAll(TenantHomeCommands, TenantHomeReads).pipe(
    Layer.provide(DeploymentsLive),
    Layer.provideMerge(Actors.layer({ authorize: () => Effect.succeed(true) })),
    Layer.provideMerge(Database.postgres({ url: databaseUrl })),
    Layer.provide(BunCrypto.layer),
  )

/** Records the tenant's home region, and says what the directory now holds. */
export const create = (options: CreateOptions) =>
  Effect.gen(function* () {
    const home = yield* TenantHome.get(tenantHomeKey(options))
    const created = yield* home.Create({ region: options.region })

    return `${created.deployment}/${created.tenant} lives in ${created.region} (${created.state})`
  }).pipe(
    Actor.as(User.make({ subject: options.operator })),
    Effect.catchTags({
      UnknownDeployment: ({ deployment }) =>
        Effect.fail(UsageError.make({ message: `No deployment ${deployment}` })),
      NotPrimaryRegion: ({ region, primaryRegion }) =>
        Effect.fail(
          UsageError.make({
            message: `${region} is not the deployment's primary region ${primaryRegion}; other regions arrive with tenant moves`,
          }),
        ),
      TenantAlreadyHomed: ({ region }) =>
        Effect.fail(UsageError.make({ message: `The tenant already lives in ${region}` })),
    }),
  )

/** `durable tenants create <tenant>`: records the tenant's home region in the control plane's directory. */
export const createCommand = Command.make("create", flags, (options) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(controlPlane(options.databaseUrl))

    yield* Console.log(yield* create(options).pipe(Effect.provideContext(services)))
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      UsageError: (error) => fail({ reason: error._tag, message: error.message }),
      ActorError: (error) =>
        fail({
          reason: error._tag,
          message: `durable tenants create failed: ${error.reason._tag}`,
        }),
    }),
  ),
).pipe(
  Command.withDescription(
    "Record a new tenant's home region in the control plane's directory, attributed to --operator",
  ),
)
