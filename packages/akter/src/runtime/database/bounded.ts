import { PgClient, PgPool } from "@effect/sql-pg"
import type { PgConnection } from "@effect/sql-pg"
import { Context, Duration, Effect, Layer, Redacted, Schedule, Schema, Scope } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient, SqlError, Statement } from "effect/sql"
import type { SqlConnection } from "effect/sql"
import { admissionLimit, isOverloaded } from "../admission.ts"
import { ActorError } from "../../errors/actor.ts"
import { asSqlConnection } from "./connection.ts"
import { fairGate } from "./gate.ts"
import { Authority, isShardUid, targetShard } from "./shards.ts"

/** Extra checkouts each pool holds beyond its connections before refusing further work. */
export const POOL_WAITERS = 64

/** SQL-compatible overload keeps caller-facing reads retryable without exposing the internal cause. */
export const poolRefusal = (cause: unknown) =>
  SqlError.SqlError.make({
    reason: SqlError.ConnectionError.make({ cause, message: "Postgres pool admission is full" }),
  })

/** Recognizes only our pre-statement checkout refusal, never a failed statement or unknown commit. */
export const isPoolRefusal = (cause: unknown) =>
  SqlError.isSqlError(cause) &&
  Schema.is(ActorError)(cause.reason.cause) &&
  isOverloaded(cause.reason.cause)

/** Retries a pre-statement checkout refusal for scoped startup and background work. */
export const retryPoolRefusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: isPoolRefusal,
      schedule: Schedule.min([Schedule.exponential("10 millis", 2), Schedule.spaced("250 millis")]),
    }),
  )

/** Postgres can answer COMMIT with ROLLBACK when a transaction has already aborted. */
const commit = (connection: SqlConnection.Connection) =>
  Effect.flatMap(connection.executeRaw("COMMIT", []), (result) =>
    (result as { readonly command?: string }).command === "ROLLBACK"
      ? Effect.fail(
          SqlError.SqlError.make({
            reason: SqlError.UnknownError.make({
              cause: new Error("COMMIT rolled back an aborted transaction"),
              message: "PgClient: COMMIT rolled back an aborted transaction",
              operation: "commit",
            }),
          }),
        )
      : Effect.void,
  )

const PgJson = Statement.custom<Statement.Custom<"PgJson", unknown>>("PgJson")

const direct = <A>(statement: Effect.Effect<A, SqlError.SqlError>) => statement

/** One pool's checkouts, each through the pool's admission and fair gate. */
interface Sessions {
  readonly acquire: Effect.Effect<SqlConnection.Connection, SqlError.SqlError, Scope.Scope>
  readonly reserve: Effect.Effect<SqlConnection.Connection, SqlError.SqlError, Scope.Scope>
  readonly borrow: <A, E, R>(
    use: (connection: SqlConnection.Connection) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError.SqlError, R>
  readonly listen: (
    channel: string,
  ) => Effect.Effect<
    Effect.Success<ReturnType<PgConnection.PgConnection["listen"]>>,
    SqlError.SqlError,
    Scope.Scope
  >
}

/**
 * A checkout passes three stages in order: the bounded admission slot,
 * refused at once past the limit; a first-come, first-served gate with one
 * slot per connection, so a caller never waits behind one that asked after
 * it, which Effect's pool allows because it hands a freed connection to
 * whichever fiber asks next; then the pool, which therefore never has a
 * waiter of its own. Both slots belong to the checkout's scope, or to the
 * borrowed statement, and return with the connection, so cancellation never
 * leaks either.
 */
const boundedSessions = Effect.fnUntraced(function* (options: PgClient.PgPoolConfig) {
  const pool = yield* PgPool.make(options)
  const slots = options.maxConnections ?? 10
  const admission = admissionLimit({ limit: slots + POOL_WAITERS, wait: Duration.zero })
  const fair = fairGate(slots)
  const enter = Effect.andThen(admission.take.pipe(Effect.mapError(poolRefusal)), fair.take)
  const connection = (session: Effect.Success<typeof pool.get>) =>
    asSqlConnection({ connection: session, send: direct })

  return {
    acquire: Effect.andThen(enter, Effect.map(pool.get, connection)),
    reserve: Effect.andThen(enter, Effect.map(pool.reserve, connection)),
    borrow: (use) =>
      admission
        .admit(fair.use(pool.use((session) => use(connection(session)))))
        .pipe(
          Effect.mapError((error) => (Schema.is(ActorError)(error) ? poolRefusal(error) : error)),
        ),
    listen: (channel) =>
      Effect.andThen(
        enter,
        Effect.flatMap(pool.reserve, (session) => session.listen(channel)),
      ),
  } satisfies Sessions
})

/**
 * `PgClient.make` over `sessions`: the same compiler, transforms, span
 * attributes, commit check, savepoint release, JSON fragments, and
 * notifications, which use a checkout of their own rather than the caller's
 * transaction. `sessions` is read at each checkout, so one client can reach
 * a different pool per caller. A statement inside a transaction reuses its
 * connection and takes no checkout.
 */
const clientOver = Effect.fnUntraced(function* (
  options: PgClient.PgPoolConfig,
  sessions: Effect.Effect<Sessions>,
) {
  const acquire = Effect.flatMap(sessions, (pool) => pool.acquire)
  const sql = yield* SqlClient.make({
    acquirer: acquire,
    transactionAcquirer: Effect.flatMap(sessions, (pool) => pool.reserve),
    borrower: (use) => Effect.flatMap(sessions, (pool) => pool.borrow(use)),
    compiler: PgClient.makeCompiler(options.transformQueryNames, options.transformJson),
    spanAttributes: [
      ...(options.spanAttributes === undefined ? [] : Object.entries(options.spanAttributes)),
      ["db.system.name", "postgresql"],
      ["db.namespace", options.database ?? options.username ?? "postgres"],
      ["server.address", options.host ?? "localhost"],
      ["server.port", options.port ?? 5432],
    ],
    transformRows:
      options.transformResultNames === undefined
        ? undefined
        : Statement.defaultTransforms(options.transformResultNames, options.transformJson).array,
    prepareTransactionControls: true,
    commit,
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
  })

  return Object.assign(sql, {
    [PgClient.TypeId]: PgClient.TypeId,
    config: options,
    json: ((value) => Statement.fragment([PgJson(value)])) satisfies PgClient.PgClient["json"],
    listen: (channel: string) => Effect.flatMap(sessions, (pool) => pool.listen(channel)),
    notify: (channel: string, payload: string) => {
      if (new TextEncoder().encode(channel).byteLength > 63) {
        const message = "PostgreSQL channel names must not exceed 63 UTF-8 bytes"
        return Effect.fail(
          SqlError.SqlError.make({
            reason: SqlError.UnknownError.make({
              cause: new Error(message),
              message,
              operation: "notify",
            }),
          }),
        )
      }

      return Effect.asVoid(
        Effect.scoped(
          Effect.flatMap(acquire, (conn) =>
            conn.executeRaw("SELECT pg_notify($1, $2)", [channel, payload]),
          ),
        ),
      )
    },
  }) satisfies PgClient.PgClient
})

/**
 * The native Postgres client with at most 64 queued checkouts beyond its
 * connection capacity, handing its connections out first come, first served.
 * All SQL entry points share admission, including reservations,
 * transactions, streams and listeners; bounding only command dispatch would
 * leave queries and background callers able to grow the pool's waiter list.
 * A refused checkout sent no statement.
 */
export const boundedPool = Effect.fnUntraced(function* (options: PgClient.PgPoolConfig) {
  return yield* clientOver(options, Effect.succeed(yield* boundedSessions(options)))
})

/**
 * `options` with every session targeted at `shard` from its startup packet,
 * so no statement can reach the session before its target is set, and a
 * `RESET` or a failed `SET` cannot leave it untargeted. The URL's own
 * startup options are kept.
 */
export const targetedAt = <C extends PgClient.PgClientConfig>({
  options,
  shard,
}: {
  readonly options: C
  readonly shard: string
}): C => {
  if (!isShardUid(shard)) throw new Error(`Shard UID ${JSON.stringify(shard)} needs quoting`)

  const fromUrl =
    options.url === undefined
      ? null
      : new URL(Redacted.value(options.url)).searchParams.get("options")

  return {
    ...options,
    startupOptions: [options.startupOptions ?? fromUrl, `-c __neki.shard=${shard}`]
      .filter((part) => part !== null && part !== undefined && part !== "")
      .join(" "),
  }
}

/**
 * Lazily opened pools, one per shard, in `scope`. Each is opened once, on
 * the first checkout that names its shard, and lives until `scope` closes.
 */
export const perShard = <A, E>({
  scope,
  open,
}: {
  readonly scope: Scope.Scope
  readonly open: (shard: string) => Effect.Effect<A, E, Scope.Scope>
}) => {
  const opened = new Map<string, Effect.Effect<A, E>>()

  return (shard: string): Effect.Effect<A, E> => {
    const found = opened.get(shard)

    if (found !== undefined) return found

    const once = Effect.runSync(Effect.cached(Scope.provide(open(shard), scope)))
    opened.set(shard, once)

    return once
  }
}

/**
 * The bounded client whose checkouts follow the caller's `ShardTarget`: a
 * fiber with no target uses the pool of `options`, which reaches the
 * authoritative group through the router, and a targeted fiber uses a pool of
 * the same size whose sessions target its shard. A transaction keeps the
 * session it began on. `authority` is a separate client over the untargeted
 * pool, with its own transactions, for authoritative statements made from a
 * targeted fiber.
 */
export const routedPool = Effect.fnUntraced(function* (options: PgClient.PgPoolConfig) {
  const scope = yield* Effect.scope
  const authority = yield* boundedSessions(options)
  const shard = perShard({
    scope,
    open: (target) => boundedSessions(targetedAt({ options, shard: target })),
  })
  const sessions = Effect.flatMap(targetShard, (target) =>
    target === undefined ? Effect.succeed(authority) : Effect.orDie(shard(target)),
  )

  return {
    sql: yield* clientOver(options, sessions),
    authority: yield* clientOver(options, Effect.succeed(authority)),
  }
})

/** Provides the bounded primary/off-turn client without changing its connection configuration. */
export const boundedLayer = (options: PgClient.PgPoolConfig) =>
  PgClient.layerFrom(boundedPool(options))

/** Provides the routed off-turn client as the default client and its authority sessions as `Authority`. */
export const routedLayer = (options: PgClient.PgPoolConfig) =>
  Layer.effectContext(
    Effect.map(routedPool(options), ({ sql, authority }) =>
      Context.make(PgClient.PgClient, sql).pipe(
        Context.add(SqlClient.SqlClient, sql),
        Context.add(Authority, authority),
      ),
    ),
  ).pipe(Layer.provide(Reactivity.layer))
