import { Cause, Deferred, Effect, Schema } from "effect"
import { ClusterSchema, Entity, Sharding } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { SqlError } from "effect/unstable/sql"
import { ActorError } from "../../errors/actor.ts"
import { Outcome, type Registration, Request } from "../../handles/actors.ts"
import { executeTurn } from "../turn/execute.ts"
import { RetryTurn, TurnHooks } from "../turn/hooks.ts"

// Commands are direct: the Cluster message is volatile and the receipt
// committed inside the turn is the only durable admission record.
// A lost runner loses only uncommitted work, which the caller retries by id.
export const commandEntity = (name: string) =>
  Entity.make(name, [
    Rpc.make("Execute", { payload: Request, success: Outcome, error: ActorError }),
  ]).annotateRpcs(ClusterSchema.Uninterruptible, true)

export const registerActor = Effect.fnUntraced(function* (registration: Registration) {
  const sharding = yield* Sharding.Sharding
  const services = yield* Effect.context<Effect.Services<ReturnType<typeof executeTurn>>>()
  const entity = commandEntity(registration.name)

  const register = sharding.registerEntity(
    entity,
    Effect.sync(() => {
      let generation: string | undefined

      return entity.of({
        Execute: Effect.fnUntraced(function* ({ payload }) {
          const command = registration.commands.get(payload.command)

          if (command === undefined)
            return yield* Effect.die(new Error(`Unregistered command ${payload.command}`))

          const committed = yield* executeTurn(
            payload,
            command,
            generation,
            registration.policy,
          ).pipe(
            Effect.catchDefect(
              Effect.fnUntraced(function* (cause) {
                if (
                  Schema.is(RetryTurn)(cause) ||
                  (SqlError.isSqlError(cause) && cause.isRetryable)
                )
                  return yield* Effect.die(cause)

                // Deterministic defects run no user code, because a defect hook
                // can loop on corrupt state; the turn span and this log carry
                // the cause for operators.
                yield* Effect.logError("Deterministic actor defect", Cause.die(cause))

                return { outcome: Outcome.cases.Defect.make({ cause }), generation }
              }),
            ),
            Effect.annotateLogs({
              actor: payload.ref.actor,
              id: payload.ref.id,
              tenant: payload.ref.tenant,
              command: payload.command,
              commandId: payload.commandId,
            }),
            Effect.withSpan(`durable-actors.${payload.ref.actor}/${payload.command}`, {
              attributes: {
                "actor.tenant": payload.ref.tenant,
                "actor.id": payload.ref.id,
                "command.id": payload.commandId,
              },
            }),
          )

          generation = committed.generation
          const hooks = yield* TurnHooks

          if (!Outcome.guards.Defect(committed.outcome)) yield* hooks.at("afterCommit", payload)

          return committed.outcome
        }, Effect.provideContext(services)),
      })
    }),
    {
      concurrency: 1,
      maxIdleTime: registration.policy.idleMs,
      mailboxCapacity: registration.policy.mailboxCapacity,
    },
  )

  if (registration.singleton) {
    const ready = yield* Deferred.make<void>()
    yield* sharding.registerSingleton(
      registration.name,
      register.pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
    )
    yield* Deferred.await(ready)
  } else yield* register
})
