import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { EdgeOptions } from "../config.ts"
import { unavailable } from "./forward.ts"

/**
 * Records that a deployment served an authenticated request, as
 * `deployment.last_activity_at` on the control-plane database's own clock, so
 * a runner provider can decide idleness from one authority.
 *
 * The update is committed before the request is forwarded, and a failure to
 * record it fails the request as `ActorUnavailable`: an idle policy that
 * trusts this column must never see a deployment as quiet while it is
 * serving. Every forwarded request waits for its own committed activity write.
 */
export const activity = Effect.fnUntraced(function* (_options: EdgeOptions) {
  const sql = yield* SqlClient.SqlClient

  return {
    touch: Effect.fnUntraced(function* (deployment: string) {
      yield* sql`UPDATE deployment SET last_activity_at = now() WHERE id = ${deployment}`.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Deployment activity not recorded", cause).pipe(
            Effect.andThen(Effect.fail(unavailable("Deployment activity could not be recorded"))),
          ),
        ),
      )
    }),
  }
})
