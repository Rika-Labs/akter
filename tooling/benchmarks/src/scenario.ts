import { BunCrypto } from "@effect/platform-bun"
import { Actors } from "@durable-actors/core/runtime"
import { ActorCluster, ActorTest, CleanupHooks, TurnHooks } from "@durable-actors/core/testing"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { Activity, Backend, Instruments, StatementCount } from "./backend.ts"
import { type Limit, load, now, type Summary, summarize, throughput } from "./measure.ts"
import { queued } from "./probe/turns/batches.ts"
import { afterCommit } from "./probe/effects.ts"
import { ProbeLive } from "./probe/layer.ts"
import { SubscriptionProbeLive, subscriptionCommitted } from "./probe/subscriptions.ts"

export type Profile = "quick" | "full"

export type Parameters = Readonly<Record<string, number | string | boolean>>

export interface CaseResult {
  readonly name: string
  readonly parameters: Parameters
  readonly operations: number
  readonly elapsedMs: number
  /** Successful operations per second. */
  readonly throughput: number
  readonly errors: number
  readonly errorKinds: Readonly<Record<string, number>>
  readonly latencyMs: Summary
  /**
   * Statements pg_stat_statements recorded per attempted operation, without
   * Cluster's runner bookkeeping. It records transaction control (BEGIN,
   * SAVEPOINT, COMMIT) only once per distinct text, so those are not in this
   * count.
   */
  readonly statementsPerOperation: number | null
  /**
   * Round trips turns waited for on their sessions per attempted operation,
   * counted by a relay in front of the turn pool (Postgres only). One round
   * trip carries a whole statement group, so this is what latency pays per
   * operation, apart from the statements the count above records.
   */
  readonly roundTripsPerOperation: number | null
  readonly statements: ReadonlyArray<StatementCount> | null
  readonly activity: Activity | null
  /**
   * CPU use as a percentage of one core over the measured window, and CPU
   * milliseconds per attempted operation.
   */
  readonly cpu: {
    readonly client: number
    readonly server: number | null
    readonly clientMsPerOperation: number | null
    readonly serverMsPerOperation: number | null
  }
  readonly extra: Readonly<Record<string, number | string>> | null
}

export type ActorServices = Layer.Success<ReturnType<typeof runtimeLayer>> | SqlClient.SqlClient

// The effect round trip ends when its route's turn commits, which only the
// runtime's post-commit hook observes, and a turn batch forms once commands
// are in the mailbox, which only the queued point observes; every other
// point stays a no-op.
// Retention sweeps run only when a scenario asks, so a timed sweep never
// lands inside another case's measurement.
const hooks = Layer.mergeAll(
  Layer.succeed(TurnHooks, {
    at: (point, request) => {
      if (point === "afterCommit")
        return Effect.andThen(afterCommit(request), subscriptionCommitted(request))

      if (point === "queued") return queued(request)

      return Effect.void
    },
  }),
  Layer.succeed(CleanupHooks, { batchSize: 1000, afterBatch: Effect.void, periodic: false }),
)

// Subscription probes register only for the cases that use them: a runner
// with a subscriber type adds subscription probes to every relay claim.
const probes = (subscriptions: boolean | undefined) =>
  subscriptions === true ? Layer.merge(ProbeLive, SubscriptionProbeLive) : ProbeLive

const runtimeLayer = (maxResidentActors: number | undefined, subscriptions?: boolean) =>
  probes(subscriptions).pipe(
    Layer.provideMerge(
      Actors.layer({ authorize: () => Effect.succeed(true), maxResidentActors }).pipe(
        Layer.provide(hooks),
      ),
    ),
    Layer.provide(BunCrypto.layer),
    Layer.orDie,
  )

export interface ScenarioContext {
  readonly backend: Backend
  readonly profile: Profile
  /**
   * Runners sharing the case database. Above 1, `withRuntime` starts an
   * `ActorTest.cluster` on Postgres and runs `body` through runner 0; every
   * runner's relay and executors take due work.
   */
  readonly runners: number
  /**
   * Runs `body` against a fresh database and a fresh actor runtime, so no
   * case inherits another's activations, caches, or rows.
   */
  readonly withRuntime: <A, E>(
    options: {
      readonly maxConnections?: number
      readonly maxResidentActors?: number
      /** Registers the subscription probes too. */
      readonly subscriptions?: boolean
    },
    body: (instruments: Instruments | undefined) => Effect.Effect<A, E, ActorServices>,
  ) => Effect.Effect<A, E>
}

export interface Scenario {
  readonly name: string
  readonly description: string
  /** Whether `--runners` above 1 applies; other scenarios run once, on one runner. */
  readonly multiRunner?: boolean
  readonly run: (context: ScenarioContext) => Effect.Effect<ReadonlyArray<CaseResult>>
}

export const DEFAULT_POOL = 10

// Well past a case's length, so no runner's shard locks expire while it runs.
const SHARD_LOCK_EXPIRATION = "30 seconds"

export const withRuntime =
  ({
    backend,
    runners,
  }: {
    readonly backend: Backend
    readonly runners: number
  }): ScenarioContext["withRuntime"] =>
  (options, body) =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* backend.database({
          maxConnections: options.maxConnections ?? DEFAULT_POOL,
        })

        if (runners > 1) {
          if (database.url === undefined)
            return yield* Effect.die(new Error("--runners above 1 needs the postgres backend"))

          const cluster = yield* Layer.build(
            ActorTest.cluster({
              database: database.url,
              runners,
              shardLockExpiration: SHARD_LOCK_EXPIRATION,
              actors: probes(options.subscriptions),
              authorize: () => Effect.succeed(true),
              maxResidentActors: options.maxResidentActors,
            }).pipe(Layer.provide([BunCrypto.layer, hooks])),
          ).pipe(Effect.orDie)

          return yield* ActorCluster.use((actors) => actors.on(0)(body(database.instruments))).pipe(
            Effect.provideContext(cluster),
          )
        }

        const services = yield* Layer.build(
          runtimeLayer(options.maxResidentActors, options.subscriptions).pipe(
            Layer.provideMerge(database.layer),
          ),
        )

        return yield* body(database.instruments).pipe(Effect.provideContext(services))
      }),
    )

const percent = (seconds: number, elapsedMs: number) =>
  Math.round((seconds / (elapsedMs / 1000)) * 1000) / 10

const listed = (
  list: boolean | { readonly including: string } | undefined,
  statements:
    | { readonly top: ReadonlyArray<StatementCount>; readonly all: ReadonlyArray<StatementCount> }
    | undefined,
) => {
  if (list === undefined || list === false || statements === undefined) return null

  if (list === true) return statements.top

  return [
    ...statements.top,
    ...statements.all
      .slice(statements.top.length)
      .filter((statement) => statement.query.includes(list.including)),
  ]
}

/**
 * Measures one case: resets statement counters, samples connection activity,
 * runs the load, and reports latency, throughput, statements per operation,
 * and client and server CPU.
 */
export const measure = Effect.fnUntraced(function* <E, R>(
  options: Limit & {
    readonly name: string
    readonly parameters: Parameters
    readonly instruments: Instruments | undefined
    readonly workers: number
    readonly operation: (index: number) => Effect.Effect<unknown, E, R>
    /** Lists the 16 most-called statements, plus every statement containing `including`. */
    readonly listStatements?: boolean | { readonly including: string }
    readonly extra?: Readonly<Record<string, number | string>>
  },
) {
  const instruments = options.instruments

  if (instruments !== undefined) {
    yield* instruments.resetStatements
    yield* instruments.resetFlights
  }

  const serverCpu = instruments?.serverCpuSeconds
  const serverBefore = serverCpu === undefined ? undefined : yield* serverCpu
  const clientBefore = process.cpuUsage()
  const started = yield* now

  const run = load(options)

  const [result, activity] =
    instruments === undefined ? [yield* run, undefined] : yield* instruments.sampleActivity(run)

  const wallMs = (yield* now) - started
  const client = process.cpuUsage(clientBefore)
  const serverAfter = serverCpu === undefined ? undefined : yield* serverCpu
  const statements = instruments === undefined ? undefined : yield* instruments.statements
  const flights = instruments === undefined ? undefined : yield* instruments.flights
  const succeeded = result.samples.length
  const attempted = succeeded + result.errors

  const clientSeconds = (client.user + client.system) / 1e6

  const serverSeconds =
    serverBefore === undefined || serverAfter === undefined ? undefined : serverAfter - serverBefore

  const perOperation = (seconds: number | undefined) =>
    seconds === undefined || attempted === 0 ? null : Math.round((seconds * 1e6) / attempted) / 1000

  return {
    name: options.name,
    parameters: options.parameters,
    operations: succeeded,
    elapsedMs: Math.round(result.elapsedMs),
    throughput: throughput(result),
    errors: result.errors,
    errorKinds: result.errorKinds,
    latencyMs: summarize(result.samples),
    statementsPerOperation:
      statements === undefined || attempted === 0
        ? null
        : Math.round((statements.calls / attempted) * 100) / 100,
    roundTripsPerOperation:
      flights === undefined || attempted === 0
        ? null
        : Math.round((flights / attempted) * 100) / 100,
    statements: listed(options.listStatements, statements),
    activity: activity ?? null,
    cpu: {
      client: percent(clientSeconds, wallMs),
      server: serverSeconds === undefined ? null : percent(serverSeconds, wallMs),
      clientMsPerOperation: perOperation(clientSeconds),
      serverMsPerOperation: perOperation(serverSeconds),
    },
    extra: options.extra ?? null,
  } satisfies CaseResult
})
