import { Config, Effect, Schema } from "effect"
import { Stage } from "alchemy/Stage"

export const DeploymentStage = Schema.Literals(["dev", "staging", "prod"])
export const DeploymentRegion = Schema.Literals(["us-east-1", "us-west-2"])
export type DeploymentStage = typeof DeploymentStage.Type
export type DeploymentRegion = typeof DeploymentRegion.Type

/** Rejects shared accounts before any provider operation can reach AWS. */
export const selectAccount = ({
  stage,
  accounts,
}: {
  readonly stage: DeploymentStage
  readonly accounts: Readonly<Record<DeploymentStage, string>>
}) => {
  for (const account of Object.values(accounts)) {
    if (!/^[0-9]{12}$/.test(account)) throw new Error("AWS account IDs must contain 12 digits")
  }
  if (new Set(Object.values(accounts)).size !== 3)
    throw new Error("Dev, staging and prod must use separate AWS accounts")
  return accounts[stage]
}

export const region = Config.schema(DeploymentRegion, "AKTER_REGION").pipe(
  Config.withDefault("us-east-1"),
)

export const deployment = Effect.gen(function* () {
  const stage = yield* Schema.decodeUnknownEffect(DeploymentStage)(yield* Stage).pipe(Effect.orDie)
  const location = yield* region
  const accounts = {
    dev: yield* Config.String("AKTER_DEV_ACCOUNT_ID"),
    staging: yield* Config.String("AKTER_STAGING_ACCOUNT_ID"),
    prod: yield* Config.String("AKTER_PROD_ACCOUNT_ID"),
  }
  const accountId = yield* Effect.sync(() => selectAccount({ stage, accounts }))
  const prefix = `AKTER_${stage.toUpperCase()}_${location.toUpperCase().replaceAll("-", "_")}`
  return {
    stage,
    region: location,
    accountId,
    organizationId: yield* Config.String("AKTER_ORGANIZATION_ID"),
    profile: yield* Config.String(`AKTER_${stage.toUpperCase()}_AWS_PROFILE`).pipe(
      Config.withDefault(`akter-${stage}`),
    ),
    zone: yield* Config.String(`${prefix}_ZONE`),
    certificateArn: yield* Config.String(`${prefix}_CERTIFICATE_ARN`),
    imageTag: yield* Config.String(`${prefix}_IMAGE_TAG`),
    planetscaleOrganization: yield* Config.String("PLANETSCALE_ORGANIZATION"),
    nekiClusterSize: yield* Config.String(`${prefix}_NEKI_CLUSTER_SIZE`),
    nekiRouterSize: yield* Config.String(`${prefix}_NEKI_ROUTER_SIZE`),
    nekiShardCount: yield* Config.Int(`${prefix}_NEKI_SHARD_COUNT`).pipe(Config.withDefault(1)),
    notifierId: yield* Config.String("AXIOM_NOTIFIER_ID"),
    customHostnames: yield* Config.schema(
      Schema.fromJsonString(Schema.Array(Schema.String)),
      `${prefix}_CUSTOM_HOSTNAMES`,
    ).pipe(Config.withDefault([])),
    name: `akter-${stage}-${location}`,
    stateBucket: `akter-state-${accountId}-${location}-an`,
  }
}).pipe(Effect.orDie)

export type Deployment = Effect.Success<typeof deployment>
