import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted } from "effect"
import { Actors, Database } from "../../../../runtime/index.ts"
import { FleetHooks } from "../../../../runtime/fleet/maintainer.ts"
import { FleetOrderLive, OrdersByRegion, OrdersByStatus } from "../../fleet.ts"

/**
 * A runner that maintains the fleet cases' views in its own process. With
 * `FLEET_CRASH=afterApply` it prints APPLIED once a batch's derived rows have
 * committed and waits there, before the slot advances, for the parent to
 * SIGKILL it; otherwise it maintains until it is killed.
 */
const live = Layer.unwrap(
  Effect.gen(function* () {
    const crash = (yield* Config.String("FLEET_CRASH")) === "afterApply"
    const database = yield* Config.String("FLEET_DATABASE_URL")

    const hooks = Layer.succeed(FleetHooks, {
      afterApply: crash ? Console.log("APPLIED").pipe(Effect.andThen(Effect.never)) : Effect.void,
    })

    return FleetOrderLive.pipe(
      Layer.provideMerge(
        Actors.layer({
          authorize: () => Effect.succeed(true),
          fleet: [OrdersByStatus, OrdersByRegion],
        }).pipe(Layer.provide(hooks)),
      ),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database), maxConnections: 4 })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

Layer.effectDiscard(Console.log("STARTED")).pipe(
  Layer.provide(live),
  Layer.launch,
  BunRuntime.runMain,
)
