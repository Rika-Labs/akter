import {
  Cause,
  Clock,
  Context,
  type Crypto,
  Duration,
  Effect,
  Exit,
  Metric,
  Option,
  Schedule,
  Schema,
  Scope,
  Stream,
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
import { ActorError, ActorUnavailable } from "../../errors/actor.ts"
import { Outcome, type Registration, Request } from "../../handles/actors.ts"
import { ActorRef } from "../../identity/caller.ts"
import { bootstrapTicks } from "../cron/schedule.ts"
import { parentPlacement, routingKey } from "../storage/codec.ts"
import { ShardLease } from "../topology/locks.ts"
import { executeTurn } from "../turn/execute.ts"
import { activationOwner, type Authorize } from "../connections/owner.ts"
import { TenantScope } from "../database/tenancy.ts"
import { FrameworkClock } from "../turn/admission.ts"
import { connectionsEntity } from "../connections/protocol.ts"
import type { Transport } from "../connections/transport.ts"
import { RetryTurn, TurnHooks } from "../turn/hooks.ts"
import type { TurnGate } from "../drain.ts"
import { DefectLog } from "../telemetry/defects.ts"
import { count, Metrics, record } from "../telemetry/metrics.ts"
import { requestAttributes, SpanNames, triggerOf } from "../telemetry/spans.ts"
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

// A retryable turn failure, and a handler rebuilt after a death, wait
// `RESTART_BASE × 2^n`, capped at `RESTART_CAP`, where `n` counts the
// activation's failures and rebuilds since its last settled turn: prompt after
// a one-off failure, bounded for an actor whose turn fails on every attempt.
const RESTART_BASE = Duration.millis(50)

const RESTART_CAP = Duration.seconds(5)

const restartDelay = (restarts: number) =>
  Duration.min(Duration.times(RESTART_BASE, 2 ** restarts), RESTART_CAP)

/** Carries a deterministic defect out of the turn span, so the span records it as failed. */
class TurnDefect extends Schema.TaggedError<TurnDefect>()("DeterministicDefect", {
  defect: Schema.Defect(),
  message: Schema.String,
}) {}

/** The `outcome` attribute of `durable-actors.turns` and of the turn span. */
const outcomeOf = (outcome: Outcome, replayed = false) =>
  replayed
    ? "replay"
    : Outcome.match(outcome, {
        Success: () => "success",
        Failure: () => "failure",
        Defect: () => "defect",
        Acknowledged: () => "acknowledged",
      })

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

// Rebuilds of each entity scope's handler since its last settled turn; absent
// until the first build, so only a rebuild waits.
const restarts = new WeakMap<Scope.Scope, number>()

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
  authorize: Authorize,
  gate: TurnGate,
  /** Fails while this runtime may not start turns, e.g. its payload writer rows are stale. */
  writable: Effect.Effect<void, ActorError>,
) {
  const sharding = yield* Sharding.Sharding

  const defects = yield* DefectLog
  const typeAttributes = { actor_type: registration.name }
  const activations = Metric.withAttributes(Metrics.activations, typeAttributes)

  const owner = activationOwner({
    registration,
    transport,
    authorize,
    clock: yield* FrameworkClock,
    role: (yield* TenantScope).role,
  })

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

      // Cluster's own restart backoff is shared by every entity of the type
      // and never resets, so the wait is kept per activation here instead.
      const rebuilt = restarts.get(activation)

      restarts.set(activation, rebuilt === undefined ? 0 : rebuilt + 1)

      if (rebuilt !== undefined) yield* Effect.sleep(restartDelay(rebuilt))

      const { entityId } = yield* Entity.CurrentAddress
      const [tenant, id] = yield* decodeEntityId(entityId).pipe(Effect.orDie)

      const superseded = handlerScopes.get(activation)

      if (superseded !== undefined) yield* Scope.close(superseded, Exit.void)

      const shard =
        lease === undefined
          ? undefined
          : ShardId.toString(yield* entity.getShardId(ClusterEntityId.make(entityId)))

      // A singleton starts only on the runner holding its shard's lease, and
      // its background work stops as soon as the lease lapses.
      if (lease !== undefined && !(yield* lease.holds(shard!))) return yield* leaseLost

      // What one activation holds: its resources' scope, its connection
      // state, its handlers, and its workflow engine. A retryable turn
      // failure ends it and starts the next in place, as a restart would.
      interface Current {
        readonly scope: Scope.Closeable
        readonly owned: Effect.Success<ReturnType<typeof ownedOf>>
        readonly activated: Exit.Exit<Effect.Success<ReturnType<Registration["activate"]>>, unknown>
        engine: Effect.Success<ReturnType<typeof activationEngine>> | undefined
      }

      let lost = false

      // The handler's own scope holds its residency and every activation it
      // starts, so the actor stays resident while an activation restarts.
      const handler = yield* Scope.fork(activation)

      handlerScopes.set(activation, handler)

      yield* Effect.acquireRelease(
        Effect.sync(() => resident.set(entityId, (resident.get(entityId) ?? 0) + 1)).pipe(
          Effect.andThen(count(Metrics.activationsStarted, typeAttributes, 1)),
          Effect.andThen(Metric.modify(activations, 1)),
        ),
        () =>
          Effect.sync(() => {
            const left = resident.get(entityId)! - 1

            if (left === 0) resident.delete(entityId)
            else resident.set(entityId, left)
          }).pipe(Effect.andThen(Metric.modify(activations, -1))),
      ).pipe(Scope.provide(handler))

      const start = Effect.gen(function* () {
        const scope = yield* Scope.fork(handler)

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

        // Entered in the activation's own scope, so ending the activation
        // seals its broadcasts and, unless its connection entity still holds
        // it, drops its cached state and generation.
        const owned = yield* ownedOf(entityId).pipe(Scope.provide(scope))

        // A singleton builds here, on its owner; a failing build answers every
        // command with its defect instead of retrying the activation forever.
        const activated = yield* registration
          .activate(ActorRef.make({ tenant, actor: registration.name, id }))
          .pipe(Scope.provide(scope), Effect.exit)

        if (Exit.isFailure(activated))
          yield* Effect.logError("Actor activation failed", activated.cause).pipe(
            Effect.annotateLogs({ actor: registration.name, id, tenant }),
          )

        const started: Current = { scope, owned, activated, engine: undefined }

        return started
      })

      const built = yield* Effect.context<never>()
      let current = yield* start

      yield* Effect.addFinalizer(() => Scope.close(handler, Exit.void))

      // Ends the activation after a retryable turn failure and starts the
      // next one after the activation's backoff, without Cluster's restart.
      // While `ended` is set the handler has no live activation, so a failed
      // start leaves it refusing commands until Cluster rebuilds it.
      let ended = false

      const restartIncomplete = Effect.die(
        RetryTurn.make({ message: "Activation restart did not complete" }),
      )

      // Uninterruptible, so a caller giving up cannot leave the handler
      // holding an activation whose scope is closed. Concurrency 1 runs one
      // command at a time, so no two restarts overlap.
      const restart = Effect.gen(function* () {
        const failures = restarts.get(activation) ?? 0

        restarts.set(activation, failures + 1)
        ended = true
        yield* Scope.close(current.scope, Exit.void)
        yield* Effect.sleep(restartDelay(failures))

        if (lease !== undefined && !(yield* lease.holds(shard!))) {
          lost = true

          return
        }

        current = yield* start.pipe(Effect.provideContext(built))
        ended = false
      }).pipe(Effect.uninterruptible)

      return entity.of({
        Wake: () =>
          Effect.suspend(() => {
            if (lost) return leaseLost

            return ended ? restartIncomplete : Effect.void
          }),
        Execute: Effect.fnUntraced(
          function* ({ payload }) {
            if (lost) return yield* leaseLost

            if (ended) return yield* restartIncomplete

            yield* writable

            const { owned, activated } = current

            if (Exit.isFailure(activated))
              return Outcome.cases.Defect.make({ cause: Cause.squash(activated.cause) })

            const command =
              activated.value.get(payload.command) ?? workflowRoutes.get(payload.command)

            if (command === undefined)
              return yield* Effect.die(new Error(`Unregistered command ${payload.command}`))

            const started = yield* Clock.currentTimeMillis
            let label: string | undefined

            if (payload.queuedAtMs !== undefined)
              yield* record(
                Metrics.mailboxAge,
                typeAttributes,
                Math.max(0, started - payload.queuedAtMs),
              )

            const outcome = yield* Effect.gen(function* () {
              yield* owner.prepare(owned)

              const done = yield* executeTurn(
                payload,
                command,
                owned.cache,
                owned.key,
                registration.policy,
                registration.mintable,
                parentPlacement(registration.placement)?.parent,
                registration.tables.length > 0 || registration.blobs.length > 0,
                waited,
                owner.hasConnections ? owner.list(owned) : undefined,
                registration.cron,
              )

              label = outcomeOf(done.outcome, done.replayed)
              yield* Effect.annotateCurrentSpan({
                "actor.generation": done.generation,
                "turn.replayed": done.replayed,
                "turn.outcome": label,
              })
              yield* count(Metrics.receiptsReplayed, typeAttributes, done.replayed ? 1 : 0)
              yield* count(Metrics.receiptsWritten, typeAttributes, done.written.receipts)
              yield* count(Metrics.eventsAppended, typeAttributes, done.written.events)
              yield* count(Metrics.outboxStaged, { kind: "intent" }, done.written.intents)
              yield* count(Metrics.outboxStaged, { kind: "effect" }, done.written.effects)

              // A route turn's command id is its effect id: its progress stops before the route's broadcasts.
              if (owner.hasProgress && !Outcome.guards.Defect(done.outcome)) {
                yield* owner.closeProgress(owned, payload.commandId)

                // A turn that cancelled a running effect stops its progress before its own broadcasts.
                for (const effectId of done.cancelledEffects)
                  yield* owner.closeProgress(owned, effectId)
              }

              // Stream followers wake when a commit advances the activation's head.
              if (owner.hasConnections || owner.hasStreams) {
                yield* (yield* TurnHooks).at("beforeFlush", payload)
                yield* owner.flush(
                  owned,
                  [...done.broadcasts, ...(yield* owner.feedBroadcasts(done.committed))],
                  done.head,
                )
              }

              return done.outcome
            }).pipe(
              Effect.catchDefect(
                Effect.fnUntraced(function* (cause) {
                  // A retryable failure committed nothing, so the activation
                  // restarts and the caller retries the same command id.
                  // Answering the caller here, instead of dying so Cluster
                  // restarts the entity and re-sends the command, keeps it
                  // from waiting out its delivery timeout: Cluster drops a
                  // re-sent command whose turn fails again mid-restart, as a
                  // refused connection does during a database failover.
                  if (
                    Schema.is(RetryTurn)(cause) ||
                    (SqlError.isSqlError(cause) && cause.isRetryable)
                  ) {
                    label = "retried"
                    yield* restart

                    return yield* ActorError.make({ reason: ActorUnavailable.make({ cause }) })
                  }

                  // Deterministic defects run no user code, because a defect hook
                  // can loop on corrupt state; the turn span, the defect log, and
                  // this log carry the cause for operators.
                  yield* Effect.logError("Deterministic actor defect", Cause.die(cause))

                  const span = yield* Effect.currentSpan.pipe(Effect.option)

                  yield* defects.record({
                    span: SpanNames.turn(payload.ref.actor, payload.command),
                    traceId: Option.isSome(span) ? span.value.traceId : "",
                    spanId: Option.isSome(span) ? span.value.spanId : "",
                    atMs: yield* Clock.currentTimeMillis,
                    tenant: payload.ref.tenant,
                    actorType: payload.ref.actor,
                    actorId: payload.ref.id,
                    command: payload.command,
                    commandId: payload.commandId,
                    trigger: triggerOf(payload),
                    cause: Cause.pretty(Cause.die(cause)),
                  })
                  label = "defect"
                  yield* Effect.annotateCurrentSpan({ "turn.outcome": label })

                  // Failing inside the span marks it as a defect for the exporter.
                  return yield* TurnDefect.make({
                    defect: cause,
                    message: cause instanceof Error ? cause.message : String(cause),
                  })
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
                SpanNames.turn(payload.ref.actor, payload.command),
                { kind: "server", attributes: requestAttributes(payload) },
                { captureStackTrace: false },
              ),
              Effect.catchIf(Schema.is(TurnDefect), (defect) =>
                Effect.succeed(Outcome.cases.Defect.make({ cause: defect.defect })),
              ),
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  yield* count(
                    Metrics.turns,
                    {
                      ...typeAttributes,
                      // A declared ActorError rejects the command; a retryable death reruns it.
                      outcome:
                        label ??
                        (Exit.isSuccess(exit)
                          ? outcomeOf(exit.value)
                          : Cause.hasFails(exit.cause)
                            ? "rejected"
                            : "retried"),
                    },
                    1,
                  )
                  yield* record(
                    Metrics.turnDuration,
                    typeAttributes,
                    (yield* Clock.currentTimeMillis) - started,
                  )
                }),
              ),
            )

            // The turn settled, so the next retryable death waits the base delay again.
            restarts.set(activation, 0)

            const hooks = yield* TurnHooks

            if (!Outcome.guards.Defect(outcome)) yield* hooks.at("afterCommit", payload)

            if (workflowRoutes.has(payload.command)) {
              const kicked = yield* kickedExecution({ request: payload, outcome })

              if (kicked !== undefined) {
                current.engine ??= yield* activationEngine({
                  registration,
                  ref: payload.ref,
                  routingKey: routingKeyOf(payload.ref),
                  cache: owned.cache,
                  scope: current.scope,
                  deliveryMs: registration.policy.deliveryMs,
                })
                yield* current.engine.kick(kicked.executionId, kicked.interrupt)
              }
            }

            return outcome
          },
          Effect.provideContext(services),
          gate.run,
        ),
      })
    }),
    {
      concurrency: 1,
      maxIdleTime: registration.policy.idleMs,
      mailboxCapacity: registration.policy.mailboxCapacity,
      // The handler build waits each activation's own backoff; Cluster's
      // shared one would slow every later restart of the type to its cap.
      defectRetryPolicy: Schedule.forever,
    },
  )

  const connections = connectionEntity(registration.name)
  const connectionServices = yield* Effect.context<SqlClient.SqlClient>()

  yield* register

  if (owner.hasConnections || owner.hasStreams)
    yield* sharding.registerEntity(
      connections,
      Effect.gen(function* () {
        const { entityId } = yield* Entity.CurrentAddress
        const owned = yield* ownedOf(entityId)

        // A move, shutdown, or eviction ends the activation, and its streams with it.
        yield* Effect.addFinalizer(() => owner.endStreams(owned))

        return connections.of({
          Progress: ({ payload }) =>
            owner.progress(owned, payload).pipe(Effect.provideContext(connectionServices)),
          ProgressClosed: ({ payload }) =>
            owner.progressClosed(owned, payload).pipe(Effect.provideContext(connectionServices)),
          Subscribe: ({ payload }) =>
            owner.subscribe(owned, payload).pipe(Stream.provideContext(connectionServices)),
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

  if (owner.hasStreams) yield* owner.watchStreams.pipe(Effect.forkScoped)

  // Every runner serves the singleton's entity, so its shard lock and the
  // generation fence keep each tenant's instance to one activation. One
  // keeper, on whichever runner Cluster runs it, keeps the default tenant's
  // instance resident and so moves it, and its background loop, to a survivor.
  if (registration.singleton) {
    const ref = ActorRef.make({
      tenant: registration.tenant,
      actor: registration.name,
      id: "singleton",
    })

    yield* bootstrapTicks(routingKeyOf(ref), ref, registration.cron).pipe(
      Effect.provideContext(services),
      Effect.orDie,
    )
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
