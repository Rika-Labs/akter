import {
  Cause,
  Context,
  type Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Latch,
  Option,
  Result,
  Schedule,
  Schema,
  Scope,
  Tracer,
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
import {
  Outcome,
  type RegisteredCommand,
  type Registration,
  Request,
} from "../../handles/actors.ts"
import { ActorRef } from "../../identity/caller.ts"
import { routingKey } from "../storage/codec.ts"
import { ShardLease } from "../topology/locks.ts"
import { takeBatch } from "./mailbox.ts"
import { executeBatch } from "../turn/execute.ts"
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

// Per entity scope, the command ids of a batch a retryable defect aborted;
// they outlive the handler the defect rebuilt, so each runs alone once.
const aloneAfterFailure = new WeakMap<Scope.Scope, Set<string>>()

/** A command in an activation's mailbox and the caller waiting on its reply. */
interface Waiting {
  readonly request: Request
  readonly command: RegisteredCommand
  readonly reply: Deferred.Deferred<Outcome, ActorError>
  /**
   * The request's own context, under the runtime's services, as the turn ran
   * in before batching: its span is the turn span's parent.
   */
  context: Context.Context<never>
}

// Defects that say nothing about the command: the activation restarts and
// the caller retries the same id.
const retryable = (cause: Cause.Cause<unknown>) => {
  const defect = Cause.squash(cause)

  return Schema.is(RetryTurn)(defect) || (SqlError.isSqlError(defect) && defect.isRetryable)
}

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
    Effect.Services<ReturnType<typeof executeBatch>> | Crypto.Crypto
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

  const leaseLostDefect = RetryTurn.make({
    message: "Singleton runner no longer holds its shard lock",
  })

  const leaseLost = Effect.die(leaseLostDefect)

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

      const policy = registration.policy
      const statements = registration.tables.length > 0 || registration.blobs.length > 0

      // Commands wait here in delivery order; one worker runs them as turn
      // batches, so an activation still has one transaction in flight.
      const waiting: Array<Waiting> = []
      const ready = Latch.makeUnsafe(false)
      const alone = aloneAfterFailure.get(activation) ?? new Set<string>()
      aloneAfterFailure.set(activation, alone)

      // Connection broadcasts of a batch go out once it commits.
      const execute = (batch: ReadonlyArray<Waiting>) =>
        Effect.gen(function* () {
          yield* owner.prepare(owned)

          const done = yield* executeBatch(
            batch,
            owned.cache,
            owned.key,
            policy,
            registration.mintable,
            statements,
            waited,
            owner.hasConnections ? owner.list(owned) : undefined,
          )

          if (owner.hasConnections) yield* owner.flush(owned, done.broadcasts, done.head)

          return done.settled
        })

      // A lone command's turn: its span and logs name the command, and a
      // deterministic defect answers the caller with `Defect`.
      const runAlone = (entry: Waiting) => {
        const { request } = entry

        return execute([entry]).pipe(
          Effect.flatMap(([settled]) =>
            Result.isSuccess(settled!)
              ? Effect.succeed(settled.success)
              : Effect.fail(settled!.failure),
          ),
          Effect.catchDefect(
            Effect.fnUntraced(function* (cause) {
              if (retryable(Cause.die(cause))) return yield* Effect.die(cause)

              // Deterministic defects run no user code, because a defect hook
              // can loop on corrupt state; the turn span and this log carry
              // the cause for operators.
              yield* Effect.logError("Deterministic actor defect", Cause.die(cause))

              return Outcome.cases.Defect.make({ cause })
            }),
          ),
          Effect.annotateLogs({
            actor: request.ref.actor,
            id: request.ref.id,
            tenant: request.ref.tenant,
            command: request.command,
            commandId: request.commandId,
          }),
          // The span's call site is always this file, so a captured stack
          // trace would cost an Error per turn and name nothing useful.
          Effect.withSpan(
            `durable-actors.${request.ref.actor}/${request.command}`,
            {
              attributes: {
                "actor.tenant": request.ref.tenant,
                "actor.id": request.ref.id,
                "command.id": request.commandId,
              },
            },
            { captureStackTrace: false },
          ),
          Effect.exit,
        )
      }

      // Replies follow the commit: each command's caller hears its outcome
      // only after the batch that ran it committed.
      const settle = Effect.fnUntraced(function* (
        entry: Waiting,
        exit: Exit.Exit<Outcome, ActorError>,
      ) {
        const { request } = entry

        if (Exit.isSuccess(exit) && !Outcome.guards.Defect(exit.value)) {
          yield* (yield* TurnHooks).at("afterCommit", request)

          if (workflowRoutes.has(request.command)) {
            const kicked = yield* kickedExecution({ request, outcome: exit.value })

            if (kicked !== undefined) {
              engine ??= yield* activationEngine({
                registration,
                ref: request.ref,
                routingKey: routingKeyOf(request.ref),
                cache: owned.cache,
                scope,
                deliveryMs: policy.deliveryMs,
              })
              yield* engine.kick(kicked.executionId, kicked.interrupt)
            }
          }
        }

        yield* Deferred.done(entry.reply, exit)
      })

      // A defect that restarts the activation answers every unanswered
      // caller of the batch with it, and Cluster redelivers those commands to
      // the rebuilt handler. This worker stops, so it never runs beside it.
      const restart = (batch: ReadonlyArray<Waiting>, cause: Cause.Cause<unknown>) =>
        Effect.forEach(
          batch,
          (entry) => Deferred.failCause(entry.reply, Cause.die(Cause.squash(cause))),
          { discard: true },
        ).pipe(Effect.andThen(Effect.interrupt))

      // A defect that reaches here, including one from the afterCommit hook
      // after a commit, restarts the activation.
      const deliver = (entry: Waiting, exit: Exit.Exit<Outcome, ActorError>) =>
        Exit.isFailure(exit) && Cause.hasDies(exit.cause)
          ? Effect.failCause(exit.cause)
          : settle(entry, exit)

      const runBatch = Effect.fnUntraced(function* (batch: ReadonlyArray<Waiting>) {
        if (lost) return yield* Effect.die(leaseLostDefect)

        if (batch.length === 1) return yield* deliver(batch[0]!, yield* runAlone(batch[0]!))

        const { ref } = batch[0]!.request

        const exit = yield* execute(batch).pipe(
          Effect.annotateLogs({ actor: ref.actor, id: ref.id, tenant: ref.tenant }),
          Effect.withSpan(
            `durable-actors.${ref.actor}/batch`,
            {
              attributes: {
                "actor.tenant": ref.tenant,
                "actor.id": ref.id,
                "batch.size": batch.length,
              },
              links: batch.flatMap(({ context }) => {
                const span = Context.getOrUndefined(context, Tracer.ParentSpan)

                return span === undefined ? [] : [{ span, attributes: {} }]
              }),
            },
            { captureStackTrace: false },
          ),
          Effect.exit,
        )

        if (Exit.isSuccess(exit)) {
          for (const [index, settled] of exit.value.entries())
            yield* settle(
              batch[index]!,
              Result.isSuccess(settled)
                ? Exit.succeed(settled.success)
                : Exit.fail(settled.failure),
            )

          return
        }

        // A defect aborts the whole batch. Its commands then run one per
        // transaction until each is processed, so one bad command cannot
        // keep rolling back its neighbours. A retryable defect restarts the
        // activation first, and the redelivered commands run alone there.
        if (retryable(exit.cause)) {
          for (const { request } of batch) alone.add(request.commandId)

          return yield* Effect.failCause(exit.cause)
        }

        yield* Effect.logDebug("Turn batch failed; running its commands one at a time", exit.cause)

        for (const entry of batch) yield* deliver(entry, yield* runAlone(entry))
      })

      yield* Effect.gen(function* () {
        while (true) {
          yield* ready.await
          const batch = takeBatch({ waiting, alone })

          if (waiting.length === 0) ready.closeUnsafe()

          if (batch.length > 0)
            yield* runBatch(batch).pipe(
              Effect.provideContext(Context.merge(batch[0]!.context, services)),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => restart(batch, cause),
              ),
            )
        }
      }).pipe(Effect.provideContext(services), Effect.forkIn(scope))

      return entity.of({
        Wake: () => Effect.suspend(() => (lost ? leaseLost : Effect.void)),
        // Enqueues synchronously, when Cluster delivers the request, so the
        // mailbox keeps delivery order; the reply is awaited outside the
        // server's one-at-a-time limit, which the worker enforces instead.
        // The server starts the forked effect in the same call, so the entry
        // has its context before the worker can take it.
        Execute: ({ payload }) => {
          if (lost) return leaseLost

          if (Exit.isFailure(activated))
            return Effect.succeed(
              Outcome.cases.Defect.make({ cause: Cause.squash(activated.cause) }),
            )

          const command =
            activated.value.get(payload.command) ?? workflowRoutes.get(payload.command)

          if (command === undefined)
            return Effect.die(new Error(`Unregistered command ${payload.command}`))

          const entry: Waiting = {
            request: payload,
            command,
            reply: Deferred.makeUnsafe<Outcome, ActorError>(),
            context: Context.empty(),
          }

          waiting.push(entry)

          return Rpc.fork(
            Effect.gen(function* () {
              entry.context = yield* Effect.context<never>()
              ready.openUnsafe()
              yield* (yield* TurnHooks).at("queued", payload)

              return yield* Deferred.await(entry.reply)
            }).pipe(Effect.provideContext(services)),
          )
        },
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
