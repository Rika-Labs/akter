import * as AWS from "alchemy/AWS"
import * as AwsCredentials from "alchemy/AWS/Credentials"
import * as AwsRegion from "alchemy/AWS/Region"
import * as Provider from "alchemy/Provider"
import { State } from "alchemy/State"
import { DockerLive } from "alchemy/Docker/Docker"
import { Credentials, fromIni, AwsCredentialProviderError } from "@distilled.cloud/aws/Credentials"
import * as STS from "@distilled.cloud/aws/sts"
import * as Organizations from "@distilled.cloud/aws/organizations"
import { Context, Effect, Layer } from "effect"
import type { HttpClient } from "effect/http/HttpClient"
import { deployment } from "./config.ts"

/** Resolves only the selected profile and verifies account and organization before signing writes. */
const environment = Layer.effect(
  AWS.AWSEnvironment,
  Effect.gen(function* () {
    const config = yield* deployment
    const credentialContext = yield* Layer.build(fromIni({ profile: config.profile }))
    const resolve = Context.get(credentialContext, Credentials)
    const http = yield* Effect.context<HttpClient>()
    const verify = yield* Effect.cached(
      Effect.gen(function* () {
        const credentials = yield* resolve
        const identity = yield* STS.getCallerIdentity({}).pipe(
          Effect.provideService(Credentials, Effect.succeed(credentials)),
        )
        if (identity.Account !== config.accountId)
          return yield* Effect.die(new Error("AWS profile belongs to the wrong stage account"))
        const organization = yield* Organizations.describeOrganization({}).pipe(
          Effect.provideService(Credentials, Effect.succeed(credentials)),
        )
        if (organization.Organization?.Id !== config.organizationId)
          return yield* Effect.die(new Error("AWS account belongs to the wrong organization"))
      }).pipe(
        Effect.provideService(AWS.Region, Effect.succeed(config.region)),
        Effect.provideContext(http),
      ),
    )
    return {
      accountId: config.accountId,
      region: config.region,
      credentials: Effect.andThen(verify, resolve).pipe(
        Effect.mapError(
          (cause) =>
            new AwsCredentialProviderError({
              message: "Could not verify the selected stage account and organization",
              provider: "akter-stage",
              cause,
            }),
        ),
      ),
    }
  }).pipe(Effect.map(Effect.succeed)),
).pipe(Layer.orDie)

const context = Layer.mergeAll(AwsCredentials.fromEnvironment, AwsRegion.fromEnvironment).pipe(
  Layer.provideMerge(environment),
)

/** Uses a single pinned stage/region context, without the default account or local emulator fallback. */
export const providers = Layer.effect(
  AWS.Providers,
  Provider.collection([
    AWS.EC2.Vpc,
    AWS.EC2.Subnet,
    AWS.EC2.InternetGateway,
    AWS.EC2.RouteTable,
    AWS.EC2.Route,
    AWS.EC2.RouteTableAssociation,
    AWS.EC2.EIP,
    AWS.EC2.NatGateway,
    AWS.EC2.SecurityGroup,
    AWS.ECR.Repository,
    AWS.ECS.Cluster,
    AWS.ECS.TaskDefinition,
    AWS.ECS.Service,
    AWS.ELBv2.LoadBalancer,
    AWS.ELBv2.TargetGroup,
    AWS.ELBv2.Listener,
    AWS.IAM.Role,
    AWS.KMS.Key,
    AWS.SecretsManager.Secret,
    AWS.SSM.Parameter,
    AWS.SES.EmailIdentity,
    AWS.SES.ConfigurationSet,
    AWS.S3.Bucket,
  ]),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      AWS.EC2.VpcProvider(),
      AWS.EC2.SubnetProvider(),
      AWS.EC2.InternetGatewayProvider(),
      AWS.EC2.RouteTableProvider(),
      AWS.EC2.RouteProvider(),
      AWS.EC2.RouteTableAssociationProvider(),
      AWS.EC2.EIPProvider(),
      AWS.EC2.NatGatewayProvider(),
      AWS.EC2.SecurityGroupProvider(),
      AWS.ECR.RepositoryProvider(),
      AWS.ECS.ClusterProvider(),
      AWS.ECS.TaskDefinitionProvider(),
      AWS.ECS.ServiceProvider(),
      AWS.ELBv2.LoadBalancerProvider(),
      AWS.ELBv2.TargetGroupProvider(),
      AWS.ELBv2.ListenerProvider(),
      AWS.IAM.RoleProvider(),
      AWS.KMS.KeyProvider(),
      AWS.SecretsManager.SecretProvider(),
      AWS.SSM.ParameterProvider(),
      AWS.SES.EmailIdentityProvider(),
      AWS.SES.ConfigurationSetProvider(),
      AWS.S3.BucketProvider(),
    ),
  ),
  Layer.provideMerge(DockerLive),
  Layer.provideMerge(context),
)

/** The S3 backend bootstraps its bucket before the retained stack resource adopts and hardens it. */
export const state = Layer.effect(
  State,
  Effect.gen(function* () {
    const config = yield* deployment
    const services = yield* Effect.context<
      AWS.AWSEnvironment | Credentials | AWS.Region | HttpClient
    >()
    return yield* Effect.cached(
      AWS.makeS3State({
        bucketName: config.stateBucket,
        prefix: "alchemy",
        encryption: { sseAlgorithm: "AES256", blockedEncryptionTypes: ["SSE-C"] },
      }).pipe(Effect.provideContext(services), Effect.orDie),
    )
  }),
).pipe(Layer.provide(context), Layer.orDie)
