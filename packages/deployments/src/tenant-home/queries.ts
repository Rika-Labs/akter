import { Effect, Option } from "effect"
import { TenantHome, tenantDirectory } from "./contract.ts"

/** Query handlers for `TenantHome`. */
export const TenantHomeReads = TenantHome.toQueryLayer({
  Lookup: Effect.fnUntraced(function* () {
    const read = yield* TenantHome.Read
    const row = yield* read.rows(tenantDirectory).one()

    return Option.match(row, {
      onNone: () => undefined,
      onSome: ({ deploymentId, tenant, region, state }) => ({
        deployment: deploymentId,
        tenant,
        region,
        state,
      }),
    })
  }),
})
