import type { PgClient } from "@effect/sql-pg"
import type { PgliteClient } from "@effect/sql-pglite"
import {
  Context,
  Crypto,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schema,
  Option,
  Predicate,
  Stream,
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
import type { ValueSchema } from "../members/command.ts"
import type { AnyConnection } from "../members/connection.ts"
import { OpenRejected } from "../runtime/connections/holder.ts"
import { ClientMessage } from "../runtime/connections/protocol.ts"
import { type Actors, InternalActors, type Outcome, type Request } from "../handles/actors.ts"
import { Database, layer as runtimeLayer, type Options } from "../runtime/layer.ts"
import { compress, decompress, routingKey } from "../runtime/storage/codec.ts"
import { recordedPlacement } from "../runtime/storage/placements.ts"
import { VERSION_KEY } from "../state/migration.ts"
import { CleanupHooks, RetryTurn, TurnHooks, type TurnPoint } from "../runtime/turn/hooks.ts"
import {
  type ProgressClosed,
  type ProgressMessage,
  ProgressTap,
} from "../runtime/effects/progress.ts"
import { databaseTime, FrameworkClock } from "../runtime/turn/admission.ts"
import type { Swept } from "../runtime/storage/retention.ts"
import { type ClusterOptions, clusterLayer } from "./cluster.ts"
import { type Simulation, type SimulationOptions, simulate } from "./simulate.ts"

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
>()("@durable-actors/core/testing/actor-test/ClusterMember") {}

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
  readonly relay?: Options["relay"]
  readonly executors?: Options["executors"]
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

/** A test client's open connection, as a socket on this runner's transport would see it. */
export interface TestConnection<C extends AnyConnection> {
  readonly connectionId: string
  /** The flushed-through cursor after `open`: events after it were not replayed by `open`. */
  readonly cursor: string
  /** Sends one client frame; it is encoded and numbered like a socket frame. */
  readonly send: (frame: C["client"]["Type"]) => Effect.Effect<void, ActorError>
  /** Server frames in order; fails with the session's end. Control frames are skipped. */
  readonly frames: Stream.Stream<C["server"]["Type"], ActorError>
  /** Every envelope in order, member frames with their cursors and control frames included. */
  readonly messages: Stream.Stream<TestMessage<C["server"]["Type"]>, ActorError>
  /** Answers a `Resync` control frame once the client has caught up. */
  readonly resyncDone: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export type TestMessage<Server> =
  | {
      readonly _tag: "Frame"
      readonly frame: Server
      readonly cursor?: string | undefined
      readonly event?: string | undefined
    }
  | {
      /** Executor progress: display-only, lossy, and never replayed. */
      readonly _tag: "Progress"
      readonly effect: string
      readonly effectId: string
      readonly attempt: number
      readonly seq: number
      /** The frame as the effect's progress schema encodes it to JSON. */
      readonly frame: unknown
    }
  | Exclude<ClientMessage, { readonly _tag: "Frame" | "Progress" }>

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

const valueCodec = (schema: ValueSchema): Schema.Codec<{ readonly value: unknown }, string> =>
  Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: schema })))

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

/**
 * Runs one retention sweep in the current runtime now, as its background loop
 * does every minute; for benchmarks and tests that use the production layer.
 */
export const cleanup: Effect.Effect<Swept, never, InternalActors> = Effect.gen(function* () {
  return yield* (yield* InternalActors).cleanup
})

/** A progress message an executor pool sent, and whether `dropProgress` dropped it. */
export type ProgressRecord = Data.TaggedEnum<{
  Progress: ProgressMessage & { readonly dropped: boolean }
  ProgressClosed: ProgressClosed & { readonly dropped: boolean }
}>

export const ProgressRecord = Data.taggedEnum<ProgressRecord>()

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
    /** Removes every queued `crashNext` and `pauseNext` fault and returns the points they were queued at. */
    readonly clearFaults: Effect.Effect<ReadonlyArray<TurnPoint>>
    readonly invalidate: (ref: ActorRef) => Effect.Effect<void>
    /**
     * Opens a connection to `ref` through this runner's in-process transport,
     * which then holds it. A declared failure of `open` fails with that error.
     */
    readonly connect: <C extends AnyConnection>(
      ref: ActorRef,
      member: C,
      params: C["input"]["Type"],
    ) => Effect.Effect<TestConnection<C>, ActorError | C["errors"][number]["Type"]>
    /** Ends the actor's activation on this runner as `hibernateAfter` would; its connections stay open. */
    readonly hibernate: (ref: ActorRef) => Effect.Effect<void>
    /**
     * Moves the framework clock forward by `duration`, then delivers every
     * intent and timer that is due, including intents those deliveries stage.
     * Command-id expiry, event timestamps, and retention follow the same clock.
     */
    readonly advance: (duration: Duration.Input) => Effect.Effect<void>
    /** The framework clock: database time plus every `advance` so far; `Intent.at` is due against it. */
    readonly now: Effect.Effect<DateTime.Utc>
    /**
     * Runs one retention sweep now, as the runtime does every minute, and
     * returns how many receipts and events it deleted.
     */
    readonly cleanup: Effect.Effect<Swept>
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
    /** Every progress message this runner's executor pool sent, in order. */
    readonly progress: Effect.Effect<ReadonlyArray<ProgressRecord>>
    /**
     * Sends a progress message to its owner again, as a frame the network
     * delayed would arrive; for cases about late progress.
     */
    readonly resendProgress: (message: ProgressMessage) => Effect.Effect<void>
    /** Drops progress messages matching `predicate` between the pool and the owner. */
    readonly dropProgress: (
      predicate: (message: ProgressMessage | ProgressClosed) => boolean,
    ) => Effect.Effect<void>
  }
>()("@durable-actors/core/testing/actor-test/ActorTest") {
  /**
   * Runs `runners` runtimes in this process against one Postgres database,
   * each a distinct Cluster runner with its own address, connection pool, and
   * expiring shard locks. Provides `ActorCluster`; see its controls.
   */
  static readonly cluster = <ROut, E, RIn>(options: ClusterOptions<ROut, E, RIn>) =>
    clusterLayer(options)

  /**
   * Runs `program` on the current test runtime under a fault schedule drawn
   * from `seed`, then checks exactly-once receipts and outbox delivery; a
   * failure dies with the seed that reproduces it.
   */
  static readonly simulate = <E, R>(
    options: SimulationOptions,
    program: (simulation: Simulation) => Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      return yield* simulate(yield* ActorTest)(options, program)
    })

  static readonly layer = (options: TestOptions) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto
        const member = Option.getOrUndefined(yield* Effect.serviceOption(ClusterMember))
        const tenant = member?.tenant ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie))
        const faults = new Map<TurnPoint, Array<Effect.Effect<void>>>()
        // Hooks the caller installed still see every point no fault is queued for.
        const outer = yield* TurnHooks

        let clockOffset = 0
        const progress: Array<ProgressRecord> = []
        let dropProgress: (message: ProgressMessage | ProgressClosed) => boolean = () => false

        const hooks = Layer.mergeAll(
          Layer.succeed(TurnHooks, {
            at: (point, request) =>
              Effect.suspend(() => faults.get(point)?.shift() ?? outer.at(point, request)),
          }),
          Layer.succeed(FrameworkClock, { offsetMillis: () => clockOffset }),
          Layer.succeed(ProgressTap, {
            send: (message) =>
              Effect.sync(() => {
                const dropped = dropProgress(message)
                progress.push(ProgressRecord.Progress({ ...message, dropped }))

                return !dropped
              }),
            closed: (message) =>
              Effect.sync(() => {
                const dropped = dropProgress(message)
                progress.push(ProgressRecord.ProgressClosed({ ...message, dropped }))

                return !dropped
              }),
          }),
          // Tests sweep with `cleanup` when they choose, never on a timer
          // that could fire between a case's `advance` and its assertions.
          Layer.succeed(CleanupHooks, {
            batchSize: 1000,
            afterBatch: Effect.void,
            periodic: false,
          }),
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
              const placement = yield* recordedPlacement(ref.actor).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              )

              if (placement === undefined)
                return yield* Effect.die(new Error(`Actor ${ref.actor} is not registered`))

              return routingKey({ ref, placement })
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
              clearFaults: Effect.sync(() => {
                const left = Array.from(faults, ([point, queue]) => queue.map(() => point)).flat()
                faults.clear()

                return left
              }),
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

                // One statement, so a turn committing meanwhile can't be counted
                // in one table and not the other.
                const [counted] = yield* sql<{ receipts: number; events: number }>`SELECT
                  (SELECT count(*)::integer FROM actor_receipts
                    WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}) AS receipts,
                  (SELECT count(*)::integer FROM actor_events
                    WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}) AS events`

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
                  receipts: counted!.receipts,
                  events: counted!.events,
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

                // Running attempts keep renewing through the jump, so their leases move with it.
                yield* internalActors.extendOutboxLeases(
                  millis,
                  Effect.sync(() => {
                    clockOffset += millis
                  }),
                )
                yield* internalActors.drainOutbox
              }),
              now: databaseTime.pipe(
                Effect.map((millis) => DateTime.makeUnsafe(millis)),
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.provideService(FrameworkClock, { offsetMillis: () => clockOffset }),
                Effect.orDie,
              ),
              cleanup: internalActors.cleanup,
              receiptsFor: Effect.fnUntraced(function* (ref: ActorRef, command: string) {
                const routing = yield* storedRoutingKey(ref)

                const rows = yield* sql<{ count: number }>`
                  SELECT count(*)::integer AS count FROM actor_receipts
                  WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor}
                    AND actor_id = ${ref.id} AND command = ${command}`

                return rows[0]!.count
              }, Effect.orDie),
              connect: Effect.fnUntraced(function* <C extends AnyConnection>(
                ref: ActorRef,
                member: C,
                params: C["input"]["Type"],
              ) {
                const server = valueCodec(member.server)
                const decodeServer = Schema.decodeEffect(server)
                const encodeClient = Schema.encodeEffect(valueCodec(member.client))

                const decodeError = Schema.decodeEffect(
                  Schema.fromJsonString(Schema.toCodecJson(Schema.Union(member.errors))),
                )

                const encoded = yield* Schema.encodeEffect(valueCodec(member.input))({
                  value: params,
                }).pipe(Effect.orDie)

                const held = yield* internalActors.holder
                  .open({
                    ref,
                    member: member.tag,
                    // The caller the test runs as, so `Actor.as` opens as someone else.
                    caller: yield* CurrentCaller,
                    params: encoded,
                  })
                  .pipe(
                    Effect.catchTag("OpenRejected", (rejected: OpenRejected) =>
                      Effect.flatMap(decodeError(rejected.value).pipe(Effect.orDie), (error) =>
                        Effect.fail(error as C["errors"][number]["Type"]),
                      ),
                    ),
                  )

                const messages: Stream.Stream<
                  TestMessage<C["server"]["Type"]>,
                  ActorError
                > = held.messages.pipe(
                  Stream.mapEffect((message): Effect.Effect<TestMessage<C["server"]["Type"]>> =>
                    ClientMessage.guards.Frame(message)
                      ? Effect.map(decodeServer(message.frame).pipe(Effect.orDie), ({ value }) => ({
                          ...message,
                          frame: value as C["server"]["Type"],
                        }))
                      : ClientMessage.guards.Progress(message)
                        ? Effect.map(decodeJson(message.frame).pipe(Effect.orDie), (frame) => ({
                            ...message,
                            frame,
                          }))
                        : Effect.succeed(message),
                  ),
                )

                const connection: TestConnection<C> = {
                  connectionId: held.connectionId,
                  cursor: held.cursor,
                  send: (frame) =>
                    Effect.flatMap(encodeClient({ value: frame }).pipe(Effect.orDie), held.send),
                  frames: messages.pipe(
                    Stream.filter(
                      (
                        message,
                      ): message is Extract<
                        TestMessage<C["server"]["Type"]>,
                        { readonly _tag: "Frame" }
                      > => Predicate.isTagged(message, "Frame"),
                    ),
                    Stream.map((message) => message.frame),
                  ),
                  messages,
                  resyncDone: held.resyncDone,
                  close: held.close,
                }

                return connection
              }) as ActorTest["Service"]["connect"],
              hibernate: internalActors.hibernate,
              invalidate: Effect.fnUntraced(function* (ref: ActorRef) {
                const routing = yield* storedRoutingKey(ref)
                yield* sql`UPDATE actor_generations SET generation = generation + 1
            WHERE routing_key = ${routing} AND tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`
              }, Effect.orDie),
              progress: Effect.sync(() => [...progress]),
              resendProgress: internalActors.deliverProgress,
              dropProgress: (predicate) =>
                Effect.sync(() => {
                  dropProgress = predicate
                }),
            })

            testActors.set(service, internalActors)

            return service
          }),
        )

        const runtime = runtimeLayer({
          authorize: options.authorize ?? (() => Effect.succeed(true)),
          retryWindowMs: options.retryWindowMs,
          maxResidentActors: options.maxResidentActors,
          relay: options.relay,
          executors: options.executors,
        })

        return Layer.mergeAll(
          runtime,
          test.pipe(Layer.provide(runtime)),
          Layer.succeed(CurrentCaller, options.as ?? Anonymous.make({})),
          Layer.succeed(Tenant, tenant),
          // Test code reads the same advanced clock as the runtime, so an id it
          // builds from database time is live in the runtime's eyes too.
          Layer.succeed(FrameworkClock, { offsetMillis: () => clockOffset }),
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
