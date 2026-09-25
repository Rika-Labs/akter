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
} from "../errors/actor.ts"
import {
  Actors,
  InternalActors,
  type QueryRegistration,
  type Registration,
  type Request,
} from "../handles/actors.ts"
import type { ActorRef, Caller } from "../identity/caller.ts"
import { migrate } from "./database/migrations.ts"
import { pglite } from "./database/pglite.ts"
import { commandEntity, registerActor } from "./entity/register.ts"
import { checkIdentity, databaseTime, readAdmission } from "./turn/admission.ts"
import { decompress, PLACEMENT_ENCODING, routingKey } from "./storage/codec.ts"
import { TurnHooks } from "./turn/hooks.ts"
import { checkReceipt } from "./turn/receipt.ts"

export interface Options {
  readonly authorize: (request: {
    readonly caller: Caller
    readonly ref: ActorRef
    readonly command: string
  }) => Effect.Effect<boolean>
  readonly retryWindowMs?: number
}

export const layer = (options: Options) => {
  const retryWindowMs = Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 2_592_000_000 }),
  ).make(options.retryWindowMs ?? 86_400_000)

  const runtime = Layer.effectContext(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const scope = yield* Effect.scope
      const sharding = yield* Sharding.Sharding
      const registrations = new Map<string, Registration>()
      const queryRegistrations = new Map<string, QueryRegistration>()

      const services = yield* Effect.context<
        SqlClient.SqlClient | Crypto.Crypto | Sharding.Sharding
      >()

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

      const publicActors = Actors.of({
        mintCommandId: Effect.gen(function* () {
          const now = yield* databaseTime
          const uuid = yield* crypto.randomUUIDv4

          return `v1.${now}.${now + retryWindowMs}.${uuid}`
        }).pipe(Effect.provideContext(services), Effect.orDie),
      })

      const internalActors = InternalActors.of({
        mintActorId: crypto.randomUUIDv7.pipe(Effect.orDie),
        register: Effect.fnUntraced(function* (registration: Registration) {
          if (registrations.has(registration.name))
            return yield* Effect.die(new Error(`Duplicate actor: ${registration.name}`))
          yield* checkPlacement(registration).pipe(Effect.provideContext(services), Effect.orDie)
          yield* registerActor(registration).pipe(Effect.provideContext(services))
          registrations.set(registration.name, registration)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              registrations.delete(registration.name)
            }),
          )
        }),
        registerQueries: Effect.fnUntraced(function* (registration: QueryRegistration) {
          if (queryRegistrations.has(registration.name))
            return yield* Effect.die(new Error(`Duplicate query layer: ${registration.name}`))
          yield* checkPlacement(registration).pipe(Effect.provideContext(services), Effect.orDie)
          queryRegistrations.set(registration.name, registration)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              queryRegistrations.delete(registration.name)
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

            const rows = yield* sql<{ key: string; value: Uint8Array }>`
              SELECT key, value FROM actor_state
              WHERE routing_key = ${key} AND tenant_id = ${request.ref.tenant}
                AND actor_type = ${request.ref.actor} AND actor_id = ${request.ref.id}`

            const outcome = yield* query.run(
              request,
              rows.map(({ key, value }) => [key, decompress(value)] as const),
            )

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
        execute: Effect.fnUntraced(
          function* (request: Request) {
            const registration = registrations.get(request.ref.actor)

            if (registration === undefined)
              return yield* ActorError.make({
                reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
              })

            return yield* Effect.gen(function* () {
              yield* allow(request)

              // Postgres rejects some malformed ids and payloads outright; they
              // still fail as terminal identity errors, checked as before.
              const admission = yield* readAdmission(
                request,
                routingKey({ ref: request.ref, placement: registration.placement }),
              ).pipe(
                Effect.tapError(() =>
                  Effect.flatMap(databaseTime, (now) =>
                    checkIdentity(request.commandId, retryWindowMs, now),
                  ),
                ),
              )

              yield* checkIdentity(request.commandId, retryWindowMs, admission.now)

              if (admission.receipt !== undefined) {
                const retained = yield* checkReceipt(request, admission.hash, admission.receipt)
                yield* authorize(request)

                return retained
              }

              const client = (yield* sharding.makeClient(commandEntity(request.ref.actor)))(
                yield* Schema.encodeEffect(
                  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
                )([request.ref.tenant, request.ref.id]).pipe(Effect.orDie),
              )

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

                  if (Option.isSome(failure) && Schema.is(ClusterError.MailboxFull)(failure.value))
                    return Effect.fail(ActorError.make({ reason: MailboxFull.make({}) }))

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
                  while: (error) => Schema.is(ActorUnavailable)(error.reason),
                  // Exponential backoff capped at 500 ms; the delivery timeout bounds the total.
                  schedule: Schedule.min([
                    Schedule.exponential("10 millis", 2),
                    Schedule.spaced("500 millis"),
                  ]),
                }),
              )

              yield* authorize(request)

              return outcome
            }).pipe(
              Effect.timeoutOrElse({
                duration: registration.policy.deliveryMs,
                orElse: () =>
                  Effect.fail(
                    ActorError.make({ reason: Timeout.make({ commandId: request.commandId }) }),
                  ),
              }),
            )
          },
          Effect.provideContext(services),
          Effect.catchIf(SqlError.isSqlError, (cause) =>
            Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
          ),
        ),
      })

      return Context.make(Actors, publicActors).pipe(Context.add(InternalActors, internalActors))
    }),
  )

  return Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
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
      const sharding = Sharding.layer.pipe(
        Layer.provideMerge(Runners.layerNoop),
        Layer.provideMerge(MessageStorage.layerNoop),
        Layer.provide([
          runnerStorage === "memory"
            ? RunnerStorage.layerMemory
            : Layer.orDie(SqlRunnerStorage.layer),
          RunnerHealth.layerNoop,
        ]),
        Layer.provide(
          ShardingConfig.layer({ shardsPerGroup: 1, simulateRemoteSerialization: true }),
        ),
      )

      return runtime.pipe(Layer.provide(sharding))
    }),
  )
}

export const Database = {
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

    return PgClient.layer({ ...options, types })
  },
  pglite,
}
