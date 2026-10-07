import { Effect, type Schema } from "effect"
import type { SqlError } from "effect/sql"
import { NekiTopologyAccessDenied } from "../../../errors/database.ts"
import type { TopologyRefused } from "./topology.ts"

/** Startup privilege failures remain actionable typed failures instead of SQL defects. */
export const topologyRead = <A, R>(
  read: Effect.Effect<A, SqlError.SqlError | TopologyRefused | Schema.SchemaError, R>,
) =>
  read.pipe(
    Effect.catchReason(
      "SqlError",
      "AuthorizationError",
      () => Effect.fail(NekiTopologyAccessDenied.make({})),
      (_reason, error) => Effect.die(error),
    ),
    Effect.catchTags({ TopologyRefused: Effect.die, SchemaError: Effect.die }),
  )
