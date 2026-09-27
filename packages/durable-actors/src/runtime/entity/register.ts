import {
  Cause,
  Context,
  type Crypto,
  Duration,
  Effect,
  Exit,
  Option,
  Schedule,
  Schema,
  Scope,
} from "effect"
import {
  ClusterSchema,
  Entity,
  EntityId as ClusterEntityId,
  Sharding,
  ShardId,
} from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError } from "../../errors/actor.ts"
import { Outcome, type Registration, Request } from "../../handles/actors.ts"
import { ActorRef } from "../../identity/caller.ts"
import { routingKey } from "../storage/codec.ts"
import { ShardLease } from "../topology/locks.ts"
import { executeTurn } from "../turn/execute.ts"
import { activationOwner } from "../connections/owner.ts"
import { connectionsEntity } from "../connections/protocol.ts"
import type { Transport } from "../connections/transport.ts"
import { RetryTurn, TurnHooks } from "../turn/hooks.ts"
import { activationEngine, kickedExecution, workflowCommands } from "../workflows/engine.ts"

// Commands are direct: the Cluster message is volatile and the receipt
// committed inside the turn is the only durable admission record.
// A lost runner loses only uncommitted work, which the caller retries by id.
// `Wake` builds the activation without running a turn.
const makeCommandEntity = (name: string) =>
  Entity.make(name, [
    Rpc.make("Execute", { payload: Request, success: Outcome, error: ActorError }),
    Rpc.make("Wake"),
  ]).annotateRpcs(ClusterSchema.Uninterruptible, true)

// Cluster entity ids name the tenant and actor id together.
const EntityId = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))

const encodeEntityIdOf = Schema.encodeEffect(EntityId)

export const encodeEntityId = (tenantAndId: readonly [string, string]) =>
  encodeEntityIdOf(tenantAndId)

const decodeEntityId = Schema.decodeEffect(EntityId)

// How often a singleton's keeper re-wakes the default tenant's instance, and
// so bounds how long after its shard moves the instance is resident again.
const SINGLETON_WAKE_INTERVAL = Duration.seconds(1)

// Cluster's lifetime of one entity, shared by every handler a defect restart
// rebuilds within it.
const entityScope = () =>
  Effect.serviceOption(
    Context.Service<Scope.Scope>("effect/cluster/internal/CurrentActivationScope"),
  )

// The current handler's scope within each entity scope.
const handlerScopes = new WeakMap<Scope.Scope, Scope.Closeable>()

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

export const registerActor = Effect.fnUntraced(function* (
  registration: Registration,
  transport: Transport,
) {
  const sharding = yield* Sharding.Sharding
  const owner = activationOwner({ registration, transport })

  const ownedOf = (entityId: string) =>
    Effect.flatMap(Effect.orDie(decodeEntityId(entityId)), ([tenant, id]) => {
      const ref = { actor: registration.name, tenant, id }

      return owner.enter(entityId, ref, routingKey({ ref, placement: registration.placement }))
    })

  const services = yield* Effect.context<
    Effect.Services<ReturnType<typeof executeTurn>> | Crypto.Crypto
  >()

  const entity = commandEntity(registration.name)

  const routingKeyOf = (ref: Request["ref"]) =>
    routingKey({ ref, placement: registration.placement })

  const workflowRoutes = workflowCommands({ registration, routingKeyOf, services })

  // Event classes some workflow of this actor waits for; only these check waits on append.
  const waited = new Set(
    [...registration.workflows.values()].flatMap((workflow) =>
      [...workflow.member.registry.steps.values()].flatMap((step) =>
        step.event === undefined ? [] : [step.event],
      ),
    ),
  )

  // Cluster reports a full mailbox and a full runner with the same error; only
  // an activation that is already resident can have a full mailbox. A handler
  // rebuilt after a defect can overlap its predecessor, hence the count.
  const resident = new Map<string, number>()

  const lease = registration.singleton
    ? Option.getOrUndefined(yield* Effect.serviceOption(ShardLease))
    : undefined

  const leaseLost = Effect.die(
    RetryTurn.make({ message: "Singleton runner no longer holds its shard lock" }),
  )

  const register = sharding.registerEntity(
    entity,
    Effect.gen(function* () {
      const { entityId } = yield* Entity.CurrentAddress
      const [tenant, id] = yield* decodeEntityId(entityId).pipe(Effect.orDie)

      // A defect restart rebuilds the handler, and a defect while the entity
      // shuts down can drop the superseded handler's scope. Each handler's
      // resources live in a child of the entity's own scope instead, closed
      // when a rebuild supersedes it, the handler closes, or the entity ends.
      const activation = yield* entityScope().pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(new Error("Cluster provided no entity scope")),
            onSome: Effect.succeed,
          }),
        ),
      )

      const superseded = handlerScopes.get(activation)

      if (superseded !== undefined) yield* Scope.close(superseded, Exit.void)

      const shard =
        lease === undefined
          ? undefined
          : ShardId.toString(yield* entity.getShardId(ClusterEntityId.make(entityId)))

      // A singleton starts only on the runner holding its shard's lease, and
      // its background work stops as soon as the lease lapses.
      if (lease !== undefined && !(yield* lease.holds(shard!))) return yield* leaseLost

      const scope = yield* Scope.fork(activation)

      handlerScopes.set(activation, scope)
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

      let lost = false

      if (lease !== undefined)
        yield* lease.holds(shard!).pipe(
          Effect.repeat({ schedule: Schedule.spaced(lease.interval), until: (held) => !held }),
          Effect.andThen(
            Effect.sync(() => {
              lost = true
            }),
          ),
          Effect.andThen(Effect.forkDetach(Scope.close(scope, Exit.void))),
          Effect.forkIn(scope),
        )

      yield* Effect.acquireRelease(
        Effect.sync(() => resident.set(entityId, (resident.get(entityId) ?? 0) + 1)),
        () =>
          Effect.sync(() => {
            const count = resident.get(entityId)! - 1

            if (count === 0) resident.delete(entityId)
            else resident.set(entityId, count)
          }),
      ).pipe(Scope.provide(scope))

      const owned = yield* ownedOf(entityId)
      let engine: Effect.Success<ReturnType<typeof activationEngine>> | undefined

      // A singleton builds here, on its owner; a failing build answers every
      // command with its defect instead of retrying the activation forever.
      const activated = yield* registration
        .activate(ActorRef.make({ tenant, actor: registration.name, id }))
        .pipe(Scope.provide(scope), Effect.exit)

      if (Exit.isFailure(activated))
        yield* Effect.logError("Actor activation failed", activated.cause).pipe(
          Effect.annotateLogs({ actor: registration.name, id, tenant }),
        )

      return entity.of({
        Wake: () => Effect.suspend(() => (lost ? leaseLost : Effect.void)),
        Execute: Effect.fnUntraced(function* ({ payload }) {
          if (lost) return yield* leaseLost

          if (Exit.isFailure(activated))
            return Outcome.cases.Defect.make({ cause: Cause.squash(activated.cause) })

          const command =
            activated.value.get(payload.command) ?? workflowRoutes.get(payload.command)

          if (command === undefined)
            return yield* Effect.die(new Error(`Unregistered command ${payload.command}`))

          const outcome = yield* Effect.gen(function* () {
            yield* owner.prepare(owned)

            const done = yield* executeTurn(
              payload,
              command,
              owned.cache,
              owned.key,
              registration.policy,
              registration.mintable,
              waited,
              owner.hasConnections ? owner.list(owned) : undefined,
            )

            if (owner.hasConnections) yield* owner.flush(owned, done.broadcasts, done.head)

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

          if (workflowRoutes.has(payload.command)) {
            const kicked = yield* kickedExecution({ request: payload, outcome })

            if (kicked !== undefined) {
              engine ??= yield* activationEngine({
                registration,
                ref: payload.ref,
                routingKey: routingKeyOf(payload.ref),
                cache: owned.cache,
                scope,
                deliveryMs: registration.policy.deliveryMs,
              })
              yield* engine.kick(kicked.executionId, kicked.interrupt)
            }
          }

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

  yield* register

  if (owner.hasConnections)
    yield* sharding.registerEntity(
      connections,
      Effect.gen(function* () {
        const { entityId } = yield* Entity.CurrentAddress
        const owned = yield* ownedOf(entityId)

        return connections.of({
          Open: ({ payload }) =>
            owner.open(owned, payload).pipe(Effect.provideContext(connectionServices)),
          Frame: ({ payload }) =>
            owner.frame(owned, payload).pipe(Effect.provideContext(connectionServices)),
          Close: ({ payload }) =>
            owner.close(owned, payload).pipe(Effect.provideContext(connectionServices)),
          Resync: ({ payload }) =>
            owner.resync(owned, payload).pipe(Effect.provideContext(connectionServices)),
        })
      }),
      { concurrency: "unbounded", maxIdleTime: registration.policy.idleMs },
    )

  // Every runner serves the singleton's entity, so its shard lock and the
  // generation fence keep each tenant's instance to one activation. One
  // keeper, on whichever runner Cluster runs it, keeps the default tenant's
  // instance resident and so moves it, and its background loop, to a survivor.
  if (registration.singleton) {
    const address = yield* encodeEntityId([registration.tenant, "singleton"]).pipe(Effect.orDie)
    const client = (yield* sharding.makeClient(entity))(address)

    const wakeInterval = Duration.min(
      SINGLETON_WAKE_INTERVAL,
      Duration.millis(registration.policy.idleMs / 2),
    )

    yield* sharding.registerSingleton(
      registration.name,
      client.Wake().pipe(
        Effect.timeoutOrElse({ duration: wakeInterval, orElse: () => Effect.void }),
        Effect.catchCause((cause) => Effect.logDebug("Singleton wake failed", cause)),
        Effect.repeat(Schedule.spaced(wakeInterval)),
      ),
    )
  }

  return { isResident: (entityId: string) => resident.has(entityId), owner }
})
