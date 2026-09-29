import { Actor, User } from "@durable-actors/core"
import { Actors, Database } from "@durable-actors/core/runtime"
import {
  DeploymentId,
  DeploymentsLive,
  Region,
  TenantHome,
  TenantHomeCommands,
  tenantHomeKey,
  TenantHomeReads,
  TenantName,
} from "@durable-actors/deployments"
import { BunCrypto } from "@effect/platform-bun"
import { Effect, Layer, Redacted, Schema } from "effect"

/** The arguments could not be parsed; the message says why. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

/** Usage text for `durable tenants`. */
export const USAGE =
  "Usage: durable tenants create <tenant> --deployment <id> --region <region> --database-url <control-plane url> --operator <subject>"

/** Parsed arguments of `tenants create`. */
export interface CreateOptions {
  readonly tenant: string
  readonly deployment: string
  readonly region: string
  readonly databaseUrl: string
  /** Who the directory change is attributed to in its receipt. */
  readonly operator: string
}

const FLAGS = ["--deployment", "--region", "--database-url", "--operator"] as const

type Flag = (typeof FLAGS)[number]

const isFlag = (arg: string): arg is Flag => FLAGS.some((flag) => flag === arg)

const checked = <S extends Schema.Top & { readonly Type: string }>(
  schema: S,
  name: string,
  value: string,
) =>
  Schema.is(schema)(value)
    ? Effect.succeed(value)
    : Effect.fail(UsageError.make({ message: `${name} "${value}" is not valid` }))

/** Parses the arguments after `tenants create`. */
export const parseCreate = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const values = new Map<Flag, string>()
    let tenant: string | undefined

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!

      if (isFlag(arg)) {
        const value = args[++index]

        if (value === undefined) return yield* UsageError.make({ message: `${arg} needs a value` })

        values.set(arg, value)
      } else if (tenant === undefined && !arg.startsWith("--")) tenant = arg
      else return yield* UsageError.make({ message: `Unknown argument: ${arg}` })
    }

    if (tenant === undefined) return yield* UsageError.make({ message: "<tenant> is required" })

    for (const flag of FLAGS)
      if (!values.has(flag)) return yield* UsageError.make({ message: `${flag} is required` })

    return {
      tenant: yield* checked(TenantName, "tenant", tenant),
      deployment: yield* checked(DeploymentId, "--deployment", values.get("--deployment")!),
      region: yield* checked(Region, "--region", values.get("--region")!),
      databaseUrl: values.get("--database-url")!,
      operator: values.get("--operator")!,
    } satisfies CreateOptions
  })

/** The control plane's actors, embedded against its database; only operators run this. */
export const controlPlane = (databaseUrl: string) =>
  Layer.mergeAll(TenantHomeCommands, TenantHomeReads).pipe(
    Layer.provide(DeploymentsLive),
    Layer.provideMerge(Actors.layer({ authorize: () => Effect.succeed(true) })),
    Layer.provideMerge(Database.postgres({ url: Redacted.make(databaseUrl) })),
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
