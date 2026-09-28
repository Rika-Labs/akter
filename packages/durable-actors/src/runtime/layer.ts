import { PgClient, PgTypes } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import {
  Cause,
  Context,
  Crypto,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  Schema,
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
  Unauthorized,
  Timeout,
  MailboxFull,
  RunnerAtCapacity,
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
import type { Owner } from "./connections/owner.ts"
import { replayEvents } from "./events/replay.ts"
import { checkIdentity, databaseTime, FrameworkClock, readAdmission } from "./turn/admission.ts"
import { decompress, PLACEMENT_ENCODING, routingKey } from "./storage/codec.ts"
import { CleanupHooks, TurnHooks } from "./turn/hooks.ts"
import { OutboxRuntime, textArray } from "./turn/outbox.ts"
import { outboxRelay } from "./turn/relay.ts"
import {
  type LocalSubscription,
  type SubscriptionRelay,
  subscriptionRelay,
} from "./subscriptions/relay.ts"
import type { Placement } from "./storage/codec.ts"
import { sweep } from "./storage/retention.ts"
import { acceptWorkflows, formatIncompatibility } from "./workflows/compatibility.ts"
import { decodeResult } from "./workflows/engine.ts"
import { INTERRUPT, RESUME, Target } from "../handles/workflow.ts"
import { decodeExecutionId } from "../identity/execution.ts"
import { keepAcquiredShards, ShardLease, tableShardLease } from "./topology/locks.ts"
import { bindBlobs } from "./turn/blobs.ts"
import { bindTables, checkTables, rowsDatabase } from "./turn/rows.ts"
import type { AnyOwnedTable } from "../tables/owned.ts"
import { checkReceipt } from "./turn/receipt.ts"

export interface Options {
  readonly authorize: (request: {
    readonly caller: Caller
    readonly ref: ActorRef
    readonly command: string
    /** What is being authorized: `command` for commands and reducers, `query` for queries; hooks should deny kinds they do not know. */
    readonly kind: "command" | "query" | "open" | "stream" | "reauthorize"
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

/** Pause between retention sweeps. */
const CLEANUP_INTERVAL = "1 minute"

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

  const claimLeaseMs =
    options.relay?.claimLease === undefined ? undefined : millis(options.relay.claimLease)

  const relaySettings = {
    pollMs: millis(options.relay?.poll ?? "1 second"),
    passLimit: Count.make(options.relay?.passLimit ?? 256),
    deliveryConcurrency: Count.make(options.relay?.deliveryConcurrency ?? 16),
    maxBackoffMs: millis(options.relay?.maxBackoff ?? "256 seconds"),
    executorConcurrency: Count.make(options.executors?.concurrency ?? 64),
    executorLeaseMs,
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
          hasResync: (member) => registration.connections.get(member)?.hasResync ?? false,
          hasMember: (member) => registration.connections.has(member),
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
        kind: "command" | "query" = "command",
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
          run: (work) => subscriptions.run(work).pipe(Effect.provideContext(services)),
        },
      )

      yield* relay.run.pipe(Effect.forkIn(scope))

      const frameworkClock = yield* FrameworkClock
      const cleanupHooks = yield* CleanupHooks

      const cleanup = Effect.suspend(() =>
        sweep(
          Array.from(registrations.values(), ({ name, policy }) => ({
            actorType: name,
            keepReceiptsMs: policy.keepReceiptsMs,
            keepEventsMs: policy.keepEventsMs,
            deliveryMs: policy.deliveryMs,
            keepWorkflowsMs: policy.keepWorkflowsMs,
            workflows: sweepsWorkflows.has(name),
          })),
          retryWindowMs,
        ),
      ).pipe(
        Effect.provideContext(services),
        Effect.provideService(FrameworkClock, frameworkClock),
        Effect.provideService(CleanupHooks, cleanupHooks),
      )

      // Horizons are days long, so a sweep a minute keeps up; each batch is
      // its own short transaction, so turns never wait on a whole sweep.
      if (cleanupHooks.periodic)
        yield* Effect.sleep(CLEANUP_INTERVAL).pipe(
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
      // Routed subscriptions registered here, by source type.

      const routed = (sourceType: string) =>
        localSubscriptions().flatMap(({ subscriberType, subscription }) =>
          subscription.routed !== undefined && subscription.sourceType === sourceType
            ? [{ ...subscription, subscriberType }]
            : [],
        )

      const outbox = { retryWindowMs, wake: relay.wake, routed }

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

          const { isResident, owner } = yield* registerActor(registration, transport).pipe(
            Effect.provideContext(services),
            Effect.provideService(OutboxRuntime, outbox),
          )

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

          if (registration.connections.size > 0)
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
                replayEvents(request.ref, key, tag, after, BigInt(cursor), limit).pipe(
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

      return Context.make(Actors, publicActors).pipe(Context.add(InternalActors, internalActors))
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

      // Commands are direct, so Cluster keeps no message storage; durable
      // intents will use the actor-shard outbox instead.
      const sharding = (
        wiring?.sharding ?? Sharding.layer.pipe(Layer.provide(Runners.layerNoop))
      ).pipe(
        Layer.provideMerge(MessageStorage.layerNoop),
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
   * `maxConnections` defaults to 50. A command holds one connection for its
   * whole turn, so a pool smaller than the commands in flight queues callers
   * behind it; the pool opens connections only as load needs them. Keep the
   * sum across runners below the server's `max_connections`.
   */
  postgres: (options: Omit<PgClient.PgPoolConfig, "types">) => {
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

    return PgClient.layer({ ...options, maxConnections: options.maxConnections ?? 50, types })
  },
  pglite,
}
