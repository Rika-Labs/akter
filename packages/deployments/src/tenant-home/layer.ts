import { Effect, Option } from "effect"
import { Deployments } from "../deployment/repository.ts"
import {
  NotPrimaryRegion,
  TenantAlreadyHomed,
  TenantHome,
  tenantDirectory,
  UnknownDeployment,
} from "./contract.ts"

/** The deployment and tenant a `TenantHome` key names. */
export const splitKey = (key: string) => {
  const slash = key.indexOf("/")

  return { deployment: key.slice(0, slash), tenant: key.slice(slash + 1) }
}

export const TenantHomeCommands = TenantHome.toLayer(
  Effect.gen(function* () {
    const deployments = yield* Deployments

    return {
      Create: Effect.fnUntraced(function* ({ region }) {
        const turn = yield* TenantHome.Turn
        const { deployment, tenant } = splitKey(turn.id)
        const rows = turn.rows(tenantDirectory)
        const existing = yield* rows.one()

        if (Option.isSome(existing)) {
          if (existing.value.region !== region)
            return yield* TenantAlreadyHomed.make({ region: existing.value.region })

          return { deployment, tenant, region, state: existing.value.state }
        }

        const primaryRegion = yield* deployments.primaryRegion(deployment)

        if (Option.isNone(primaryRegion)) return yield* UnknownDeployment.make({ deployment })

        if (primaryRegion.value !== region)
          return yield* NotPrimaryRegion.make({ region, primaryRegion: primaryRegion.value })

        yield* rows.insert({ deploymentId: deployment, tenant, region, state: "active" })

        return { deployment, tenant, region, state: "active" as const }
      }),
    }
  }),
)
