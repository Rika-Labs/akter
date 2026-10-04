import { Effect, Option } from "effect"
import { cloud, fixturesEnabled, organizationContext } from "../api/client.ts"
import { capNotice, type CapNotice } from "./model.ts"

/**
 * The cap the edge is refusing at now, read from the organization's usage report, which carries
 * the control plane's per-cap state. Pages show it beside their own data, so a read that fails, or
 * fixture mode, means no notice rather than a failed page.
 */
export const organizationCap: Effect.Effect<Option.Option<CapNotice>> = Effect.suspend(() =>
  fixturesEnabled()
    ? Effect.succeedNone
    : Effect.gen(function* () {
        const api = yield* cloud
        const { organization } = yield* organizationContext
        const usage = yield* api.usage.get({
          params: { organizationId: organization.id },
          query: {},
        })
        return Option.fromUndefinedOr(capNotice({ caps: usage.caps ?? [], period: usage.period }))
      }).pipe(Effect.orElseSucceed(Option.none)),
)
