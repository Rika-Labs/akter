import { Effect } from "effect"
import { deploymentOf, deploys } from "./fixtures.ts"
import { type DeploymentPage, DeploymentsPage } from "./model.ts"

/** Loads the deploy history. Fixture-backed until the deployments API is hosted. */
export const loadDeployments: Effect.Effect<DeploymentsPage> = Effect.succeed(
  DeploymentsPage.make({
    deploys,
  }),
)

/** Loads one deploy by commit, or nothing for a commit that was never deployed. */
export const loadDeployment = (commit: string): Effect.Effect<DeploymentPage | undefined> => {
  const deploy = deploys.find((candidate) => candidate.commit === commit)
  return Effect.succeed(deploy === undefined ? undefined : deploymentOf(deploy))
}
