import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"

/** Reads hosted deployments from the control-plane database. */
export class Deployments extends Context.Service<
  Deployments,
  {
    /** The deployment's primary region, which never changes once it is created. */
    readonly primaryRegion: (deployment: string) => Effect.Effect<Option.Option<string>>
  }
>()("@durable-actors/deployments/deployment/repository/Deployments") {}

/** `Deployments` over the control-plane database; a database failure is a defect. */
export const DeploymentsLive = Layer.effect(
  Deployments,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      primaryRegion: (deployment) =>
        sql<{ readonly primary_region: string }>`
          SELECT primary_region FROM deployment WHERE id = ${deployment}
        `.pipe(
          Effect.map(([row]) => Option.fromNullishOr(row?.primary_region)),
          Effect.orDie,
        ),
    }
  }),
)
