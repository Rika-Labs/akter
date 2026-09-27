import { Cause, Deferred, Effect, Schema } from "effect"
import { ClusterSchema, Entity, Sharding } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError } from "../../errors/actor.ts"
import { Outcome, type Registration, Request } from "../../handles/actors.ts"
import { routingKey } from "../storage/codec.ts"
import { executeTurn } from "../turn/execute.ts"
import { activationOwner } from "../connections/owner.ts"
import { connectionsEntity } from "../connections/protocol.ts"
import type { Transport } from "../connections/transport.ts"
import { RetryTurn, TurnHooks } from "../turn/hooks.ts"

// Commands are direct: the Cluster message is volatile and the receipt
// committed inside the turn is the only durable admission record.
// A lost runner loses only uncommitted work, which the caller retries by id.
const makeCommandEntity = (name: string) =>
  Entity.make(name, [
    Rpc.make("Execute", { payload: Request, success: Outcome, error: ActorError }),
  ]).annotateRpcs(ClusterSchema.Uninterruptible, true)

const commandEntities = new Map<string, ReturnType<typeof makeCommandEntity>>()

// Sharding keeps one RPC client per entity object, by identity, until the
// runtime closes; a fresh entity per command would retain a client per command.
export const commandEntity = (name: string) => {
  const cached = commandEntities.get(name)

  if (cached !== undefined) return cached

  const entity = makeCommandEntity(name)
  commandEntities.set(name, entity)

  return entity
}

const connectionEntities = new Map<string, ReturnType<typeof connectionsEntity>>()

export const connectionEntity = (name: string) => {
  const cached = connectionEntities.get(name)

  if (cached !== undefined) return cached

  const entity = connectionsEntity(name)
  connectionEntities.set(name, entity)

  return entity
}

const decodeEntityId = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
)

export const registerActor = Effect.fnUntraced(function* (
  registration: Registration,
  transport: Transport,
) {
  const sharding = yield* Sharding.Sharding
  const owner = activationOwner({ registration, transport })

  const activationOf = (entityId: string) =>
    Effect.flatMap(Effect.orDie(decodeEntityId(entityId)), ([tenant, id]) => {
      const ref = { actor: registration.name, tenant, id }

      return owner.enter(entityId, ref, routingKey({ ref, placement: registration.placement }))
    })

  const services = yield* Effect.context<Effect.Services<ReturnType<typeof executeTurn>>>()
  const entity = commandEntity(registration.name)
  // Cluster reports a full mailbox and a full runner with the same error; only
  // an activation that is already resident can have a full mailbox. A handler
  // rebuilt after a defect can overlap its predecessor, hence the count.
  const resident = new Map<string, number>()

  const register = sharding.registerEntity(
    entity,
    Effect.gen(function* () {
      const { entityId } = yield* Entity.CurrentAddress
      yield* Effect.acquireRelease(
        Effect.sync(() => resident.set(entityId, (resident.get(entityId) ?? 0) + 1)),
        () =>
          Effect.sync(() => {
            const count = resident.get(entityId)! - 1

            if (count === 0) resident.delete(entityId)
            else resident.set(entityId, count)
          }),
      )
      const activation = yield* activationOf(entityId)

      return entity.of({
        Execute: Effect.fnUntraced(function* ({ payload }) {
          const command = registration.commands.get(payload.command)

          if (command === undefined)
            return yield* Effect.die(new Error(`Unregistered command ${payload.command}`))

          const outcome = yield* Effect.gen(function* () {
            yield* owner.prepare(activation)

            const done = yield* executeTurn(
              payload,
              command,
              activation.cache,
              activation.key,
              registration.policy,
              owner.hasConnections ? owner.list(activation) : undefined,
            )

            if (owner.hasConnections) yield* owner.flush(activation, done.broadcasts, done.head)

            return done.outcome
          }).pipe(
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

                return Outcome.cases.Defect.make({ cause })
              }),
            ),
            Effect.annotateLogs({
              actor: payload.ref.actor,
              id: payload.ref.id,
              tenant: payload.ref.tenant,
              command: payload.command,
              commandId: payload.commandId,
            }),
            // The span's call site is always this file, so a captured stack
            // trace would cost an Error per turn and name nothing useful.
            Effect.withSpan(
              `durable-actors.${payload.ref.actor}/${payload.command}`,
              {
                attributes: {
                  "actor.tenant": payload.ref.tenant,
                  "actor.id": payload.ref.id,
                  "command.id": payload.commandId,
                },
              },
              { captureStackTrace: false },
            ),
          )

          const hooks = yield* TurnHooks

          if (!Outcome.guards.Defect(outcome)) yield* hooks.at("afterCommit", payload)

          return outcome
        }, Effect.provideContext(services)),
      })
    }),
    {
      concurrency: 1,
      maxIdleTime: registration.policy.idleMs,
      mailboxCapacity: registration.policy.mailboxCapacity,
    },
  )

  const connections = connectionEntity(registration.name)
  const connectionServices = yield* Effect.context<SqlClient.SqlClient>()

  const registerConnections = owner.hasConnections
    ? sharding.registerEntity(
        connections,
        Effect.gen(function* () {
          const { entityId } = yield* Entity.CurrentAddress
          const activation = yield* activationOf(entityId)

          return connections.of({
            Open: ({ payload }) =>
              owner.open(activation, payload).pipe(Effect.provideContext(connectionServices)),
            Frame: ({ payload }) =>
              owner.frame(activation, payload).pipe(Effect.provideContext(connectionServices)),
            Close: ({ payload }) =>
              owner.close(activation, payload).pipe(Effect.provideContext(connectionServices)),
            Resync: ({ payload }) =>
              owner.resync(activation, payload).pipe(Effect.provideContext(connectionServices)),
          })
        }),
        { concurrency: "unbounded", maxIdleTime: registration.policy.idleMs },
      )
    : Effect.void

  if (registration.singleton) {
    const ready = yield* Deferred.make<void>()
    yield* sharding.registerSingleton(
      registration.name,
      register.pipe(
        Effect.andThen(registerConnections),
        Effect.andThen(Deferred.succeed(ready, undefined)),
      ),
    )
    yield* Deferred.await(ready)
  } else {
    yield* register
    yield* registerConnections
  }

  return { isResident: (entityId: string) => resident.has(entityId), owner }
})
