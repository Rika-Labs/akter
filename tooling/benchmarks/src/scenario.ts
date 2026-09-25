import { BunCrypto } from "@effect/platform-bun"
import { Actors } from "durable-actors/runtime"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { Activity, Backend, Instruments, StatementCount } from "./backend.ts"
import { type Limit, load, now, type Summary, summarize, throughput } from "./measure.ts"
import { ProbeLive } from "./probe/layer.ts"

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
  readonly statements: ReadonlyArray<StatementCount> | null
  readonly activity: Activity | null
  /** CPU use as a percentage of one core over the measured window. */
  readonly cpu: { readonly client: number; readonly server: number | null }
  readonly extra: Readonly<Record<string, number | string>> | null
}

export type ActorServices = Layer.Success<typeof runtimeLayer> | SqlClient.SqlClient

const runtimeLayer = ProbeLive.pipe(
  Layer.provideMerge(Actors.layer({ authorize: () => Effect.succeed(true) })),
  Layer.provide(BunCrypto.layer),
  Layer.orDie,
)

export interface ScenarioContext {
  readonly backend: Backend
  readonly profile: Profile
  /**
   * Runs `body` against a fresh database and a fresh actor runtime, so no
   * case inherits another's activations, caches, or rows.
   */
  readonly withRuntime: <A, E>(
    options: { readonly maxConnections?: number },
    body: (instruments: Instruments | undefined) => Effect.Effect<A, E, ActorServices>,
  ) => Effect.Effect<A, E>
}

export interface Scenario {
  readonly name: string
  readonly description: string
  readonly run: (context: ScenarioContext) => Effect.Effect<ReadonlyArray<CaseResult>>
}

export const DEFAULT_POOL = 10

export const withRuntime =
  (backend: Backend): ScenarioContext["withRuntime"] =>
  (options, body) =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* backend.database({
          maxConnections: options.maxConnections ?? DEFAULT_POOL,
        })

        const services = yield* Layer.build(runtimeLayer.pipe(Layer.provideMerge(database.layer)))

        return yield* body(database.instruments).pipe(Effect.provideContext(services))
      }),
    )

const percent = (seconds: number, elapsedMs: number) =>
  Math.round((seconds / (elapsedMs / 1000)) * 1000) / 10

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
    readonly listStatements?: boolean
    readonly extra?: Readonly<Record<string, number | string>>
  },
) {
  const instruments = options.instruments

  if (instruments !== undefined) yield* instruments.resetStatements
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
  const succeeded = result.samples.length
  const attempted = succeeded + result.errors

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
    statements: options.listStatements === true ? (statements?.top ?? null) : null,
    activity: activity ?? null,
    cpu: {
      client: percent((client.user + client.system) / 1e6, wallMs),
      server:
        serverBefore === undefined || serverAfter === undefined
          ? null
          : percent(serverAfter - serverBefore, wallMs),
    },
    extra: options.extra ?? null,
  } satisfies CaseResult
})
