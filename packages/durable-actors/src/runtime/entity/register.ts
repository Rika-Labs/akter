import { Cause, Deferred, Effect, Exit, Schema } from "effect"
import { ClusterSchema, Entity, Sharding } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError } from "../../errors/actor.ts"
import { Outcome, type Registration, Request } from "../../handles/actors.ts"
import { executeTurn } from "../turn/execute.ts"
import { RetryTurn, TurnHooks } from "../turn/hooks.ts"

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
                const sql = yield* SqlClient.SqlClient

                const state = sql<{
                  key: string
                  value: string
                }>`SELECT key, value::text AS value FROM actor_state
                WHERE tenant_id = ${payload.ref.tenant} AND actor_type = ${payload.ref.actor} AND actor_id = ${payload.ref.id}`.pipe(
                  Effect.map((rows) => rows.map(({ key, value }) => [key, value] as const)),
                  Effect.orDie,
                )

                const hook = yield* Effect.suspend(() =>
                  registration.onDefect(payload.ref, cause, state),
                ).pipe(
                  Effect.interruptible,
                  Effect.timeout(registration.policy.executionMs),
                  Effect.exit,
                )

                const reported = Exit.isFailure(hook)
                  ? new AggregateError(
                      [cause, Cause.squash(hook.cause)],
                      `onDefect failed: ${String(Cause.squash(hook.cause))}`,
                      { cause },
                    )
                  : cause

                return { outcome: Outcome.cases.Defect.make({ cause: reported }), generation }
              }),
            ),
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
