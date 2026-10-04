import { Effect, Option } from "effect"
import { cloud, fixturesEnabled, organizationContext } from "../api/client.ts"
import { toBilling, toUsage } from "../settings/mapping.ts"
import { capReached, type CapNotice } from "./model.ts"

/**
 * The cap the organization has reached, read from its billing and this month's usage. Pages show it
 * beside their own data, so a read that fails, or fixture mode, means no notice rather than a
 * failed page.
 */
export const organizationCap: Effect.Effect<Option.Option<CapNotice>> = Effect.suspend(() =>
  fixturesEnabled()
    ? Effect.succeedNone
    : Effect.gen(function* () {
        const api = yield* cloud
        const { organization } = yield* organizationContext
        const params = { organizationId: organization.id }
        const [billing, usage] = yield* Effect.all(
          [api.billing.get({ params }), api.usage.get({ params, query: {} })],
          { concurrency: 2 },
        )
        const { plan } = billing
        if (!("id" in plan)) return Option.none()
        return Option.fromUndefinedOr(
          capReached({ billing: toBilling({ ...billing, plan }), usage: toUsage(usage) }),
        )
      }).pipe(Effect.orElseSucceed(Option.none)),
)
