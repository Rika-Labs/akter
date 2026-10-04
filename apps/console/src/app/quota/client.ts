import { Effect, Option } from "effect"
import { cloud, fixturesEnabled, organizationContext } from "../api/client.ts"
import { CapNotice, capNotice } from "./model.ts"

/**
 * The cap the edge is refusing at now, read from the organization's usage report, which carries
 * the control plane's per-cap state. A usage report refused with reason `unknownPlan` means the
 * edge refuses every new command for the organization, so that is the notice. Pages show it beside
 * their own data, so any other failed read, or fixture mode, means no notice rather than a failed
 * page.
 */
export const organizationCap: Effect.Effect<Option.Option<CapNotice>> = Effect.suspend(() =>
  fixturesEnabled()
    ? Effect.succeedNone
    : Effect.gen(function* () {
        const api = yield* cloud
        const { organization } = yield* organizationContext
        return yield* api.usage
          .get({ params: { organizationId: organization.id }, query: {} })
          .pipe(
            Effect.map((usage) =>
              Option.fromUndefinedOr(capNotice({ caps: usage.caps ?? [], period: usage.period })),
            ),
            Effect.catchTag("Unavailable", (error) =>
              error.reason === "unknownPlan"
                ? Effect.succeedSome(CapNotice.UnknownPlan())
                : Effect.fail(error),
            ),
          )
      }).pipe(Effect.orElseSucceed(Option.none)),
)
