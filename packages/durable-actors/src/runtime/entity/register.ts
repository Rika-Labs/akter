import { Effect } from "effect"
import { ClusterSchema, Entity, Sharding } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { ActorError } from "../../errors/actor.ts"
import { Outcome, type Registration, Request } from "../../handles/actors.ts"
import { executeTurn } from "../turn/execute.ts"
import { TurnHooks } from "../turn/hooks.ts"

// Redelivery/fencing evidence: testing/conformance/postgres.test.ts and crash/main.test.ts.
export const commandEntity = (name: string) =>
  Entity.make(name, [
    Rpc.make("Execute", { payload: Request, success: Outcome, error: ActorError }),
  ])
    .annotateRpcs(ClusterSchema.Persisted, true)
    .annotateRpcs(ClusterSchema.WithTransaction, false)
    .annotateRpcs(ClusterSchema.Uninterruptible, true)

export const registerActor = Effect.fnUntraced(function* (registration: Registration) {
  const sharding = yield* Sharding.Sharding
  const services = yield* Effect.context<Effect.Services<ReturnType<typeof executeTurn>>>()
  const entity = commandEntity(registration.name)
  yield* sharding.registerEntity(
    entity,
    Effect.sync(() => {
      let generation: string | undefined

      return entity.of({
        Execute: Effect.fnUntraced(function* ({ payload }) {
          const command = registration.commands.get(payload.command)

          if (command === undefined)
            return yield* Effect.die(new Error(`Unregistered command ${payload.command}`))

          const committed = yield* executeTurn(payload, command, generation).pipe(
            Effect.catchIf(
              (error): error is import("../../handles/actors.ts").BusinessResult =>
                "outcome" in error,
              (error) => Effect.succeed({ outcome: error.outcome, generation }),
            ),
          )

          generation = committed.generation
          const hooks = yield* TurnHooks

          if (!Outcome.guards.Defect(committed.outcome)) yield* hooks.at("afterCommit", payload)

          return committed.outcome
        }, Effect.provideContext(services)),
      })
    }),
    { concurrency: 1, maxIdleTime: "1 minute" },
  )
})
