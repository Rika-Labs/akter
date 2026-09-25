import type { PgClient } from "@effect/sql-pg"
import type { PgliteClient } from "@effect/sql-pglite"
import {
  Context,
  Crypto,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schema,
  Option,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  Anonymous,
  type ActorRef,
  type Caller,
  CurrentCaller,
  Tenant,
  System,
  principal,
} from "../identity/caller.ts"
import {
  type DefinitionWithInternal,
  type InternalDefinition,
  internalDefinitions,
} from "../actor/definition.ts"
import type { ActorError } from "../errors/actor.ts"
import { type Actors, InternalActors, type Outcome, type Request } from "../handles/actors.ts"
import { Database, layer as runtimeLayer, type Options } from "../runtime/layer.ts"
import { compress, decompress, type Placement, routingKey } from "../runtime/storage/codec.ts"
import { VERSION_KEY } from "../state/migration.ts"
import { RetryTurn, TurnHooks, type TurnPoint } from "../runtime/turn/hooks.ts"
import { OutboxClock, outboxTime } from "../runtime/turn/outbox.ts"
import { type ClusterOptions, clusterLayer } from "./cluster.ts"

/**
 * Present while `ActorTest.cluster` builds one of its runners: the runner
 * shares the cluster's tenant and opens its database connections through
 * `connect`, so killing it can cut them.
 */
export class ClusterMember extends Context.Service<
  ClusterMember,
  {
    readonly tenant: string
    readonly connect: NonNullable<PgClient.PgPoolConfig["stream"]>
  }
>()("durable-actors/testing/actor-test/ClusterMember") {}

export interface TestOptions {
  /**
   * Postgres connection string or a PGlite client config. Omitted, a fresh
   * in-memory PGlite database is created per layer build; `dataDir` retains
   * a database across builds. PGlite is single-process and supplies no
   * independent-connection behavior.
   */
  readonly database?: Redacted.Redacted<string> | PgliteClient.PgliteClientConfig
  readonly as?: Caller
  readonly authorize?: Options["authorize"]
  readonly retryWindowMs?: number
  readonly maxResidentActors?: number
}

export interface Inspection {
  readonly generation: string | undefined
  readonly state: Schema.JsonObject["Type"]
  readonly receipts: number
  readonly events: number
  /** Pending intents and timers this actor sent, including effect routes awaiting delivery. */
  readonly outbox: number
  /** Effects this actor performed whose executor has not yet settled them. */
  readonly effects: number
  /**
   * The actor's row count per owned table, keyed by table name (schema-qualified
   * outside the current schema); present when its type owns tables.
   */
  readonly rows?: Readonly<Record<string, number>>
  /** The actor's entry count per declared blob; present when its type declares blobs. */
  readonly blobs?: Readonly<Record<string, number>>
}

interface TestDefinition {
  readonly get: unknown
}

type InternalHandleOf<D> = D extends DefinitionWithInternal<infer H> ? H : never

const testActors = new WeakMap<ActorTest["Service"], InternalActors["Service"]>()

/** Package-internal escape hatch for deterministic runtime conformance cases. */
export const executeForTest = (request: Request): Effect.Effect<Outcome, ActorError, ActorTest> =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const actors = testActors.get(test)

    if (actors === undefined) return yield* Effect.die(new Error("ActorTest runtime unavailable"))

    return yield* actors.execute(request)
  })

export class ActorTest extends Context.Service<
  ActorTest,
  {
    readonly tenant: string
    readonly actor: <D extends TestDefinition>(
      definition: D,
      id?: string,
    ) => Effect.Effect<
      {
        readonly system: InternalHandleOf<D>
        readonly inspect: Effect.Effect<Inspection>
      },
      never,
      Actors
    >
    readonly inspect: (ref: ActorRef) => Effect.Effect<Inspection>
    readonly crashNext: (point: TurnPoint) => Effect.Effect<void>
    readonly pauseNext: (point: TurnPoint) => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: Effect.Effect<void>
    }>
    readonly invalidate: (ref: ActorRef) => Effect.Effect<void>
    /**
     * Moves the outbox clock forward by `duration`, then delivers every intent
     * and timer that is due, including intents those deliveries stage.
     */
    readonly advance: (duration: Duration.Input) => Effect.Effect<void>
    /** The outbox clock: database time plus every `advance` so far; `Intent.at` is due against it. */
    readonly now: Effect.Effect<DateTime.Utc>
    /** Committed receipts of `command` on the actor `ref`. */
    readonly receiptsFor: (ref: ActorRef, command: string) => Effect.Effect<number>
    /**
     * Writes raw stored state, as an older deployment would have, so tests can
     * exercise state migrations. `version` is the number of migrations the
     * stored shape has already passed through.
     */
    readonly seed: (
      ref: ActorRef,
      state: { readonly [key: string]: Schema.Json },
      version: number,
    ) => Effect.Effect<void>
  }
>()("durable-actors/testing/actor-test/ActorTest") {
  /**
   * Runs `runners` runtimes in this process against one Postgres database,
   * each a distinct Cluster runner with its own address, connection pool, and
   * expiring shard locks. Provides `ActorCluster`; see its controls.
   */
  static readonly cluster = <ROut, E, RIn>(options: ClusterOptions<ROut, E, RIn>) =>
    clusterLayer(options)

  static readonly layer = (options: TestOptions) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto
        const member = Option.getOrUndefined(yield* Effect.serviceOption(ClusterMember))
        const tenant = member?.tenant ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie))
        const faults = new Map<TurnPoint, Array<Effect.Effect<void>>>()

        let clockOffset = 0

        const hooks = Layer.mergeAll(
          Layer.succeed(TurnHooks, {
            at: (point) => Effect.suspend(() => faults.get(point)?.shift() ?? Effect.void),
          }),
          Layer.succeed(OutboxClock, { offsetMillis: () => clockOffset }),
        )

        const addFault = (point: TurnPoint, fault: Effect.Effect<void>) =>
          Effect.sync(() => {
            const queue = faults.get(point) ?? []
            queue.push(fault)
            faults.set(point, queue)
          })

        const test = Layer.effect(
          ActorTest,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            // Helpers address rows by the routing key production uses, so a row
            // written under the wrong key is invisible here too.
            const storedRoutingKey = Effect.fnUntraced(function* (ref: ActorRef) {
              const [recorded] = yield* sql<{ placement: Placement }>`
                SELECT placement FROM actor_placements WHERE actor_type = ${ref.actor}`

              if (recorded === undefined)
                return yield* Effect.die(new Error(`Actor ${ref.actor} is not registered`))

              return routingKey({ ref, placement: recorded.placement })
            })

            const internalActors = yield* InternalActors

            const service: ActorTest["Service"] = ActorTest.of({
              tenant,
              actor: Effect.fnUntraced(function* <D extends TestDefinition>(
                definition: D,
                id = "singleton",
              ) {
                const as = options.as ?? Anonymous.make({})

                const caller = Schema.is(System)(as)
                  ? as
                  : System.make({
                      source: "actor",
                      onBehalfOf: Option.getOrUndefined(principal(as)),
                    })

                type H = InternalHandleOf<D> & { readonly ref: ActorRef }

                const internal = internalDefinitions.get(definition) as
                  | InternalDefinition<H>
                  | undefined

                if (internal === undefined)
                  return yield* Effect.die(new Error("Unknown actor definition"))

                const system = yield* internal
                  .handle(id, tenant, caller)
                  .pipe(Effect.provideService(InternalActors, internalActors))

                return { system, inspect: service.inspect(system.ref) }
              }) as ActorTest["Service"]["actor"],
              crashNext: (point) =>
                addFault(point, Effect.die(RetryTurn.make({ message: `Injected ${point} crash` }))),
              pauseNext: Effect.fnUntraced(function* (point: TurnPoint) {
                const reached = yield* Deferred.make<void>()
                const release = yield* Deferred.make<void>()
                yield* addFault(
                  point,
                  Deferred.succeed(reached, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                )

                return {
                  reached: Deferred.await(reached),
                  release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
                }
              }),
              inspect: Effect.fnUntraced(function* (ref: ActorRef) {
                const routing = yield* storedRoutingKey(ref)

                const generations = yield* sql<{
                  generation: string
                }>`SELECT generation::text AS generation FROM actor_generations
            WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

                const state = (yield* sql<{
                  key: string
                  value: Uint8Array
                }>`SELECT key, value FROM actor_state
            WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}
              AND key <> ${VERSION_KEY}`).map(({ key, value }) => ({
                  key,
                  value: decompress(value),
                }))

                const receipts = yield* sql<{
                  count: number
                }>`SELECT count(*)::integer AS count FROM actor_receipts
            WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

                const events = yield* sql<{
                  count: number
                }>`SELECT count(*)::integer AS count FROM actor_events
            WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

                const outbox = yield* sql<{
                  intents: number
                  effects: number
                }>`SELECT count(*) FILTER (WHERE kind = 'intent')::integer AS intents,
              count(*) FILTER (WHERE kind = 'effect')::integer AS effects FROM actor_outbox
            WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

                const tables = yield* sql<{
                  table_schema: string
                  table_name: string
                  label: string
                }>`
                  SELECT table_schema, table_name, CASE WHEN table_schema = current_schema()
                    THEN table_name ELSE table_schema || '.' || table_name END AS label
                  FROM actor_tables WHERE actor_type = ${ref.actor} ORDER BY label`

                const rows: Record<string, number> = {}

                for (const { table_schema, table_name, label } of tables)
                  rows[label] = (yield* sql<{ count: number }>`
                    SELECT count(*)::integer AS count FROM ${sql(table_schema)}.${sql(table_name)}
                    WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_id = ${ref.id}`)[0]!.count

                const declared = internalActors.declaredBlobs(ref.actor)

                const stored = yield* sql<{ blob: string; entries: number }>`
                  SELECT blob, count(DISTINCT name)::integer AS entries FROM actor_blobs
                  WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant}
                    AND actor_type = ${ref.actor} AND actor_id = ${ref.id}
                  GROUP BY blob`

                const blobs = Object.fromEntries(declared.map((name) => [name, 0]))

                for (const { blob, entries } of stored) blobs[blob] = entries

                const inspection: Inspection = {
                  generation: generations[0]?.generation,
                  state: Object.fromEntries(
                    yield* Effect.forEach(
                      state,
                      Effect.fnUntraced(function* ({ key, value }) {
                        return [
                          key,
                          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
                            value,
                          ).pipe(Effect.orDie),
                        ]
                      }),
                    ),
                  ),
                  receipts: receipts[0]!.count,
                  events: events[0]!.count,
                  outbox: outbox[0]!.intents,
                  effects: outbox[0]!.effects,
                }

                const withRows = tables.length > 0 ? { ...inspection, rows } : inspection

                return declared.length > 0 ? { ...withRows, blobs } : withRows
              }, Effect.orDie),
              seed: Effect.fnUntraced(function* (ref, state, version) {
                const key = yield* storedRoutingKey(ref)

                yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}) ON CONFLICT DO NOTHING`

                const rows: Array<readonly [string, string]> = Object.entries(state).map(
                  ([name, value]) => [name, JSON.stringify(value)] as const,
                )

                if (version > 0) rows.push([VERSION_KEY, String(version)])

                for (const [name, value] of rows)
                  yield* sql`INSERT INTO actor_state (routing_key, tenant_id, actor_type, actor_id, key, value)
            VALUES (${key}, ${ref.tenant}, ${ref.actor}, ${ref.id}, ${name}, ${compress(value)})`
              }, Effect.orDie),
              advance: Effect.fnUntraced(function* (duration: Duration.Input) {
                const millis = Duration.toMillis(duration)

                if (!Number.isFinite(millis) || millis < 0)
                  return yield* Effect.die(
                    new Error("advance needs a finite, non-negative duration"),
                  )

                clockOffset += millis
                yield* internalActors.drainOutbox
              }),
              now: outboxTime.pipe(
                Effect.map((millis) => DateTime.makeUnsafe(millis)),
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.provideService(OutboxClock, { offsetMillis: () => clockOffset }),
                Effect.orDie,
              ),
              receiptsFor: Effect.fnUntraced(function* (ref: ActorRef, command: string) {
                const routing = yield* storedRoutingKey(ref)

                const rows = yield* sql<{ count: number }>`
                  SELECT count(*)::integer AS count FROM actor_receipts
                  WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor}
                    AND actor_id = ${ref.id} AND command = ${command}`

                return rows[0]!.count
              }, Effect.orDie),
              invalidate: Effect.fnUntraced(function* (ref: ActorRef) {
                const routing = yield* storedRoutingKey(ref)
                yield* sql`UPDATE actor_generations SET generation = generation + 1
            WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`
              }, Effect.orDie),
            })

            testActors.set(service, internalActors)

            return service
          }),
        )

        const runtime = runtimeLayer({
          authorize: options.authorize ?? (() => Effect.succeed(true)),
          retryWindowMs: options.retryWindowMs,
          maxResidentActors: options.maxResidentActors,
        })

        return Layer.mergeAll(
          runtime,
          test.pipe(Layer.provide(runtime)),
          Layer.succeed(CurrentCaller, options.as ?? Anonymous.make({})),
          Layer.succeed(Tenant, tenant),
        ).pipe(
          Layer.provide(hooks),
          Layer.provideMerge(
            options.database !== undefined && Redacted.isRedacted(options.database)
              ? Database.postgres({
                  url: options.database,
                  maxConnections: 10,
                  stream: member?.connect,
                })
              : Database.pglite(options.database),
          ),
        )
      }),
    )
}
