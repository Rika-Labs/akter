import * as Alchemy from "alchemy"
import * as AWS from "alchemy/AWS"
import { Stage } from "alchemy/Stage"
import { retain } from "alchemy/RemovalPolicy"
import { Config, Effect } from "effect"
import * as STS from "@distilled.cloud/aws/sts"

/** Account vending is a separate retained stack so service teardown cannot close an AWS account. */
export default Alchemy.Stack(
  "akter-organization",
  { providers: AWS.providers(), state: AWS.state({ prefix: "organization" }) },
  Effect.gen(function* () {
    if ((yield* Stage) !== "organization")
      return yield* Effect.die(new Error("Account vending requires --stage organization"))
    const managementAccountId = yield* Config.String("AKTER_MANAGEMENT_ACCOUNT_ID")
    const environment = yield* AWS.AWSEnvironment.current
    const identity = yield* STS.getCallerIdentity({}).pipe(Effect.orDie)
    if (identity.Account !== managementAccountId || environment.region !== "us-east-1")
      return yield* Effect.die(
        new Error("Account vending requires the management account in us-east-1"),
      )
    const organization = yield* AWS.Organizations.Organization("Organization", {
      featureSet: "ALL",
    }).pipe(retain())
    const root = yield* AWS.Organizations.Root("Root", {
      tags: { Organization: organization.organizationId },
    }).pipe(retain())
    const accounts = yield* Effect.forEach(["dev", "staging", "prod"] as const, (stage) =>
      Effect.gen(function* () {
        const email = yield* Config.String(`AKTER_${stage.toUpperCase()}_ACCOUNT_EMAIL`)
        const account = yield* AWS.Organizations.Account(stage, {
          name: `akter-${stage}`,
          email,
          parentId: root.rootId,
          roleName: "OrganizationAccountAccessRole",
          tags: { Stage: stage, Organization: organization.organizationId },
        }).pipe(retain())
        return { stage, accountId: account.accountId }
      }),
    )
    return { organizationId: organization.organizationId, accounts }
  }),
)
