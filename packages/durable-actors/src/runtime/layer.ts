import { PgClient, PgTypes } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  Schedule,
  Schema,
  Stream,
} from "effect"
import {
  ClusterError,
  EntityId,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  SqlRunnerStorage,
} from "effect/unstable/cluster"
import { SqlClient, SqlError } from "effect/unstable/sql"
import {
  ActorError,
  ActorUnavailable,
  NotCreated,
  Unauthorized,
  Timeout,
  MailboxFull,
  RunnerAtCapacity,
  SessionEnded,
} from "../errors/actor.ts"
import {
  Actors,
  type EffectRegistration,
  InternalActors,
  Outcome,
  type QueryRegistration,
  type Registration,
  type WorkflowStatus,
  type Request,
} from "../handles/actors.ts"
import { type ActorRef, type Caller, System } from "../identity/caller.ts"
import { deriveMintId } from "../identity/mint.ts"
import { migrate } from "./database/migrations.ts"
import { retryDelay } from "./retry.ts"
import { withoutDatabase } from "./effects/isolation.ts"
import { pglite } from "./database/pglite.ts"
import {
  commandEntity,
  connectionEntity,
  encodeEntityId,
  registerActor,
} from "./entity/register.ts"
import { type Holder, type HeldActorType, connectionHolder } from "./connections/holder.ts"
import { holderShardGroups, holderTransport, type Transport } from "./connections/transport.ts"
import { StreamFailed, StreamItem } from "./connections/protocol.ts"
import { type ProgressMessage, ProgressSink, ProgressTap } from "./effects/progress.ts"
import type { Owner } from "./connections/owner.ts"
import { FEED_MEMBER } from "./connections/protocol.ts"
import { replayEvents } from "./events/replay.ts"
import { checkIdentity, databaseTime, FrameworkClock, readAdmission } from "./turn/admission.ts"
import { decompress, PLACEMENT_ENCODING, routingKey } from "./storage/codec.ts"
import { CleanupHooks, TurnHooks } from "./turn/hooks.ts"
import { OutboxRuntime, textArray } from "./turn/outbox.ts"
import { turnConnections } from "./turn/pipeline.ts"
import { outboxRelay } from "./turn/relay.ts"
import {
  type LocalSubscription,
  type SubscriptionRelay,
  subscriptionRelay,
} from "./subscriptions/relay.ts"
import type { Placement } from "./storage/codec.ts"
import { sweep } from "./storage/retention.ts"
import { acceptWorkflows, formatIncompatibility } from "./workflows/compatibility.ts"
import { decodeResult, RECOVERY_MS } from "./workflows/engine.ts"
import { INTERRUPT, RESUME, Target } from "../handles/workflow.ts"
import { decodeExecutionId } from "../identity/execution.ts"
import { keepAcquiredShards, ShardLease, tableShardLease } from "./topology/locks.ts"
import { directMessages } from "./topology/messages.ts"
import { bindBlobs } from "./turn/blobs.ts"
import { bindTables, checkTables, rowsDatabase } from "./turn/rows.ts"
import type { AnyOwnedTable } from "../tables/owned.ts"
import { checkReceipt } from "./turn/receipt.ts"
import { type Readiness, RuntimeControl, runtimeControl, turnGate } from "./drain.ts"

export interface Options {
  readonly authorize: (request: {
    readonly caller: Caller
    readonly ref: ActorRef
    readonly command: string
    /**
     * What is being authorized: `command` for commands and reducers, `query`
     * for queries, `open` for a connection, `feed` for an event feed (with
     * `command` set to the event tag), and `reauthorize` for a live session's
     * periodic check; hooks should deny kinds they do not know.
     */
    readonly kind: "command" | "query" | "open" | "stream" | "feed" | "reauthorize"
    /** On `reauthorize`, what the session is: an `open` connection, a `stream`, or a `feed`. */
    readonly of?: "open" | "stream" | "feed"
  }) => Effect.Effect<boolean>
  readonly retryWindowMs?: number
  /**
   * Activations this runner keeps in memory at once. A command that needs a
   * new activation past the limit fails `RunnerAtCapacity` and is retried
   * until an idle actor hibernates or the delivery timeout passes. Default
   * 10,000, which bounds runner memory; raise it with the memory you give the
   * process.
   */
  readonly maxResidentActors?: number
  /** The outbox relay of this runner; every default equals the single-runner M1 behaviour. */
  readonly relay?: {
    /** Durable polling interval, jittered by ±10% per wait. Default 1 second. */
    readonly poll?: Duration.Input
    /** Intent rows one claim takes at most. Default 256. */
    readonly passLimit?: number
    /** Intents delivered at once. Default 16. */
    readonly deliveryConcurrency?: number
    /**
     * How long a claimed intent stays out of every runner's scans. Default:
     * the largest `commandTimeout + lockWait` of the registered actor types,
     * plus 5 seconds.
     */
    readonly claimLease?: Duration.Input
    /** Cap on intent and subscription redelivery backoff. Default 256 seconds. */
    readonly maxBackoff?: Duration.Input
    /**
     * Subscription deliveries in flight at once, separate from intent
     * slots; feed expansions and control registrations each get as many.
     * Default 16.
     */
    readonly subscriptionConcurrency?: number
    /** Matching events one claimed subscription row delivers before it settles. Default 16. */
    readonly subscriptionBatch?: number
  }
  /** The effect executor pool of this runner. */
  readonly executors?: {
    /** Effect attempts running at once. Default 64. */
    readonly concurrency?: number
    /** An attempt's claim, renewed every third of it; at least 3 seconds. Default 60 seconds. */
    readonly lease?: Duration.Input
    /**
     * How often a running attempt checks whether a turn on another runner
     * cancelled its effect; at least 1 second, at most a third of the lease.
     * Default a third of the lease. A cancellation committed on the attempt's
     * own runner reaches it at once.
     */
    readonly cancelCheck?: Duration.Input
  }
}

const Count = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))

const Millis = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))

const millis = (duration: Duration.Input) =>
  Millis.make(Math.floor(Duration.toMillis(Duration.fromInputUnsafe(duration))))

const decodeTarget = Schema.decodeEffect(Target)

/** Added to the longest turn a claimed intent's receiver may take. */
const CLAIM_MARGIN_MS = 5000

/** The claim lease when no actor type is registered: default policies' 30 s + 2 s + margin. */
const DEFAULT_CLAIM_LEASE_MS = 37_000

/**
 * How a runtime joins a cluster of runners instead of running as the embedded
 * single runner. Package-internal: `ActorTest.cluster` provides it to each of
 * its runners.
 */
export class RunnerWiring extends Context.Service<
  RunnerWiring,
  {
    readonly config: Partial<ShardingConfig.ShardingConfig["Service"]>
    /** Provides `Sharding` together with the runner-to-runner transport. */
    readonly sharding: Layer.Layer<
      Sharding.Sharding,
      never,
      | ShardingConfig.ShardingConfig
      | MessageStorage.MessageStorage
      | RunnerStorage.RunnerStorage
      | RunnerHealth.RunnerHealth
    >
    /** Wraps the SQL runner storage, e.g. to withhold heartbeats or a graceful release. */
    readonly storage: (
      storage: RunnerStorage.RunnerStorage["Service"],
    ) => RunnerStorage.RunnerStorage["Service"]
  }
>()("@durable-actors/core/runtime/layer/RunnerWiring") {}

/** How long registering a source waits for the subscriber types routing from it to register. */
const ROUTED_SUBSCRIBER_WAIT_MS = 5000

/** How often a subscriber checks that a stream's owner on another runner is alive. */
const OWNER_CHECK_INTERVAL = "1 second"

const activationEnded = () =>
  ActorError.make({ reason: SessionEnded.make({ cause: "ActivationEnded", resync: false }) })

/** How long a progress send may take before it is given up as a lost frame. */
const PROGRESS_SEND_TIMEOUT = "5 seconds"

/** Pause between retention sweeps. */
const CLEANUP_INTERVAL = "1 minute"

/** How long readiness waits for the database before it reports storage unavailable. */
const READINESS_STORAGE_TIMEOUT = "2 seconds"

export const layer = (options: Options) => {
  const retryWindowMs = Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 2_592_000_000 }),
  ).make(options.retryWindowMs ?? 86_400_000)

  const maxResidentActors = Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
  ).make(options.maxResidentActors ?? 10_000)

  const executorLeaseMs = millis(options.executors?.lease ?? "60 seconds")

  // Renewals every third of the lease stay at least a second apart.
  if (executorLeaseMs < 3000) throw new Error("executors.lease must be at least 3 seconds")

  const cancelCheckMs = Math.min(
    options.executors?.cancelCheck === undefined
      ? executorLeaseMs / 3
      : millis(options.executors.cancelCheck),
    executorLeaseMs / 3,
  )

  if (cancelCheckMs < 1000) throw new Error("executors.cancelCheck must be at least 1 second")

  const claimLeaseMs =
    options.relay?.claimLease === undefined ? undefined : millis(options.relay.claimLease)

  const relaySettings = {
    pollMs: millis(options.relay?.poll ?? "1 second"),
    passLimit: Count.make(options.relay?.passLimit ?? 256),
    deliveryConcurrency: Count.make(options.relay?.deliveryConcurrency ?? 16),
    maxBackoffMs: millis(options.relay?.maxBackoff ?? "256 seconds"),
    executorConcurrency: Count.make(options.executors?.concurrency ?? 64),
    executorLeaseMs,
    retryWindowMs,
    cancelCheckMs,
  }

  const subscriptionConcurrency = Count.make(options.relay?.subscriptionConcurrency ?? 16)
  const subscriptionBatch = Count.make(options.relay?.subscriptionBatch ?? 16)

  const runtime = Layer.effectContext(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const scope = yield* Effect.scope
      const sharding = yield* Sharding.Sharding
      const registrations = new Map<string, Registration>()
      const residency = new Map<string, (entityId: string) => boolean>()
      const owners = new Map<string, Owner>()
      // Actor types whose workflow rows retention sweeps, removed workflows included.
      const sweepsWorkflows = new Set<string>()
      const queryRegistrations = new Map<string, QueryRegistration>()
      const effectRegistrations = new Map<string, EffectRegistration>()

      const services = yield* Effect.context<
        SqlClient.SqlClient | Crypto.Crypto | Sharding.Sharding
      >()

      const database = yield* rowsDatabase
      // Turns run through the gate so a drain can refuse new ones and interrupt the rest.
      const gate = turnGate()

      // The holder and transport refer to each other: the transport delivers
      // to this runner's holder, which answers through the transport.
      let holder: Holder | undefined

      const transport: Transport = yield* holderTransport((message) =>
        Effect.suspend(() => holder!.deliver(message)),
      )

      const connectionCall = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.suspend(() => effect.pipe(Effect.forkIn(scope))).pipe(
          Effect.flatMap(Fiber.join),
          Effect.catchCause((cause) => {
            const failure = Cause.findErrorOption(cause)

            if (Option.isSome(failure) && Schema.is(ActorError)(failure.value))
              return Effect.fail(failure.value)

            return Effect.fail(
              ActorError.make({ reason: ActorUnavailable.make({ cause: Cause.squash(cause) }) }),
            )
          }),
        )

      const heldTypes = new Map<string, HeldActorType>()

      const shardLockMs = Duration.toMillis(
        Option.match(yield* Effect.serviceOption(ShardingConfig.ShardingConfig), {
          onNone: () => ShardingConfig.defaults.shardLockExpiration,
          onSome: (config) => config.shardLockExpiration,
        }),
      )

      const heldType = (registration: Registration): HeldActorType => {
        const entity = connectionEntity(registration.name)

        const client = (ref: ActorRef) =>
          Effect.gen(function* () {
            const make = yield* sharding.makeClient(entity)

            return make(yield* entityId(ref))
          })

        return {
          deliveryMs: registration.policy.deliveryMs,
          takeoverMs: shardLockMs + registration.policy.deliveryMs,
          reauthorizeMs: registration.policy.reauthorizeMs,
          retryWindowMs,
          placement: registration.placement,
          routingKey: (ref) => routingKey({ ref, placement: registration.placement }),
          // A feed's holder rereads its events after an owner loss, so it waits for the new owner's answer.
          hasResync: (member) =>
            member === FEED_MEMBER || (registration.connections.get(member)?.hasResync ?? false),
          hasMember: (member) =>
            member === FEED_MEMBER
              ? registration.feeds.size > 0
              : registration.connections.has(member),
          channel: {
            open: (request) =>
              connectionCall(Effect.flatMap(client(request.ref), (c) => c.Open(request))),
            frame: (request) =>
              connectionCall(Effect.flatMap(client(request.ref), (c) => c.Frame(request))),
            close: (request) =>
              connectionCall(Effect.flatMap(client(request.ref), (c) => c.Close(request))),
            resync: (request) =>
              connectionCall(Effect.flatMap(client(request.ref), (c) => c.Resync(request))),
          },
        }
      }

      holder = yield* connectionHolder({
        transport: () => transport,
        actorType: (name) => heldTypes.get(name),
        authorize: (request) => options.authorize(request),
      })

      // Tables that passed the startup check for an actor type of this runtime;
      // group reads may only touch these, never other Actor.table values.
      const checked = new Set<AnyOwnedTable>()

      // An interrupt is authorized as the workflow member its execution id names.
      const authorizedAs = (request: Request) =>
        request.command !== INTERRUPT
          ? Effect.succeed(request)
          : decodeTarget(request.payload).pipe(
              Effect.flatMap(({ executionId }) => decodeExecutionId(executionId)),
              Effect.map(({ workflow }) => ({ ...request, command: workflow })),
              Effect.orElseSucceed(() => request),
            )

      const allow = Effect.fnUntraced(function* (
        request: Request,
        kind: "command" | "query" | "stream" = "command",
      ) {
        if (!(yield* options.authorize({ ...(yield* authorizedAs(request)), kind })))
          return yield* ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })
      })

      const authorize = Effect.fnUntraced(function* (request: Request) {
        yield* allow(request, "command")
        yield* checkIdentity(request.commandId, retryWindowMs, yield* databaseTime)
      })

      // The first registration records an actor type's placement; a later one
      // that differs would read and write under different routing keys.
      const checkPlacement = Effect.fnUntraced(function* (
        registration: Pick<Registration, "name" | "placement">,
      ) {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO actor_placements (actor_type, placement, encoding)
          VALUES (${registration.name}, ${registration.placement}, ${PLACEMENT_ENCODING})
          ON CONFLICT DO NOTHING`

        const [recorded] = yield* sql<{ placement: string; encoding: number }>`
          SELECT placement, encoding FROM actor_placements WHERE actor_type = ${registration.name}`

        if (
          recorded?.placement !== registration.placement ||
          recorded.encoding !== PLACEMENT_ENCODING
        )
          return yield* Effect.die(
            new Error(
              `Actor ${registration.name} placement differs from the deployment; migrate explicitly`,
            ),
          )
      })

      const entityId = (ref: ActorRef) => encodeEntityId([ref.tenant, ref.id]).pipe(Effect.orDie)

      // Records this type's routed declarations for every runner of the
      // deployment, and drops the ones it no longer declares.
      const recordRouted = Effect.fnUntraced(function* (registration: Registration) {
        const sql = yield* SqlClient.SqlClient

        const routed = registration.subscriptions.filter(
          (declared) => declared.routed !== undefined,
        )

        for (const declared of routed)
          yield* sql`INSERT INTO actor_routed_subscriptions (source_type, subscriber_type, subscription)
            VALUES (${declared.sourceType}, ${registration.name}, ${declared.tag})
            ON CONFLICT DO NOTHING`

        yield* sql`DELETE FROM actor_routed_subscriptions
          WHERE subscriber_type = ${registration.name}
            AND NOT (source_type, subscription) IN (
              SELECT * FROM unnest(${textArray({ sql, values: routed.map((declared) => declared.sourceType) })},
                ${textArray({ sql, values: routed.map((declared) => declared.tag) })}))`
      })

      /**
       * A publishing turn creates a routed subscription's source-side rows
       * only from the routed declarations its runner registers, so a runner
       * that serves a source without a subscriber type routing from it would
       * lose those events silently. Registering the source fails instead.
       * Layers of one runtime register concurrently, so the subscriber gets
       * a short window to register first.
       */
      const requireRoutedSubscribers = Effect.fnUntraced(function* (sourceType: string) {
        const sql = yield* SqlClient.SqlClient

        const missing = Effect.map(
          sql<{ subscriber_type: string; subscription: string }>`
            SELECT subscriber_type, subscription FROM actor_routed_subscriptions
            WHERE source_type = ${sourceType}`,
          (rows) =>
            rows.filter(
              (row) =>
                row.subscriber_type !== sourceType && !registrations.has(row.subscriber_type),
            ),
        )

        for (let waited = 0; waited < ROUTED_SUBSCRIBER_WAIT_MS; waited += 100) {
          if ((yield* missing).length === 0) return
          yield* Effect.sleep("100 millis")
        }

        const unregistered = yield* missing

        if (unregistered.length > 0)
          return yield* Effect.die(
            new Error(
              `Actor ${sourceType} is registered without the subscriber types that route from it (${unregistered
                .map((row) => `${row.subscriber_type}.${row.subscription}`)
                .join(", ")}); register their layers on every runner that serves ${sourceType}`,
            ),
          )
      })

      const publicActors = Actors.of({
        mintCommandId: Effect.gen(function* () {
          const now = yield* databaseTime
          const uuid = yield* crypto.randomUUIDv4

          return `v1.${now}.${now + retryWindowMs}.${uuid}`
        }).pipe(Effect.provideContext(services), Effect.orDie),
      })

      // Intents are admitted by their sending turn, so internal delivery skips
      // the external access and expiry checks; revocation stops new commands,
      // not committed obligations.
      const dispatch = Effect.fnUntraced(
        function* (request: Request, external: boolean) {
          const registration = registrations.get(request.ref.actor)

          if (registration === undefined)
            return yield* ActorError.make({
              reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
            })

          // A draining runner admits no new external work; the caller retries on another runner.
          if (external && !gate.open)
            return yield* ActorError.make({
              reason: ActorUnavailable.make({ cause: new Error("Runner is draining") }),
            })

          const address = yield* entityId(request.ref)

          const isResident = () => residency.get(request.ref.actor)?.(address) === true
          let rejectedAtCapacity = false

          return yield* Effect.gen(function* () {
            // Only the relay presents a mint proof, as the delivery of the
            // parent's committed creating intent, and only the relay delivers
            // a subscription, with its envelope.
            if (
              external &&
              (request.delivery !== undefined ||
                (Schema.is(System)(request.caller) &&
                  (request.caller.mint !== undefined || request.caller.source === "subscription")))
            )
              return yield* ActorError.make({
                reason: Unauthorized.make({ code: "access_denied" }),
              })

            if (external) yield* allow(request, "command")

            // Postgres rejects some malformed ids and payloads outright; they
            // still fail as terminal identity errors, checked as before.
            const admission = yield* readAdmission(
              request,
              routingKey({ ref: request.ref, placement: registration.placement }),
            ).pipe(
              Effect.tapError(() =>
                external
                  ? Effect.flatMap(databaseTime, (now) =>
                      checkIdentity(request.commandId, retryWindowMs, now),
                    )
                  : Effect.void,
              ),
            )

            if (external) yield* checkIdentity(request.commandId, retryWindowMs, admission.now)

            // A replayed resume still reaches the owner, whose turn replays the
            // receipt and then wakes the execution the lost delivery would have.
            if (admission.receipt !== undefined && request.command !== RESUME) {
              const retained = yield* checkReceipt(request, admission.hash, admission.receipt)

              if (external) yield* authorize(request)

              return retained
            }

            const client = (yield* sharding.makeClient(commandEntity(request.ref.actor)))(address)

            yield* (yield* TurnHooks).at("beforeDelivery", request)

            // Runtime scope owns the in-flight turn; interrupting its waiter must not cancel it.
            const deliver = Effect.suspend(() =>
              client
                .Execute(external ? { ...request, external } : request)
                .pipe(Effect.forkIn(scope)),
            ).pipe(
              Effect.flatMap(Fiber.join),
              Effect.catchCause((cause) => {
                const failure = Cause.findErrorOption(cause)

                if (Option.isSome(failure) && Schema.is(ActorError)(failure.value))
                  return Effect.fail(failure.value)

                // An unbounded mailbox cannot fill, so the runner is out of
                // activation slots; a bounded one is full only while resident.
                if (Option.isSome(failure) && Schema.is(ClusterError.MailboxFull)(failure.value)) {
                  if (registration.policy.mailboxCapacity !== "unbounded" && isResident())
                    return Effect.fail(ActorError.make({ reason: MailboxFull.make({}) }))

                  rejectedAtCapacity = true

                  return Effect.fail(ActorError.make({ reason: RunnerAtCapacity.make({}) }))
                }

                // Direct commands are not persisted. A restarted activation
                // or lost runner drops the uncommitted attempt, so
                // the handle retries with the same command id; the receipt
                // replays anything that did commit.
                return Effect.fail(
                  ActorError.make({
                    reason: ActorUnavailable.make({ cause: Cause.squash(cause) }),
                  }),
                )
              }),
            )

            // Each retry waits from the error's own retryAfter, as a served
            // caller would; the delivery timeout bounds the total.
            const retrying = (attempt: number): typeof deliver =>
              deliver.pipe(
                Effect.catchIf(
                  (error) =>
                    Schema.is(ActorUnavailable)(error.reason) ||
                    Schema.is(RunnerAtCapacity)(error.reason),
                  (error) =>
                    Effect.sleep(retryDelay(attempt)(error)).pipe(
                      Effect.andThen(Effect.suspend(() => retrying(attempt + 1))),
                    ),
                ),
              )

            const outcome = yield* retrying(0)

            if (external) yield* authorize(request)

            return outcome
          }).pipe(
            Effect.timeoutOrElse({
              duration: registration.policy.deliveryMs,
              // A turn runs only in a resident activation. After a capacity
              // rejection with none resident, the latest attempt was not
              // admitted; an earlier one may still have committed.
              orElse: () =>
                Effect.fail(
                  ActorError.make({
                    reason:
                      rejectedAtCapacity && !isResident()
                        ? RunnerAtCapacity.make({})
                        : Timeout.make({ commandId: request.commandId }),
                  }),
                ),
            }),
          )
        },
        Effect.provideContext(services),
        Effect.catchIf(SqlError.isSqlError, (cause) =>
          Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
        ),
      )

      // A claimed intent's lease covers the longest turn its receiver may take here.
      const leaseForTurns = () => {
        let longest = 0

        for (const { policy } of registrations.values())
          longest = Math.max(longest, policy.executionMs + policy.lockWaitMs)

        return longest === 0 ? DEFAULT_CLAIM_LEASE_MS : longest + CLAIM_MARGIN_MS
      }

      // Executor progress goes to the performing actor's connection entity,
      // fire-and-forget: no retry, no acknowledgment, and a lost message is a
      // lost frame. Actor types with no member that receives an effect's
      // progress get no messages at all.
      const progressTap = yield* ProgressTap
      const utf8Decoder = new TextDecoder()

      const ownerOf = (ref: ActorRef) =>
        Effect.gen(function* () {
          const make = yield* sharding.makeClient(connectionEntity(ref.actor))

          return make(yield* entityId(ref))
        })

      const fireAndForget = <E>(send: Effect.Effect<void, E>) =>
        send.pipe(Effect.timeout(PROGRESS_SEND_TIMEOUT), Effect.ignoreCause, Effect.forkIn(scope))

      // Each effect's last frame still on its way, so its close never overtakes it.
      const inflight = new Map<string, Fiber.Fiber<void>>()

      // Sends one progress message to its owner as the pool does, past the tap.
      const deliverProgress = (message: ProgressMessage) =>
        Effect.flatMap(ownerOf(message.ref), (client) =>
          client.Progress(
            { ...message, frame: utf8Decoder.decode(message.frame) },
            { discard: true },
          ),
        )

      const progressSink = ProgressSink.of({
        wants: (actor, effect) => effectRegistrations.get(actor)?.progress.has(effect) === true,
        send: (message) =>
          Effect.flatMap(progressTap.send(message), (deliver) =>
            deliver
              ? fireAndForget(deliverProgress(message)).pipe(
                  Effect.flatMap((fiber) =>
                    Effect.sync(() => {
                      inflight.set(message.effectId, fiber)
                      fiber.addObserver(() => {
                        if (inflight.get(message.effectId) === fiber)
                          inflight.delete(message.effectId)
                      })
                    }),
                  ),
                )
              : Effect.void,
          ),
        closed: (message) =>
          Effect.flatMap(progressTap.closed(message), (deliver) =>
            deliver
              ? fireAndForget(
                  Effect.suspend(() => {
                    const last = inflight.get(message.effectId)

                    return last === undefined ? Effect.void : Fiber.await(last)
                  }).pipe(
                    Effect.andThen(ownerOf(message.ref)),
                    Effect.flatMap((client) => client.ProgressClosed(message, { discard: true })),
                  ),
                ).pipe(Effect.asVoid)
              : Effect.void,
          ),
      })

      // Every subscription this runner registers, by subscriber type.
      const localSubscriptions = (): ReadonlyArray<LocalSubscription> =>
        [...registrations.values()].flatMap((registration) =>
          registration.subscriptions.map((subscription) => ({
            subscriberType: registration.name,
            subscription,
          })),
        )

      const placements = new Map<string, Placement>()

      // A source may be registered only on other runners; its recorded
      // placement is fixed once written, so it is cached.
      const placementOf = (actorType: string) =>
        Effect.gen(function* () {
          const known =
            registrations.get(actorType)?.placement ??
            queryRegistrations.get(actorType)?.placement ??
            placements.get(actorType)

          if (known !== undefined) return known

          const sql = yield* SqlClient.SqlClient

          const [recorded] = yield* sql<{ placement: Placement }>`
            SELECT placement FROM actor_placements WHERE actor_type = ${actorType}`

          if (recorded !== undefined) placements.set(actorType, recorded.placement)

          return recorded?.placement
        }).pipe(Effect.provideContext(services), Effect.orDie)

      const subscriptions: SubscriptionRelay = yield* subscriptionRelay({
        deliver: (request) => dispatch(request, false),
        local: localSubscriptions,
        placementOf,
        wake: Effect.suspend(() => relay.wake),
        settings: {
          concurrency: subscriptionConcurrency,
          batch: subscriptionBatch,
          claimLeaseMs: () => claimLeaseMs ?? leaseForTurns(),
          maxBackoffMs: relaySettings.maxBackoffMs,
          retryWindowMs,
        },
      })

      const relay = yield* outboxRelay(
        (request) => dispatch(request, false),
        () =>
          [...effectRegistrations.values()].flatMap((registration) =>
            [...registration.effects].map(([effect, registered]) => ({
              actor: registration.name,
              effect,
              registered: {
                ...registered,
                execute: (payload: string, context: Parameters<typeof registered.execute>[1]) =>
                  registered.execute(payload, context).pipe(withoutDatabase(registration.services)),
              },
            })),
          ),
        { ...relaySettings, claimLeaseMs: () => claimLeaseMs ?? leaseForTurns() },
        {
          concurrency: subscriptionConcurrency,
          claim: subscriptions.claim,
          decode: subscriptions.decode,
          run: (work, handoff) =>
            subscriptions.run(work, handoff).pipe(Effect.provideContext(services)),
        },
        () =>
          new Map(
            Array.from(registrations.values(), ({ name, cron, policy }) => [
              name,
              { entries: cron, skipMs: policy.cronSkipMs },
            ]),
          ),
      ).pipe(Effect.provideService(ProgressSink, progressSink))

      yield* relay.run.pipe(Effect.forkIn(scope))

      const frameworkClock = yield* FrameworkClock
      const cleanupHooks = yield* CleanupHooks

      const cleanup = Effect.suspend(() =>
        sweep(
          Array.from(registrations.values(), ({ name, policy }) => ({
            actorType: name,
            keepReceiptsMs: policy.keepReceiptsMs,
            keepEventsMs: policy.keepEventsMs,
            holdEventsMs: policy.holdEventsMs,
            deliveryMs: policy.deliveryMs,
            keepWorkflowsMs: policy.keepWorkflowsMs,
            workflows: sweepsWorkflows.has(name),
          })),
          retryWindowMs,
        ).pipe(
          // Rows of a subscription a registered subscriber type no longer
          // declares go a day after they fall due.
          Effect.tap(() =>
            Effect.forEach(
              [...registrations.values()],
              (registration) =>
                subscriptions.cleanupRemoved(
                  registration.name,
                  registration.subscriptions.map((declared) => declared.tag),
                ),
              { discard: true },
            ),
          ),
        ),
      ).pipe(
        Effect.provideContext(services),
        Effect.provideService(FrameworkClock, frameworkClock),
        Effect.provideService(CleanupHooks, cleanupHooks),
      )

      // Horizons are days long, so a sweep a minute keeps up; each batch is
      // its own short transaction, so turns never wait on a whole sweep.
      const sweeping = cleanupHooks.periodic
        ? yield* Effect.sleep(CLEANUP_INTERVAL).pipe(
            Effect.andThen(
              cleanup.pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("Retention cleanup failed", cause),
                ),
              ),
            ),
            Effect.forever,
            Effect.forkIn(scope),
          )
        : undefined

      // Routed subscriptions registered here, by source type.
      const routed = (sourceType: string) =>
        localSubscriptions().flatMap(({ subscriberType, subscription }) =>
          subscription.routed !== undefined && subscription.sourceType === sourceType
            ? [{ ...subscription, subscriberType }]
            : [],
        )

      const outbox = { retryWindowMs, wake: relay.wake, cancelled: relay.cancelled, routed }

      const databaseNow = databaseTime.pipe(
        Effect.provideContext(services),
        Effect.catchIf(SqlError.isSqlError, (cause) =>
          Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
        ),
      )

      const internalActors = InternalActors.of({
        mintActorId: crypto.randomUUIDv7.pipe(Effect.orDie),
        mintChildId: (input) =>
          deriveMintId(input).pipe(Effect.provideService(Crypto.Crypto, crypto)),
        retryWindowMs,
        databaseNow,
        mintCommandId: Effect.gen(function* () {
          const now = yield* databaseNow
          const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie)

          return `v1.${now}.${now + retryWindowMs}.${uuid}`
        }),
        tables: (scope, write) =>
          bindTables(database, scope, write, checked).pipe(Effect.provideContext(services)),
        blobs: (scope, write) => bindBlobs(scope, write).pipe(Effect.provideContext(services)),
        registered: (actor) => ({
          commands: registrations.has(actor),
          queries: queryRegistrations.has(actor),
        }),
        declaredBlobs: (actor) =>
          (registrations.get(actor) ?? queryRegistrations.get(actor))?.blobs.map(
            (blob) => blob.name,
          ) ?? [],
        register: Effect.fnUntraced(function* (registration: Registration) {
          if (registrations.has(registration.name))
            return yield* Effect.die(new Error(`Duplicate actor: ${registration.name}`))
          yield* checkPlacement(registration).pipe(Effect.provideContext(services), Effect.orDie)
          yield* checkTables(registration.name, registration.tables).pipe(
            Effect.provideContext(services),
            Effect.orDie,
          )

          for (const table of registration.tables) checked.add(table)

          if (
            registration.workflows.size > 0 &&
            registration.policy.keepWorkflowsMs < retryWindowMs
          )
            return yield* Effect.die(
              new Error(
                `Actor ${registration.name} keepWorkflows is shorter than the retry window`,
              ),
            )

          // A runner that dies mid-activity is replaced after the recovery
          // interval; if the rerun is then already past its call ids' expiry
          // bound, the activity dies with ActivityOutcomeUnknown instead.
          if (
            registration.workflows.size > 0 &&
            retryWindowMs - registration.policy.deliveryMs <= RECOVERY_MS
          )
            yield* Effect.logWarning(
              `Actor ${registration.name}: the retry window minus deliveryTimeout is at most the ${RECOVERY_MS / 1000}-second workflow recovery interval, so an activity whose runner dies fails with ActivityOutcomeUnknown instead of rerunning its actor calls`,
            )

          const { incompatibilities, retained } = yield* acceptWorkflows({
            name: registration.name,
            workflows: Array.from(registration.workflows.values(), ({ member }) => member),
          }).pipe(Effect.provideContext(services), Effect.orDie)

          if (incompatibilities.length > 0)
            return yield* Effect.die(
              new Error(
                [
                  `Actor ${registration.name} workflows are incompatible with open executions; deploy refused`,
                  ...incompatibilities.map(formatIncompatibility),
                ].join("\n"),
              ),
            )

          const { isResident, owner } = yield* registerActor(
            registration,
            transport,
            options.authorize,
            gate,
          ).pipe(Effect.provideContext(services), Effect.provideService(OutboxRuntime, outbox))

          yield* recordRouted(registration).pipe(Effect.provideContext(services), Effect.orDie)
          yield* requireRoutedSubscribers(registration.name).pipe(
            Effect.provideContext(services),
            Effect.orDie,
          )

          // A deploy may add an event class to a dynamic subscription; its
          // caught-up rows must wake for it.
          for (const declared of registration.subscriptions)
            if (declared.routed === undefined)
              yield* subscriptions
                .widen(registration.name, declared)
                .pipe(Effect.provideContext(services), Effect.orDie)

          registrations.set(registration.name, registration)
          residency.set(registration.name, isResident)
          owners.set(registration.name, owner)

          if (registration.connections.size > 0 || registration.feeds.size > 0)
            heldTypes.set(registration.name, heldType(registration))

          if (retained) sweepsWorkflows.add(registration.name)

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              registrations.delete(registration.name)
              residency.delete(registration.name)
              owners.delete(registration.name)
              heldTypes.delete(registration.name)
              sweepsWorkflows.delete(registration.name)
            }),
          )
        }),
        registerQueries: Effect.fnUntraced(function* (registration: QueryRegistration) {
          if (queryRegistrations.has(registration.name))
            return yield* Effect.die(new Error(`Duplicate query layer: ${registration.name}`))
          yield* checkPlacement(registration).pipe(Effect.provideContext(services), Effect.orDie)
          yield* checkTables(registration.name, registration.tables).pipe(
            Effect.provideContext(services),
            Effect.orDie,
          )

          for (const table of registration.tables) checked.add(table)
          queryRegistrations.set(registration.name, registration)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              queryRegistrations.delete(registration.name)
            }),
          )
        }),
        // Executors need no placement: they never touch the actor's rows.
        registerEffects: Effect.fnUntraced(function* (registration: EffectRegistration) {
          if (effectRegistrations.has(registration.name))
            return yield* Effect.die(new Error(`Duplicate effect layer: ${registration.name}`))
          effectRegistrations.set(registration.name, registration)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              effectRegistrations.delete(registration.name)
            }),
          )
        }),
        exists: Effect.fnUntraced(
          function* (ref: ActorRef) {
            const registration = registrations.get(ref.actor)

            if (registration === undefined)
              return yield* ActorError.make({
                reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
              })

            const sql = yield* SqlClient.SqlClient

            const rows = yield* sql`
              SELECT 1 FROM actor_generations
              WHERE routing_key = ${routingKey({ ref, placement: registration.placement })}
                AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

            return rows.length > 0
          },
          Effect.provideContext(services),
          Effect.catchIf(SqlError.isSqlError, (cause) =>
            Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
          ),
        ),
        // Feeds read committed events on the serving node, like queries: no activation.
        readFeed: Effect.fnUntraced(
          function* (
            ref: ActorRef,
            tags: ReadonlyArray<string>,
            after: string | undefined,
            limit: number,
          ) {
            const registration = registrations.get(ref.actor)

            if (registration === undefined)
              return yield* ActorError.make({
                reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
              })

            const key = routingKey({ ref, placement: registration.placement })
            const sql = yield* SqlClient.SqlClient

            const [row] = yield* sql<{ head: string }>`
              SELECT event_sequence::text AS head FROM actor_generations
              WHERE routing_key = ${key} AND tenant_id = ${ref.tenant}
                AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

            // A feed never creates an actor, so a missing generation row is an answer, not a wake.
            if (row === undefined) return yield* ActorError.make({ reason: NotCreated.make({}) })

            return yield* replayEvents(ref, key, tags, after, BigInt(row.head), limit)
          },
          Effect.provideContext(services),
          Effect.catchIf(SqlError.isSqlError, (cause) =>
            Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
          ),
        ),
        // Queries read committed rows on the caller's node: no activation, no
        // generation fence, no receipt, and no command id.
        query: Effect.fnUntraced(
          function* (request: Request) {
            const registration = queryRegistrations.get(request.ref.actor)
            const query = registration?.queries.get(request.command)

            if (registration === undefined || query === undefined)
              return yield* ActorError.make({
                reason: ActorUnavailable.make({ cause: new Error("Query not registered") }),
              })

            yield* allow(request, "query")
            const key = routingKey({ ref: request.ref, placement: registration.placement })

            // Query reads run on the pool outside a transaction, so no
            // statement_timeout bounds them; interrupting a read past
            // commandTimeout cancels its statement on the server instead.
            const outcome = yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              // The event head is read with state in one statement, and every replay
              // in this query stops at it, so state and events describe one moment.
              const rows = yield* sql<{
                head: string | null
                key: string | null
                value: Uint8Array | null
              }>`
                SELECT event_sequence::text AS head, NULL AS key, NULL::bytea AS value
                FROM actor_generations
                WHERE routing_key = ${key} AND tenant_id = ${request.ref.tenant}
                  AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}
                UNION ALL
                SELECT NULL, key, value
                FROM actor_state
                WHERE routing_key = ${key} AND tenant_id = ${request.ref.tenant}
                  AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}`

              let head: string | undefined
              const state: Array<readonly [string, string]> = []

              for (const row of rows)
                if (row.head !== null) head = row.head
                else state.push([row.key!, decompress(row.value!)])

              // State counts only alongside its generation row, which carries the head.
              if (head === undefined) state.length = 0

              const cursor = head ?? "0"

              return yield* query.run(request, state, cursor, (tag, after, limit) =>
                replayEvents(request.ref, key, [tag], after, BigInt(cursor), limit).pipe(
                  Effect.catchIf(SqlError.isSqlError, Effect.die),
                  Effect.provideContext(services),
                ),
              )
            }).pipe(
              Effect.timeoutOrElse({
                duration: registration.timeoutMs,
                orElse: () =>
                  Effect.fail(
                    ActorError.make({ reason: Timeout.make({ commandId: request.commandId }) }),
                  ),
              }),
            )

            // A failed replay read is unavailability, not a deterministic query defect.
            if (Outcome.guards.Defect(outcome) && SqlError.isSqlError(outcome.cause))
              return yield* outcome.cause

            // Access can be revoked while the handler runs; like a command's
            // outcome, a query result is released only to a caller still allowed.
            yield* allow(request, "query")

            return outcome
          },
          Effect.provideContext(services),
          Effect.catchIf(SqlError.isSqlError, (cause) =>
            Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
          ),
        ),
        subscribe: (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const registration = registrations.get(request.ref.actor)

              if (registration === undefined || !registration.streams.has(request.command))
                return yield* ActorError.make({
                  reason: ActorUnavailable.make({ cause: new Error("Stream not registered") }),
                })

              yield* allow(request, "stream")

              const client = (yield* sharding.makeClient(connectionEntity(request.ref.actor)))(
                yield* entityId(request.ref),
              )

              const authorizedUntil =
                (yield* Clock.currentTimeMillis) +
                frameworkClock.offsetMillis() +
                registration.policy.reauthorizeMs

              // The owner the stream runs on, once it answers; a runner that
              // stops answering ends the stream as its activation would.
              const started = yield* Deferred.make<{ owner: string; ownerEpoch: string }>()
              const lost = yield* Deferred.make<never, ActorError>()
              let owner: { owner: string; ownerEpoch: string } | undefined

              yield* Deferred.await(started).pipe(
                Effect.flatMap(({ owner, ownerEpoch }) =>
                  owner === transport.holder
                    ? Effect.never
                    : transport.ping(owner, ownerEpoch).pipe(
                        Effect.repeat({
                          schedule: Schedule.spaced(OWNER_CHECK_INTERVAL),
                          while: (alive) => alive,
                        }),
                        Effect.andThen(Deferred.fail(lost, activationEnded())),
                      ),
                ),
                Effect.forkScoped,
              )

              let finished = false

              return client
                .Subscribe({
                  member: request.command,
                  caller: request.caller,
                  input: request.payload,
                  authorizedUntil,
                })
                .pipe(
                  Stream.tap((item) =>
                    Effect.gen(function* () {
                      if (StreamItem.guards.Done(item)) finished = true

                      if (!StreamItem.guards.Started(item)) return

                      // Cluster resends a request whose runner died; a stream never resumes by itself.
                      if (owner !== undefined) return yield* activationEnded()
                      owner = item
                      yield* Deferred.succeed(started, item)
                    }),
                  ),
                  Stream.takeWhile((item) => !StreamItem.guards.Done(item)),
                  Stream.filter(StreamItem.guards.Element),
                  Stream.map((item) => item.value),
                  // Only `Done` ends a stream cleanly; anything else is its activation ending.
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() => (finished ? Effect.void : activationEnded())),
                    ).pipe(Stream.drain),
                  ),
                  Stream.interruptWhen(Deferred.await(lost)),
                  Stream.catchCause(
                    (cause): Stream.Stream<never, ActorError | { readonly failure: string }> => {
                      const failure = Cause.findErrorOption(cause)

                      if (Option.isSome(failure)) {
                        if (Schema.is(ActorError)(failure.value)) return Stream.fail(failure.value)

                        if (Schema.is(StreamFailed)(failure.value))
                          return Stream.fail({ failure: failure.value.value })
                      }

                      if (Cause.hasInterruptsOnly(cause)) return Stream.fromEffect(Effect.interrupt)

                      // Before the owner answered, the subscription never started.
                      return Stream.fail(
                        owner === undefined
                          ? ActorError.make({
                              reason: ActorUnavailable.make({ cause: Cause.squash(cause) }),
                            })
                          : activationEnded(),
                      )
                    },
                  ),
                )
            }).pipe(Effect.provideContext(services)),
          ),
        deliverProgress: (message) =>
          deliverProgress(message).pipe(Effect.ignoreCause, Effect.provideContext(services)),
        transport,
        holder,
        hibernate: (ref) =>
          Effect.flatMap(
            entityId(ref),
            (id) => owners.get(ref.actor)?.hibernate(id) ?? Effect.void,
          ).pipe(Effect.provideContext(services)),
        pollWorkflow: Effect.fnUntraced(
          function* (request: Request) {
            const registration =
              registrations.get(request.ref.actor) ?? queryRegistrations.get(request.ref.actor)

            if (registration === undefined)
              return yield* ActorError.make({
                reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
              })

            yield* allow(request)
            const sql = yield* SqlClient.SqlClient

            const [row] = yield* sql<{ status: string; result: Uint8Array | null }>`
              SELECT status, result FROM actor_workflow_executions
              WHERE routing_key = ${routingKey({ ref: request.ref, placement: registration.placement })}
                AND execution_id = ${request.payload} AND tenant_id = ${request.ref.tenant}
                AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}
                AND workflow = ${request.command}`

            // Access can be revoked while the read runs, as for a query.
            yield* allow(request)

            if (row === undefined) return undefined

            return {
              finished: row.status === "finished",
              result: row.result === null ? undefined : yield* decodeResult(row.result),
            } satisfies WorkflowStatus
          },
          Effect.provideContext(services),
          Effect.catchIf(SqlError.isSqlError, (cause) =>
            Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
          ),
        ),
        execute: (request) => dispatch(request, true),
        deliver: (request) => dispatch(request, false),
        drainOutbox: relay.drain,
        cleanup: cleanup.pipe(Effect.orDie),
        extendOutboxLeases: relay.extendLeases,
        shardId: (ref) =>
          entityId(ref).pipe(
            Effect.flatMap((id) => commandEntity(ref.actor).getShardId(EntityId.make(id))),
            Effect.map(String),
            Effect.provideService(Sharding.Sharding, sharding),
          ),
      })

      const serving = Effect.gen(function* () {
        if (yield* sharding.isShutdown) return { ready: false, reason: "routing" } as const

        if (registrations.size + queryRegistrations.size + effectRegistrations.size === 0)
          return { ready: false, reason: "unregistered" } as const

        const sql = yield* SqlClient.SqlClient

        const answered = yield* sql`SELECT 1`.pipe(
          Effect.timeoutOption(READINESS_STORAGE_TIMEOUT),
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        )

        return answered
          ? ({ ready: true } as const)
          : ({ ready: false, reason: "storage" } as const)
      }).pipe(Effect.provideContext(services)) satisfies Effect.Effect<Readiness>

      const control = runtimeControl({
        gate,
        stopClaims: relay.stop,
        attemptsIdle: relay.attemptsIdle,
        interruptAttempts: relay.interruptAttempts,
        stopBackground: sweeping === undefined ? Effect.void : Fiber.interrupt(sweeping),
        serving,
        scope,
      })

      return Context.make(Actors, publicActors).pipe(
        Context.add(InternalActors, internalActors),
        Context.add(RuntimeControl, control),
      )
    }),
  )

  return Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const wiring = Option.getOrUndefined(yield* Effect.serviceOption(RunnerWiring))
      yield* migrate
      yield* sql`INSERT INTO actor_deployment (protocol, retry_window_ms) VALUES (1, ${retryWindowMs}) ON CONFLICT DO NOTHING`

      const rows = yield* sql<{
        protocol: number
        retry_window_ms: string
      }>`SELECT protocol, retry_window_ms::text AS retry_window_ms FROM actor_deployment`

      if (rows[0]!.protocol !== 1 || Number(rows[0]!.retry_window_ms) !== retryWindowMs) {
        return yield* Effect.die(
          new Error(
            "Actor command protocol/retry window differs from the deployment; migrate explicitly",
          ),
        )
      }

      // SqlRunnerStorage reserves a SQL connection for the layer's lifetime,
      // which starves PGlite's single connection; runner bookkeeping moves to
      // memory while migrations and receipts stay in SQL.
      const runnerStorage: "memory" | "sql" = Option.isSome(
        yield* Effect.serviceOption(PgliteClient.PgliteClient),
      )
        ? "memory"
        : "sql"

      // Commands are direct, so Cluster keeps no messages; durable intents
      // use the actor-shard outbox instead.
      const sharding = (
        wiring?.sharding ?? Sharding.layer.pipe(Layer.provide(Runners.layerNoop))
      ).pipe(
        Layer.provideMerge(directMessages),
        Layer.provide([
          runnerStorage === "memory"
            ? Layer.effect(
                RunnerStorage.RunnerStorage,
                Effect.map(RunnerStorage.makeMemory, keepAcquiredShards),
              )
            : Layer.effect(
                RunnerStorage.RunnerStorage,
                SqlRunnerStorage.make({}).pipe(
                  Effect.map(wiring?.storage ?? ((storage) => storage)),
                  Effect.map(keepAcquiredShards),
                ),
              ).pipe(Layer.orDie),
          RunnerHealth.layerNoop,
        ]),
        Layer.provideMerge(
          ShardingConfig.layer({
            shardsPerGroup: 1,
            simulateRemoteSerialization: true,
            maxResidentEntities: maxResidentActors,
            ...wiring?.config,
            ...holderShardGroups(wiring?.config ?? {}),
          }),
        ),
      )

      // Advisory locks are held by a live session, so no second runner can
      // take a shard while its holder runs; table locks can expire under a
      // runner that keeps serving, and singletons then check their lease.
      const config = wiring?.config
      const address = config?.runnerAddress

      const lease =
        runnerStorage === "sql" &&
        config?.shardLockDisableAdvisory === true &&
        address !== undefined &&
        Option.isSome(address)
          ? Layer.succeed(
              ShardLease,
              tableShardLease({
                sql,
                address: address.value,
                expiration: Duration.fromInputUnsafe(
                  config.shardLockExpiration ?? ShardingConfig.defaults.shardLockExpiration,
                ),
              }),
            )
          : Layer.empty

      return runtime.pipe(Layer.provide(sharding), Layer.provide(lease))
    }),
  )
}

export const Database = {
  /**
   * A runner holds two pools. Turns lease sessions from the turn pool,
   * `maxConnections` (default 50): a command holds one session for its whole
   * turn, so a pool smaller than the commands in flight queues callers behind
   * it. Queries, the relay, migrations, and cluster storage use the off-turn
   * pool, `offTurnConnections` (default 10). Both open connections only as
   * load needs them. Keep the sum of both across runners below the server's
   * `max_connections`.
   */
  postgres: (
    options: Omit<PgClient.PgPoolConfig, "types"> & { readonly offTurnConnections?: number },
  ) => {
    const types = PgTypes.makeRegistry()
    // rc.116 lacks regclass decoding, used by Sql Migrator on restart. Remove after Effect #8309.
    types.register(2205, {
      encode: (value: number) => PgTypes.encode(value, PgTypes.OID.oid),
      decode: (bytes) =>
        bytes.length === 4
          ? Result.succeed(
              new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0),
            )
          : Result.fail(new PgTypes.CodecError({ message: "Invalid regclass value" })),
    })

    const { offTurnConnections, ...pool } = options

    return Layer.merge(
      PgClient.layer({ ...pool, maxConnections: offTurnConnections ?? 10, types }),
      turnConnections({ ...pool, maxConnections: pool.maxConnections ?? 50, types }),
    )
  },
  pglite,
}
