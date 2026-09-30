import {
  Cause,
  Clock,
  Context,
  type Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Latch,
  Metric,
  Option,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream,
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
import { ActorError, ActorUnavailable } from "../../errors/actor.ts"
import { Executed, Outcome, Request } from "../request.ts"
import { type RegisteredCommand, type Registration } from "../members.ts"
import { ActorRef } from "../../identity/caller.ts"
import { bootstrapTicks } from "../cron/schedule.ts"
import { parentPlacement, routingKey } from "../storage/codec.ts"
import { ShardLease } from "../topology/locks.ts"
import { takeBatch } from "./mailbox.ts"
import { type Done, executeBatches, type Stopped } from "../turn/execute.ts"
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

/**
 * Commands are direct: the Cluster message is volatile and the receipt
 * committed inside the turn is the only durable admission record.
 * A lost runner loses only uncommitted work, which the caller retries by id.
 * `Wake` builds the activation without running a turn.
 */
const makeCommandEntity = (name: string) =>
  Entity.make(name, [
    Rpc.make("Execute", { payload: Request, success: Executed, error: ActorError }),
    Rpc.make("Wake"),
  ]).annotateRpcs(ClusterSchema.Uninterruptible, true)

/**
 * Cluster entity ids name the tenant and actor id together.
 */
const EntityId = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))

const encodeEntityIdOf = Schema.encodeEffect(EntityId)

/**
 * A retryable turn failure, and a handler rebuilt after a death, wait
 * `RESTART_BASE × 2^n`, capped at `RESTART_CAP`, where `n` counts the
 * activation's failures and rebuilds since its last settled turn: prompt after
 * a one-off failure, bounded for an actor whose turn fails on every attempt.
 */
const RESTART_BASE = Duration.millis(50)

const RESTART_CAP = Duration.seconds(5)

const restartDelay = (restarts: number) =>
  Duration.min(Duration.times(RESTART_BASE, 2 ** restarts), RESTART_CAP)

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

/** Encodes a tenant and actor id as the Cluster entity id. */
export const encodeEntityId = (tenantAndId: readonly [string, string]) =>
  encodeEntityIdOf(tenantAndId)

const decodeEntityId = Schema.decodeEffect(EntityId)

/**
 * How often a singleton's keeper re-wakes the default tenant's instance, and
 * so bounds how long after its shard moves the instance is resident again.
 */
const SINGLETON_WAKE_INTERVAL = Duration.seconds(1)

/**
 * Cluster's lifetime of one entity, shared by every handler a defect restart
 * rebuilds within it.
 */
const entityScope = () =>
  Effect.serviceOption(
    Context.Service<Scope.Scope>("effect/cluster/internal/CurrentActivationScope"),
  )

/**
 * The current handler's scope within each entity scope.
 */
const handlerScopes = new WeakMap<Scope.Scope, Scope.Closeable>()

/**
 * Rebuilds of each entity scope's handler since its last settled turn; absent
 * until the first build, so only a rebuild waits.
 */
const restarts = new WeakMap<Scope.Scope, number>()

/**
 * Per entity scope, the command ids of a batch a retryable defect aborted;
 * they outlive the handler the defect rebuilt, so each runs alone once.
 */
const aloneAfterFailure = new WeakMap<Scope.Scope, Set<string>>()

/** A command in an activation's mailbox and the caller waiting on its reply. */
interface Waiting {
  readonly request: Request
  /** Resolved against the activation that runs the command, as the worker takes it. */
  command: RegisteredCommand
  readonly reply: Deferred.Deferred<Executed, ActorError>
  /**
   * The request's own context, under the runtime's services, as the turn ran
   * in before batching: its span is the turn span's parent.
   */
  context: Context.Context<never>
  /** Set once the request's `queued` hook has finished. */
  queued: boolean
}

/**
 * Defects that say nothing about the command: the activation restarts and
 * the caller retries the same id.
 */
const retryable = (cause: Cause.Cause<unknown>) => {
  const defect = Cause.squash(cause)

  return Schema.is(RetryTurn)(defect) || (SqlError.isSqlError(defect) && defect.isRetryable)
}

const commandEntities = new Map<string, ReturnType<typeof makeCommandEntity>>()

/**
 * Sharding keeps one RPC client per entity object, by identity, until the
 * runtime closes; a fresh entity per command would retain a client per command.
 */
/** The command entity definition for an actor type, created once per name. */
export const commandEntity = (name: string) => {
  const cached = commandEntities.get(name)

  if (cached !== undefined) return cached

  const entity = makeCommandEntity(name)
  commandEntities.set(name, entity)

  return entity
}

const connectionEntities = new Map<string, ReturnType<typeof connectionsEntity>>()

/** The connection entity definition for an actor type, created once per name. */
export const connectionEntity = (name: string) => {
  const cached = connectionEntities.get(name)

  if (cached !== undefined) return cached

  const entity = connectionsEntity(name)
  connectionEntities.set(name, entity)

  return entity
}

/**
 * Registers an actor type's command entity with Cluster and starts its
 * activations, worker, and singleton keeper.
 *
 * - One worker per handler runs queued commands as turn batches in delivery
 *   order, so an activation has one transaction in flight. Commands enqueue
 *   synchronously when Cluster delivers the request, and replies follow the
 *   batch's commit; broadcasts go out first. With `pipelining`, the next batch
 *   already waiting is taken while the previous one commits.
 * - A retryable failure committed nothing. The worker ends the activation,
 *   waits its backoff, starts the next one in place, and only then answers each
 *   unanswered command `ActorUnavailable`, so a caller never retries into the
 *   closed activation and never waits out its delivery timeout when Cluster
 *   would drop a re-sent command mid-restart (as during a database failover).
 *   Restarts never overlap because the one worker serializes them.
 * - A defect aborts the whole batch; a following batch whose admission was
 *   already sent is rolled back unseen. After a deterministic defect the
 *   failed batch's commands rerun one per transaction so one bad command cannot
 *   keep rolling back its neighbours, and a lone command answers `Defect`.
 *   Defect hooks do not run, since they can loop on corrupt state. A defect
 *   after the batch committed lets redelivered commands replay their receipts.
 * - Restart backoff is kept per activation, because Cluster's own is shared by
 *   every entity of the type and never resets.
 * - Each handler's resources live in a child of the entity's scope, closed when
 *   a rebuild supersedes it, the handler closes, or the entity ends, because a
 *   defect during shutdown can drop the superseded handler's own scope.
 * - Full-mailbox and full-runner rejections share one Cluster error; only an
 *   activation already resident can have a full mailbox, and a rebuilt handler
 *   can overlap its predecessor, hence the count.
 * - A singleton starts only on the runner holding its shard's lease. Every
 *   runner serves its entity, and one keeper re-wakes the default tenant's
 *   instance so it moves to a survivor. A failing singleton build answers every
 *   command with its defect instead of retrying forever.
 * - A draining runner refuses a batch, or interrupts its run at the deadline,
 *   and every unanswered caller retries elsewhere.
 * - The turn span carries no captured stack: its call site is always this file.
 */
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
    Effect.Services<ReturnType<typeof executeBatches<Waiting, never, never, never>>> | Crypto.Crypto
  >()

  const entity = commandEntity(registration.name)

  const routingKeyOf = (ref: Request["ref"]) =>
    routingKey({ ref, placement: registration.placement })

  const workflowRoutes = workflowCommands({ registration, routingKeyOf, services })

  const waited = new Set(
    [...registration.workflows.values()].flatMap((workflow) =>
      [...workflow.member.registry.steps.values()].flatMap((step) =>
        step.event === undefined ? [] : [step.event],
      ),
    ),
  )

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
      const activation = yield* entityScope().pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(new Error("Cluster provided no entity scope")),
            onSome: Effect.succeed,
          }),
        ),
      )

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

      if (lease !== undefined && !(yield* lease.holds(shard!))) return yield* leaseLost

      interface Current {
        readonly scope: Scope.Closeable
        readonly owned: Effect.Success<ReturnType<typeof ownedOf>>
        readonly activated: Exit.Exit<Effect.Success<ReturnType<Registration["activate"]>>, unknown>
        engine: Effect.Success<ReturnType<typeof activationEngine>> | undefined
      }

      let lost = false

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

        const owned = yield* ownedOf(entityId).pipe(Scope.provide(scope))

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

      const policy = registration.policy
      const statements = registration.tables.length > 0 || registration.blobs.length > 0

      const waiting: Array<Waiting> = []
      const ready = Latch.makeUnsafe(false)
      const alone = aloneAfterFailure.get(activation) ?? new Set<string>()
      aloneAfterFailure.set(activation, alone)

      const settle = Effect.fnUntraced(function* (
        entry: Waiting,
        exit: Exit.Exit<Executed, ActorError>,
      ) {
        const { request } = entry

        if (Exit.isSuccess(exit)) restarts.set(activation, 0)

        if (Exit.isSuccess(exit) && !Outcome.guards.Defect(exit.value.outcome)) {
          yield* (yield* TurnHooks).at("afterCommit", request)

          if (workflowRoutes.has(request.command)) {
            const kicked = yield* kickedExecution({ request, outcome: exit.value.outcome })

            if (kicked !== undefined) {
              current.engine ??= yield* activationEngine({
                registration,
                ref: request.ref,
                routingKey: routingKeyOf(request.ref),
                cache: current.owned.cache,
                scope: current.scope,
                deliveryMs: policy.deliveryMs,
              })
              yield* current.engine.kick(kicked.executionId, kicked.interrupt)
            }
          }
        }

        yield* Deferred.done(entry.reply, exit)
      })

      let ended = false

      const restartIncomplete = Effect.die(
        RetryTurn.make({ message: "Activation restart did not complete" }),
      )

      const restart = (batch: ReadonlyArray<Waiting>, cause: Cause.Cause<unknown>) =>
        Effect.sync(() => {
          ended = true
        }).pipe(
          Effect.andThen(
            Effect.forEach(
              batch,
              (entry) => Deferred.failCause(entry.reply, Cause.die(Cause.squash(cause))),
              { discard: true },
            ),
          ),
          Effect.andThen(Effect.interrupt),
        )

      const restartActivation = (
        batch: ReadonlyArray<Waiting>,
        orphan: ReadonlyArray<Waiting>,
        cause: Cause.Cause<unknown>,
      ) =>
        Effect.gen(function* () {
          const failures = restarts.get(activation) ?? 0

          restarts.set(activation, failures + 1)
          yield* Scope.close(current.scope, Exit.void)
          yield* Effect.sleep(restartDelay(failures))

          if (lease !== undefined && !(yield* lease.holds(shard!))) {
            lost = true

            return yield* Effect.die(leaseLostDefect)
          }

          current = yield* start.pipe(Effect.provideContext(built))

          if (orphan.length > 0) {
            waiting.unshift(...orphan)
            ready.openUnsafe()
          }

          const unavailable = ActorError.make({
            reason: ActorUnavailable.make({ cause: Cause.squash(cause) }),
          })

          yield* Effect.forEach(batch, (entry) => Deferred.fail(entry.reply, unavailable), {
            discard: true,
          })
        }).pipe(
          Effect.uninterruptible,
          Effect.catchCause((failed) => restart([...batch, ...orphan], failed)),
        )

      const resolve = (batch: Array<Waiting>) => {
        const { activated } = current

        if (Exit.isSuccess(activated))
          for (const entry of batch)
            entry.command =
              activated.value.get(entry.request.command) ??
              workflowRoutes.get(entry.request.command) ??
              entry.command

        return batch
      }

      let taken: Array<Waiting> = []

      const following = Effect.gen(function* () {
        if (
          lost ||
          !gate.open ||
          Exit.isFailure(current.activated) ||
          Exit.isFailure(yield* Effect.exit(writable))
        )
          return undefined

        const batch = resolve(takeBatch({ waiting, alone }))

        if (waiting[0]?.queued !== true) ready.closeUnsafe()

        taken.push(...batch)

        return batch.length > 0 ? batch : undefined
      })

      const labelled = new WeakMap<ReadonlyArray<Waiting>, ReadonlyArray<string>>()

      const committed = Effect.fnUntraced(function* (batch: ReadonlyArray<Waiting>, done: Done) {
        const { owned } = current

        const labels = done.settled.map((settled, index) =>
          Result.isSuccess(settled)
            ? outcomeOf(settled.success, done.replays.has(index))
            : "rejected",
        )

        labelled.set(batch, labels)
        yield* Effect.annotateCurrentSpan({ "actor.generation": done.generation })

        if (batch.length === 1 && Result.isSuccess(done.settled[0]!))
          yield* Effect.annotateCurrentSpan({
            "turn.replayed": done.replays.has(0),
            "turn.outcome": labels[0]!,
          })

        yield* count(Metrics.receiptsReplayed, typeAttributes, done.replays.size)
        yield* count(Metrics.receiptsWritten, typeAttributes, done.written.receipts)
        yield* count(Metrics.eventsAppended, typeAttributes, done.written.events)
        yield* count(Metrics.outboxStaged, { kind: "intent" }, done.written.intents)
        yield* count(Metrics.outboxStaged, { kind: "effect" }, done.written.effects)

        if (owner.hasProgress) {
          for (const [index, settled] of done.settled.entries())
            if (Result.isSuccess(settled) && !Outcome.guards.Defect(settled.success))
              yield* owner.closeProgress(owned, batch[index]!.request.commandId)

          for (const effectId of done.cancelledEffects) yield* owner.closeProgress(owned, effectId)
        }

        if (owner.hasConnections || owner.hasStreams) {
          for (const { request } of batch) yield* (yield* TurnHooks).at("beforeFlush", request)

          const feeds = yield* Effect.forEach(done.committed, owner.feedBroadcasts)
          const watches = yield* owner.watchBroadcasts(owned, done.wrote, done.version)

          yield* owner.flush(owned, [...done.broadcasts, ...feeds.flat(), ...watches], done.head)
        }

        for (const [index, settled] of done.settled.entries())
          yield* settle(
            batch[index]!,
            Result.isSuccess(settled)
              ? Exit.succeed<Executed>({ outcome: settled.success, version: done.version })
              : Exit.fail(settled.failure),
          )
      })

      const observe =
        (batch: ReadonlyArray<Waiting>) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) => {
          const { request } = batch[0]!
          const { ref } = request
          const lone = batch.length === 1

          return Effect.flatMap(Clock.currentTimeMillis, (started) =>
            Effect.forEach(
              batch,
              ({ request: queued }) =>
                queued.queuedAtMs === undefined
                  ? Effect.void
                  : record(
                      Metrics.mailboxAge,
                      typeAttributes,
                      Math.max(0, started - queued.queuedAtMs),
                    ),
              { discard: true },
            ).pipe(
              Effect.andThen(effect),
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  const labels = labelled.get(batch)
                  const elapsed = (yield* Clock.currentTimeMillis) - started

                  if (labels === undefined && Exit.isFailure(exit)) {
                    if (Cause.hasInterruptsOnly(exit.cause)) return

                    if (!retryable(exit.cause) && !lone) return

                    const deterministic = !retryable(exit.cause)

                    if (deterministic) {
                      const span = yield* Effect.currentSpan.pipe(Effect.option)

                      yield* defects.record({
                        span: SpanNames.turn(ref.actor, request.command),
                        traceId: Option.isSome(span) ? span.value.traceId : "",
                        spanId: Option.isSome(span) ? span.value.spanId : "",
                        atMs: yield* Clock.currentTimeMillis,
                        tenant: ref.tenant,
                        actorType: ref.actor,
                        actorId: ref.id,
                        command: request.command,
                        commandId: request.commandId,
                        trigger: triggerOf(request),
                        cause: Cause.pretty(Cause.die(Cause.squash(exit.cause))),
                      })
                      yield* Effect.annotateCurrentSpan({ "turn.outcome": "defect" })
                    }

                    yield* count(
                      Metrics.turns,
                      { ...typeAttributes, outcome: deterministic ? "defect" : "retried" },
                      batch.length,
                    )
                    yield* record(Metrics.turnDuration, typeAttributes, elapsed)

                    return
                  }

                  for (const label of labels ?? [])
                    yield* count(Metrics.turns, { ...typeAttributes, outcome: label }, 1)

                  yield* record(Metrics.turnDuration, typeAttributes, elapsed)
                }),
              ),
              Effect.annotateLogs(
                lone
                  ? {
                      actor: ref.actor,
                      id: ref.id,
                      tenant: ref.tenant,
                      command: request.command,
                      commandId: request.commandId,
                    }
                  : { actor: ref.actor, id: ref.id, tenant: ref.tenant },
              ),
              Effect.withSpan(
                lone ? SpanNames.turn(ref.actor, request.command) : SpanNames.batch(ref.actor),
                {
                  kind: lone ? "server" : "internal",
                  attributes: lone
                    ? requestAttributes(request)
                    : {
                        "actor.tenant": ref.tenant,
                        "actor.id": ref.id,
                        "batch.size": batch.length,
                      },
                  parent: lone
                    ? Context.getOrUndefined(batch[0]!.context, Tracer.ParentSpan)
                    : undefined,
                  links: lone
                    ? []
                    : batch.flatMap(({ context }) => {
                        const span = Context.getOrUndefined(context, Tracer.ParentSpan)

                        return span === undefined ? [] : [{ span, attributes: {} }]
                      }),
                },
                { captureStackTrace: false },
              ),
            ),
          )
        }

      const run = (batch: ReadonlyArray<Waiting>, pipelining: boolean) => {
        const { owned } = current

        return executeBatches(
          {
            first: batch,
            next: pipelining ? following : Effect.undefined,
            prepare: owner.prepare(owned),
            committed,
            observe,
          },
          owned.cache,
          owned.key,
          policy,
          registration.mintable,
          parentPlacement(registration.placement)?.parent,
          statements,
          waited,
          owner.hasConnections ? owner.list(owned) : undefined,
          registration.cron,
        )
      }

      const recover: (
        stopped: Stopped<Waiting>,
      ) => Effect.Effect<void, SqlError.SqlError, Entity.CurrentAddress | Sharding.Sharding> =
        Effect.fnUntraced(function* ({ batch, orphan, cause, committed }) {
          if (committed || retryable(cause)) {
            if (!committed && batch.length > 1)
              for (const { request } of batch) alone.add(request.commandId)

            if (committed || lost) return yield* restart([...batch, ...(orphan ?? [])], cause)

            return yield* restartActivation(batch, orphan ?? [], cause)
          }

          if (orphan !== undefined) {
            waiting.unshift(...orphan)
            ready.openUnsafe()
          }

          if (batch.length === 1) {
            const { request } = batch[0]!
            const defect = Cause.squash(cause)

            yield* Effect.logError("Deterministic actor defect", Cause.die(defect)).pipe(
              Effect.annotateLogs({
                actor: request.ref.actor,
                id: request.ref.id,
                tenant: request.ref.tenant,
                command: request.command,
                commandId: request.commandId,
              }),
            )

            return yield* settle(
              batch[0]!,
              Exit.succeed<Executed>({ outcome: Outcome.cases.Defect.make({ cause: defect }) }),
            )
          }

          yield* Effect.logDebug("Turn batch failed; running its commands one at a time", cause)

          for (const entry of batch) {
            const stopped = yield* run(resolve([entry]), false)

            if (stopped !== undefined) yield* recover(stopped)
          }
        }, Effect.provideContext(services))

      yield* Effect.gen(function* () {
        while (true) {
          yield* ready.await
          const batch = resolve(takeBatch({ waiting, alone }))

          if (waiting[0]?.queued !== true) ready.closeUnsafe()

          if (batch.length === 0) continue

          taken = [...batch]

          if (Exit.isFailure(current.activated)) {
            const { cause } = current.activated

            yield* Effect.forEach(
              batch,
              (entry) =>
                Deferred.succeed(entry.reply, {
                  outcome: Outcome.cases.Defect.make({ cause: Cause.squash(cause) }),
                }),
              { discard: true },
            )

            continue
          }

          yield* gate
            .run(
              Effect.gen(function* () {
                if (lost) return yield* restart(batch, Cause.die(leaseLostDefect))

                yield* writable

                const stopped = yield* run(batch, true)

                if (stopped !== undefined) yield* recover(stopped)
              }),
            )
            .pipe(
              Effect.catchIf(Schema.is(ActorError), (error) =>
                Effect.forEach(taken, (entry) => Deferred.fail(entry.reply, error), {
                  discard: true,
                }),
              ),
              Effect.provideContext(Context.merge(batch[0]!.context, services)),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => restart(batch, cause),
              ),
            )
        }
      }).pipe(Effect.provideContext(services), Effect.forkIn(handler))

      return entity.of({
        Wake: () =>
          Effect.suspend(() => {
            if (lost) return leaseLost

            return ended ? restartIncomplete : Effect.void
          }),
        Execute: ({ payload }) => {
          if (lost) return leaseLost

          if (ended) return restartIncomplete

          const { activated } = current

          if (Exit.isFailure(activated))
            return Effect.succeed<Executed>({
              outcome: Outcome.cases.Defect.make({ cause: Cause.squash(activated.cause) }),
            })

          const command =
            activated.value.get(payload.command) ?? workflowRoutes.get(payload.command)

          if (command === undefined)
            return Effect.die(new Error(`Unregistered command ${payload.command}`))

          const entry: Waiting = {
            request: payload,
            command,
            reply: Deferred.makeUnsafe<Executed, ActorError>(),
            context: Context.empty(),
            queued: false,
          }

          waiting.push(entry)

          return Rpc.fork(
            Effect.gen(function* () {
              entry.context = yield* Effect.context<never>()

              yield* (yield* TurnHooks).at("queued", payload).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    entry.queued = true
                    ready.openUnsafe()
                  }),
                ),
              )

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
