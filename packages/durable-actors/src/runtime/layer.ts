import { PgClient, PgTypes } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import {
  Cause,
  Context,
  Crypto,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  Schedule,
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
  type Request,
} from "../handles/actors.ts"
import type { ActorRef, Caller } from "../identity/caller.ts"
import { migrate } from "./database/migrations.ts"
import { withoutDatabase } from "./effects/isolation.ts"
import { pglite } from "./database/pglite.ts"
import { commandEntity, registerActor } from "./entity/register.ts"
import { replayEvents } from "./events/replay.ts"
import { checkIdentity, databaseTime, readAdmission } from "./turn/admission.ts"
import { decompress, PLACEMENT_ENCODING, routingKey } from "./storage/codec.ts"
import { TurnHooks } from "./turn/hooks.ts"
import { OutboxRuntime } from "./turn/outbox.ts"
import { outboxRelay } from "./turn/relay.ts"
import { bindBlobs } from "./turn/blobs.ts"
import { bindTables, checkTables, rowsDatabase } from "./turn/rows.ts"
import type { AnyOwnedTable } from "../tables/owned.ts"
import { checkReceipt } from "./turn/receipt.ts"

export interface Options {
  readonly authorize: (request: {
    readonly caller: Caller
    readonly ref: ActorRef
    readonly command: string
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
}

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
>()("durable-actors/runtime/layer/RunnerWiring") {}

// Cluster entity ids name the tenant and actor id together.
const encodeEntityId = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
)

export const layer = (options: Options) => {
  const retryWindowMs = Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 2_592_000_000 }),
  ).make(options.retryWindowMs ?? 86_400_000)

  const maxResidentActors = Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
  ).make(options.maxResidentActors ?? 10_000)

  const runtime = Layer.effectContext(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const scope = yield* Effect.scope
      const sharding = yield* Sharding.Sharding
      const registrations = new Map<string, Registration>()
      const residency = new Map<string, (entityId: string) => boolean>()
      const queryRegistrations = new Map<string, QueryRegistration>()
      const effectRegistrations = new Map<string, EffectRegistration>()

      const services = yield* Effect.context<
        SqlClient.SqlClient | Crypto.Crypto | Sharding.Sharding
      >()

      const database = yield* rowsDatabase

      // Tables that passed the startup check for an actor type of this runtime;
      // group reads may only touch these, never other Actor.table values.
      const checked = new Set<AnyOwnedTable>()

      const allow = Effect.fnUntraced(function* (request: Request) {
        if (!(yield* options.authorize(request)))
          return yield* ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })
      })

      const authorize = Effect.fnUntraced(function* (request: Request) {
        yield* allow(request)
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
            if (external) yield* allow(request)

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

            if (admission.receipt !== undefined) {
              const retained = yield* checkReceipt(request, admission.hash, admission.receipt)

              if (external) yield* authorize(request)

              return retained
            }

            const client = (yield* sharding.makeClient(commandEntity(request.ref.actor)))(address)

            yield* (yield* TurnHooks).at("beforeDelivery", request)

            // Runtime scope owns the in-flight turn; interrupting its waiter must not cancel it.
            const deliver = Effect.suspend(() =>
              client.Execute(request).pipe(Effect.forkIn(scope)),
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

            const outcome = yield* deliver.pipe(
              Effect.retry({
                while: (error) =>
                  Schema.is(ActorUnavailable)(error.reason) ||
                  Schema.is(RunnerAtCapacity)(error.reason),
                // Exponential backoff capped at 500 ms; the delivery timeout bounds the total.
                schedule: Schedule.min([
                  Schedule.exponential("10 millis", 2),
                  Schedule.spaced("500 millis"),
                ]),
              }),
            )

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

      const relay = yield* outboxRelay(
        (request) => dispatch(request, false),
        (actor, effect) => {
          const registration = effectRegistrations.get(actor)
          const registered = registration?.effects.get(effect)

          if (registration === undefined || registered === undefined) return undefined

          return {
            ...registered,
            execute: (payload, context) =>
              registered.execute(payload, context).pipe(withoutDatabase(registration.services)),
          }
        },
      )

      yield* relay.run.pipe(Effect.forkIn(scope))
      const outbox = { retryWindowMs, wake: relay.wake }

      const internalActors = InternalActors.of({
        mintActorId: crypto.randomUUIDv7.pipe(Effect.orDie),
        tables: (scope, write) =>
          bindTables(database, scope, write, checked).pipe(Effect.provideContext(services)),
        blobs: (scope, write) => bindBlobs(scope, write).pipe(Effect.provideContext(services)),
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

          const isResident = yield* registerActor(registration).pipe(
            Effect.provideContext(services),
            Effect.provideService(OutboxRuntime, outbox),
          )

          registrations.set(registration.name, registration)
          residency.set(registration.name, isResident)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              registrations.delete(registration.name)
              residency.delete(registration.name)
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

            yield* allow(request)
            const sql = yield* SqlClient.SqlClient
            const key = routingKey({ ref: request.ref, placement: registration.placement })

            // The event head is read with state in one statement, and every replay
            // in this query stops at it, so state and events describe one moment.
            const rows = yield* sql<{
              head: string | null
              key: string | null
              value: Uint8Array | null
            }>`
              SELECT g.event_sequence::text AS head, s.key, s.value
              FROM (VALUES (1)) AS one (x)
              LEFT JOIN actor_generations g ON g.routing_key = ${key} AND g.tenant_id = ${request.ref.tenant}
                AND g.actor_type = ${request.ref.actor} AND g.actor_id = ${request.ref.id}
              LEFT JOIN actor_state s ON s.routing_key = g.routing_key AND s.tenant_id = g.tenant_id
                AND s.actor_type = g.actor_type AND s.actor_id = g.actor_id`

            const head = rows[0]?.head ?? "0"
            const state: Array<readonly [string, string]> = []

            for (const row of rows)
              if (row.key !== null) state.push([row.key, decompress(row.value!)])

            const outcome = yield* query.run(request, state, head, (tag, after) =>
              replayEvents(request.ref, key, tag, after, BigInt(head)).pipe(
                Effect.catchIf(SqlError.isSqlError, Effect.die),
                Effect.provideContext(services),
              ),
            )

            // A failed replay read is unavailability, not a deterministic query defect.
            if (Outcome.guards.Defect(outcome) && SqlError.isSqlError(outcome.cause))
              return yield* outcome.cause

            // Access can be revoked while the handler runs; like a command's
            // outcome, a query result is released only to a caller still allowed.
            yield* allow(request)

            return outcome
          },
          Effect.provideContext(services),
          Effect.catchIf(SqlError.isSqlError, (cause) =>
            Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
          ),
        ),
        execute: (request) => dispatch(request, true),
        deliver: (request) => dispatch(request, false),
        drainOutbox: relay.drain,
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
            ? RunnerStorage.layerMemory
            : Layer.effect(
                RunnerStorage.RunnerStorage,
                SqlRunnerStorage.make({}).pipe(
                  Effect.map(wiring?.storage ?? ((storage) => storage)),
                ),
              ).pipe(Layer.orDie),
          RunnerHealth.layerNoop,
        ]),
        Layer.provide(
          ShardingConfig.layer({
            shardsPerGroup: 1,
            simulateRemoteSerialization: true,
            maxResidentEntities: maxResidentActors,
            ...wiring?.config,
          }),
        ),
      )

      return runtime.pipe(Layer.provide(sharding))
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
