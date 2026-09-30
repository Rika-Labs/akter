import { Effect, Layer, Logger, ManagedRuntime, Option, type Crypto, type Scope } from "effect"
import { constVoid } from "effect/Function"
import type { Redacted } from "effect"
import type { HttpServer } from "effect/unstable/http"
import { type SqlClient, Statement } from "effect/unstable/sql"
import type { Actors } from "../index.ts"
import { User } from "../index.ts"
import { principal } from "../identity/caller.ts"
import type { InternalActors } from "../runtime/actors.ts"
import type { RuntimeControl } from "../runtime/drain.ts"
import type { OperatorRuntime } from "../runtime/operators/repair.ts"
import type { Request } from "../runtime/request.ts"
import {
  ContentHooks,
  type ContentPoint,
  TurnHooks,
  type TurnPoint,
} from "../runtime/turn/hooks.ts"
import { NekiTurnSessions } from "../runtime/database/neki/session.ts"
import type { ContentStore } from "../handles/content.ts"
import type { Options } from "../runtime/layer.ts"
import { ActorTest } from "./actor-test.ts"
import type { ConformanceEdge } from "./conformance/assertions.ts"
import { accessConformance, accessSuite } from "./conformance/access.ts"
import { admissionConformance, admissionSuite } from "./conformance/admission.ts"
import { adoptionConformance } from "./conformance/adoption.ts"
import {
  assertionsConformance,
  assertionsSuite,
  edgeConformance,
} from "./conformance/assertions.ts"
import { batchesConformance, batchesSuite } from "./conformance/batches.ts"
import { blobsConformance, blobsSuite } from "./conformance/blobs.ts"
import { capacityConformance } from "./conformance/capacity.ts"
import { clientConformance, clientSuite } from "./conformance/client.ts"
import {
  coldServeConformance,
  coldServeEdgeConformance,
  coldServeSuite,
} from "./conformance/cold-serve.ts"
import { connectionsConformance } from "./conformance/connections.ts"
import { connectionsSuite } from "./conformance/connections/actors.ts"
import { contentConformance, contentSuite } from "./conformance/content-blobs.ts"
import { counterConformance, counterSuite } from "./conformance/counter.ts"
import { cronClusterConformance, cronConformance } from "./conformance/cron.ts"
import { drainConformance, drainSuite } from "./conformance/drain.ts"
import {
  effectControlClusterConformance,
  effectControlConformance,
  effectControlSuite,
} from "./conformance/effect-control.ts"
import { effectsConformance, effectsSuite } from "./conformance/effects.ts"
import { eventsConformance, eventsSuite } from "./conformance/events.ts"
import { exportConformance } from "./conformance/export.ts"
import { fleetConformance, fleetSuite } from "./conformance/fleet.ts"
import { heapConformance } from "./conformance/heap.ts"
import { httpConformance, httpSuite } from "./conformance/http.ts"
import { inspectionViewsConformance, inspectionViewsSuite } from "./conformance/inspection-views.ts"
import { inspectorConformance, inspectorSuite } from "./conformance/inspector.ts"
import { mintConformance, mintSuite } from "./conformance/mint.ts"
import { multiRunnerConformance } from "./conformance/multi-runner.ts"
import { observabilityConformance } from "./conformance/observability.ts"
import { offlineConformance, offlineSuite } from "./conformance/offline.ts"
import { operatorConformance } from "./conformance/operator.ts"
import { crossShardOutboxConformance, crossShardSuite } from "./conformance/outbox-cross-shard.ts"
import { outboxConformance, outboxSuite } from "./conformance/outbox.ts"
import { payloadMigrationsConformance } from "./conformance/payload-migrations.ts"
import { pipelineConformance } from "./conformance/pipeline.ts"
import { placementConformance, placementSuite } from "./conformance/placement.ts"
import {
  progressConformance,
  progressDeliveryConformance,
  progressSuite,
} from "./conformance/progress.ts"
import { propertiesConformance, propertiesSuite } from "./conformance/properties.ts"
import { protocolsConformance, protocolsSuite } from "./conformance/protocols.ts"
import { readYourWritesConformance, readYourWritesSuite } from "./conformance/read-your-writes.ts"
import { reducerConformance, reducerSuite } from "./conformance/reducers.ts"
import { relayClusterConformance, relayConformance, relaySuite } from "./conformance/relay.ts"
import { restoreConformance, restoreSuite } from "./conformance/restore.ts"
import { retentionConformance, retentionSuite } from "./conformance/retention.ts"
import { rlsConformance } from "./conformance/rls.ts"
import { simulationConformance } from "./conformance/simulation.ts"
import { singleShardConformance } from "./conformance/single-shard.ts"
import { singletonConformance } from "./conformance/singleton.ts"
import { streamsConformance, streamsSuite } from "./conformance/streams.ts"
import { subscriptionsConformance } from "./conformance/subscriptions.ts"
import { subscriptionsSuite } from "./conformance/subscriptions/actors.ts"
import { subscriptionsClusterConformance } from "./conformance/subscriptions/cluster.ts"
import { subscriptionsRetentionConformance } from "./conformance/subscriptions/retention.ts"
import { tablesConformance, tablesSuite } from "./conformance/tables.ts"
import { transportsConformance } from "./conformance/transports.ts"
import { transportsSuite } from "./conformance/transports/actors.ts"
import { watchConformance, watchSuite } from "./conformance/watch.ts"
import { workflowVersionsConformance } from "./conformance/workflow-versions.ts"
import { workflowsConformance } from "./conformance/workflows.ts"
import { workflowsSuite } from "./conformance/workflows/actors.ts"
import { engineCases } from "./conformance/workflow-engine.ts"
import { foundationConformance, foundationSuite } from "./foundation.ts"

/**
 * Assertions injected by the test framework running the suite, e.g. Vitest's
 * `expect`. The framework itself is never imported here.
 */
export interface ConformanceMatchers {
  readonly not: ConformanceMatchers
  readonly toBe: <T>(expected: T) => void
  readonly toEqual: <T>(expected: T) => void
  readonly toContain: <T>(expected: T) => void
  readonly toMatchObject: <T extends object | ReadonlyArray<unknown>>(expected: T) => void
  readonly toBeInstanceOf: <T>(expected: T) => void
}

export type ConformanceExpect = <T>(actual: T) => ConformanceMatchers

/**
 * The subset of `describe`/`it`/lifecycle a registrar must supply. Vitest's
 * exported functions satisfy this shape.
 */
export interface ConformanceRegistrar {
  readonly describe: (name: string, body: () => void) => void
  /**
   * Registers one case. A runner that aborts `signal` when the case times
   * out or is cancelled, as Vitest does, interrupts the case's effects so
   * their finalizers run before the next case starts.
   */
  readonly it: (
    name: string,
    body: (context: { readonly signal?: AbortSignal | undefined }) => Promise<void>,
    timeout?: number,
  ) => void
  readonly beforeAll: (body: () => Promise<void> | void, timeout?: number) => void
  readonly afterAll: (body: () => Promise<void> | void) => void
  readonly expect: ConformanceExpect
  /** Registers an inapplicable case by name so it is reported, never silently dropped. */
  readonly skip: (name: string) => void
}

export type ConformanceDatabase = NonNullable<
  NonNullable<Parameters<typeof ActorTest.layer>[0]>["database"]
>

export interface ConformanceConnection {
  readonly query: (
    statement: string,
    parameters?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<unknown>>
}

/** Services every `environment.run` effect may require; Scope is provided. */
export type ConformanceServices =
  | Actors
  | InternalActors
  | RuntimeControl
  | ActorTest
  | SqlClient.SqlClient
  | Crypto.Crypto
  | ContentStore
  | OperatorRuntime

export type ConformanceRuntime = ManagedRuntime.ManagedRuntime<ConformanceServices, never>

export interface ConformanceEnvironment {
  /** Runs an effect against the current runtime. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, ConformanceServices | Scope.Scope>) => Promise<A>
  /** Builds a new runtime without installing it; warm it explicitly. */
  readonly build: (options?: {
    readonly retryWindowMs?: number
    readonly database?: ConformanceDatabase
    /** Queries read this streaming replica of `database` once it has caught up. */
    readonly replica?: Redacted.Redacted<string> | undefined
    readonly content?: Options["content"]
    /**
     * Sees every statement the runtime compiles, from any fiber. It replaces
     * the current statement transformer of every fiber the runtime starts, so
     * a case that installs its own on a caller cannot share the runtime.
     */
    readonly observe?: (statement: Statement.Statement<unknown>) => void
  }) => ConformanceRuntime
  /** Stops the current runtime; the retained database survives. */
  readonly stop: Effect.Effect<void>
  /** Restarts the current runtime against the retained database. */
  readonly restart: Effect.Effect<void>
  /**
   * A second database untouched by the current runtime, for isolation cases.
   * Only a case that declares `requiresFreshDatabase` may open one.
   */
  readonly freshDatabase: Effect.Effect<ConformanceDatabase>
  /**
   * Copies the retained database whole, as a backup of a stopped deployment
   * would, into a new database no runtime has opened. Requires `stop` first,
   * and a case that declares `requiresFreshDatabase`.
   */
  readonly snapshot: Effect.Effect<ConformanceDatabase>
  /**
   * Opens an independent SQL connection to the same database. Only present
   * when the backend advertises `independentConnections`.
   */
  readonly connect?: Effect.Effect<ConformanceConnection, never, Scope.Scope>
  /** The retained database on a streaming replica; only present when the backend has one. */
  readonly replica?: ConformanceReplica | undefined
  /** A fresh listening HTTP server that supports WebSocket upgrades; each build listens anew. */
  readonly httpServer: Layer.Layer<HttpServer.HttpServer>
  /** The hosted edge under test, when the backend supplies one. */
  readonly edge?: ConformanceEdge
}

/** A physical streaming replica of the backend's Postgres primary. */
export interface ConformanceReplica {
  /** The retained database's connection string on the replica. */
  readonly database: Redacted.Redacted<string>
  /** A superuser connection to the replica, e.g. to pause and resume WAL replay. */
  readonly connect: Effect.Effect<ConformanceConnection, never, Scope.Scope>
}

export interface ConformanceBackend {
  /** True when the backend can open concurrent SQL connections (real Postgres). */
  readonly independentConnections: boolean
  /** True when `open` returns a streaming replica of the primary. */
  readonly hasReplica?: boolean
  /**
   * True when the database is a Neki router. Turn sessions then run in
   * single transaction mode and single fanout, and the cases flagged
   * `requiresNeki` run; every other backend reports them through
   * `registrar.skip`.
   */
  readonly neki?: boolean
  /** True when the server runs `wal_level=logical`, which fleet views need. */
  readonly logicalDecoding?: boolean
  /**
   * True when `open` can create further databases and snapshots; cases that
   * declare `requiresFreshDatabase` are reported through `registrar.skip`
   * otherwise.
   */
  readonly freshDatabases: boolean
  /** Extra services merged into every test runtime, e.g. BunCrypto.layer. */
  readonly services: Layer.Layer<Crypto.Crypto, never, never>
  /**
   * A listening HTTP server on an ephemeral loopback port that supports
   * WebSocket upgrades, e.g. `BunHttpServer.layerServer({ port: 0 })`; the
   * served-transport cases build one per case.
   */
  readonly httpServer: Layer.Layer<HttpServer.HttpServer>
  /**
   * A hosted edge to run the edge half of the assertion cases against; a
   * backend without one reports those cases through `registrar.skip`.
   */
  readonly edge?: ConformanceEdge
  readonly open: () => Promise<{
    readonly database: ConformanceDatabase
    readonly freshDatabase: Effect.Effect<ConformanceDatabase>
    /** Copies a database that no runtime has open into a new one. */
    readonly copy: (database: ConformanceDatabase) => Effect.Effect<ConformanceDatabase>
    readonly connect?: Effect.Effect<ConformanceConnection, never, Scope.Scope>
    readonly replica?: ConformanceReplica | undefined
    readonly close: Effect.Effect<void>
  }>
}

/**
 * The test authorization every conformance runtime applies. The harness
 * resets it before each case, so a case that times out holding it closed
 * does not deny the next one.
 */
export interface ConformanceAccess {
  allowed: boolean
  /** Commands the test authorization refuses while `allowed` holds. */
  readonly denied: Set<string>
  /** Principals that lost access: refused as callers and as `onBehalfOf`, as an application would. */
  readonly revoked: Set<string>
}

/**
 * The actors and mutable fixture a group of cases owns. A registration builds
 * each selected suite, and every suite it `uses`, once: its fixture when the
 * registration starts and its layer into every runtime the registration
 * builds. Suites without a fixture receive `undefined`.
 */
export interface ConformanceSuite<F = undefined> {
  readonly fixture?: () => F
  /** Declared as a method so its parameter stays bivariant and any suite fits `ConformanceSuite<unknown>`. */
  layer?(fixture: F): Layer.Layer<never, unknown, ConformanceSuiteServices>
  /** Other suites whose actors this suite's cases call. */
  readonly uses?: ReadonlyArray<ConformanceSuite<unknown>>
  /** Runs at every turn fault point, as the process-level `TurnHooks`. */
  turn?(fixture: F): (point: TurnPoint, request: Request) => Effect.Effect<void>
  /** Runs at every content-store fault point, as `ContentHooks`. */
  content?(fixture: F): (point: ContentPoint) => Effect.Effect<void>
  /** Receives every log line the runtimes write; conformance runtimes print none. */
  logger?(fixture: F): Logger.Logger<unknown, void>
}

/** Services a suite's layer may require: what `ActorTest.layer` and the backend provide. */
export type ConformanceSuiteServices =
  | Layer.Success<ReturnType<typeof ActorTest.layer>>
  | Crypto.Crypto

export interface ConformanceContext<F = undefined> {
  readonly expect: ConformanceExpect
  readonly environment: ConformanceEnvironment
  /** The fixture of the suite that owns the case. */
  readonly fixture: F
  readonly access: ConformanceAccess
  /** The fixture of a suite the case's own suite `uses`. */
  readonly fixtureOf: <G>(suite: ConformanceSuite<G>) => G
}

export interface ConformanceCase<F = undefined> {
  readonly name: string
  /**
   * Requires `backend.independentConnections`; backends without it register
   * the case through `registrar.skip` instead of running it.
   */
  readonly requiresIndependentConnections?: boolean
  /** Requires a streaming replica; backends without one skip the case. */
  readonly requiresReplica?: boolean
  /** Requires `backend.edge`; backends without one register the case through `registrar.skip`. */
  readonly requiresEdge?: boolean
  /** Requires `backend.neki`; every other backend registers the case through `registrar.skip`. */
  readonly requiresNeki?: boolean
  /** Requires a server with `wal_level=logical`; backends without one skip the case. */
  readonly requiresLogicalDecoding?: boolean
  /**
   * Opens `environment.freshDatabase` or `environment.snapshot`. Only a case
   * that declares it may, and backends without `freshDatabases` skip it.
   */
  readonly requiresFreshDatabase?: boolean
  /** Declared as a method so its parameter stays bivariant and any case fits `ConformanceCase<unknown>`. */
  run(context: ConformanceContext<F>): Promise<void>
  readonly timeoutMs?: number
}

/** A named group's cases and the suite that owns their actors and fixture. */
export interface ConformanceGroupCases<F = unknown> {
  readonly suite: ConformanceSuite<F>
  readonly cases: ReadonlyArray<ConformanceCase<F>>
}

const group = <F>(
  suite: ConformanceSuite<F>,
  cases: ReadonlyArray<ConformanceCase<F>>,
): ConformanceGroupCases => ({ suite, cases })

/** Cases whose own actors, if any, they build into their own runtimes or clusters. */
const standalone: ConformanceSuite = {}

/**
 * Every suite in the registry. The single-shard case checks the routing of
 * every statement the framework issues, so it needs every feature's actors
 * registered, as a deployment of all of them would.
 */
const everySuite: ConformanceSuite = {
  get uses() {
    return [...new Set(allGroups.map((group) => conformanceGroups[group].suite))].filter(
      (suite) => suite !== everySuite,
    )
  },
}

/**
 * Every conformance case, grouped by the file that owns it, with the suite
 * that owns its actors. `describeConformance` runs a subset through `groups`,
 * so a group can run in its own Vitest file and worker; `conformance` is
 * their union and the order within a group is kept.
 */
export const conformanceGroups = {
  foundation: group(foundationSuite, foundationConformance),
  access: group(accessSuite, accessConformance),
  admission: group(admissionSuite, admissionConformance),
  http: group(httpSuite, httpConformance),
  protocols: group(protocolsSuite, protocolsConformance),
  assertions: group(assertionsSuite, assertionsConformance),
  edge: group(assertionsSuite, edgeConformance),
  coldServeEdge: group(coldServeSuite, coldServeEdgeConformance),
  client: group(clientSuite, clientConformance),
  offline: group(offlineSuite, offlineConformance),
  capacity: group(standalone, capacityConformance),
  heap: group(standalone, heapConformance),
  events: group(eventsSuite, eventsConformance),
  reducer: group(reducerSuite, reducerConformance),
  outbox: group(outboxSuite, outboxConformance),
  tables: group(tablesSuite, tablesConformance),
  effects: group(effectsSuite, effectsConformance),
  progress: group(progressSuite, progressConformance),
  multiRunner: group(standalone, multiRunnerConformance),
  simulation: group(standalone, simulationConformance),
  drain: group(drainSuite, drainConformance),
  pipeline: group(standalone, pipelineConformance),
  batches: group(batchesSuite, batchesConformance),
  relay: group(relaySuite, relayConformance),
  relayCluster: group(relaySuite, relayClusterConformance),
  effectControl: group(effectControlSuite, effectControlConformance),
  effectControlCluster: group(effectControlSuite, effectControlClusterConformance),
  singleton: group(standalone, singletonConformance),
  cron: group(standalone, cronConformance),
  cronCluster: group(standalone, cronClusterConformance),
  blobs: group(blobsSuite, blobsConformance),
  inspectionViews: group(inspectionViewsSuite, inspectionViewsConformance),
  inspector: group(inspectorSuite, inspectorConformance),
  rls: group(standalone, rlsConformance),
  retention: group(retentionSuite, retentionConformance),
  restore: group(restoreSuite, restoreConformance),
  workflows: group(workflowsSuite, workflowsConformance),
  connections: group(connectionsSuite, connectionsConformance),
  streams: group(streamsSuite, streamsConformance),
  progressDelivery: group(progressSuite, progressDeliveryConformance),
  transports: group(transportsSuite, transportsConformance),
  workflowVersions: group(standalone, workflowVersionsConformance),
  payloadMigrations: group(standalone, payloadMigrationsConformance),
  subscriptions: group(subscriptionsSuite, subscriptionsConformance),
  subscriptionsRetention: group(subscriptionsSuite, subscriptionsRetentionConformance),
  subscriptionsCluster: group(subscriptionsSuite, subscriptionsClusterConformance),
  content: group(contentSuite, contentConformance),
  counter: group(counterSuite, counterConformance),
  properties: group(propertiesSuite, propertiesConformance),
  mint: group(mintSuite, mintConformance),
  readYourWrites: group(readYourWritesSuite, readYourWritesConformance),
  observability: group(standalone, observabilityConformance),
  operator: group(standalone, operatorConformance),
  export: group(standalone, exportConformance),
  coldServe: group(coldServeSuite, coldServeConformance),
  placement: group(placementSuite, placementConformance),
  watch: group(watchSuite, watchConformance),
  adoption: group(standalone, adoptionConformance),
  singleShard: group(everySuite, singleShardConformance),
  crossShardOutbox: group(crossShardSuite, crossShardOutboxConformance),
  fleet: group(fleetSuite, fleetConformance),
} satisfies Record<string, ConformanceGroupCases>

export type ConformanceGroup = keyof typeof conformanceGroups

const allGroups = Object.keys(conformanceGroups) as ReadonlyArray<ConformanceGroup>

/**
 * The shared durable-turn conformance cases. Cases flagged
 * `requiresIndependentConnections` need real Postgres: a second database
 * connection to read committed state while a turn holds its transaction open
 * or to take a competing row lock, or a database outside the JavaScript heap
 * they measure. They never run on single-connection backends such as PGlite.
 */
export const conformance: ReadonlyArray<ConformanceCase<unknown>> = allGroups.flatMap(
  (name) => conformanceGroups[name].cases,
)

/** A backend capability a case can require, as `ConformanceCase` flags name it. */
export type ConformanceRequirement =
  | "independentConnections"
  | "replica"
  | "edge"
  | "neki"
  | "logicalDecoding"
  | "freshDatabase"

/** The capabilities `conformanceCase` requires, in a fixed order. */
export const requirementsOf = (
  conformanceCase: ConformanceCase<unknown>,
): ReadonlyArray<ConformanceRequirement> => [
  ...(conformanceCase.requiresIndependentConnections === true
    ? (["independentConnections"] as const)
    : []),
  ...(conformanceCase.requiresReplica === true ? (["replica"] as const) : []),
  ...(conformanceCase.requiresEdge === true ? (["edge"] as const) : []),
  ...(conformanceCase.requiresNeki === true ? (["neki"] as const) : []),
  ...(conformanceCase.requiresLogicalDecoding === true ? (["logicalDecoding"] as const) : []),
  ...(conformanceCase.requiresFreshDatabase === true ? (["freshDatabase"] as const) : []),
]

/** The capabilities `backend` provides. */
export const capabilitiesOf = (
  backend: Pick<
    ConformanceBackend,
    "independentConnections" | "hasReplica" | "edge" | "neki" | "logicalDecoding" | "freshDatabases"
  >,
): ReadonlySet<ConformanceRequirement> =>
  new Set<ConformanceRequirement>([
    ...(backend.independentConnections ? (["independentConnections"] as const) : []),
    ...(backend.hasReplica === true ? (["replica"] as const) : []),
    ...(backend.edge === undefined ? [] : (["edge"] as const)),
    ...(backend.neki === true ? (["neki"] as const) : []),
    ...(backend.logicalDecoding === true ? (["logicalDecoding"] as const) : []),
    ...(backend.freshDatabases ? (["freshDatabase"] as const) : []),
  ])

/** The backends the repository runs cases on, by the capabilities each provides. */
const evidenceBackends = {
  pglite: capabilitiesOf({ independentConnections: false, freshDatabases: true }),
  postgres: capabilitiesOf({
    independentConnections: true,
    hasReplica: true,
    logicalDecoding: true,
    freshDatabases: true,
  }),
  neki: capabilitiesOf({ independentConnections: true, neki: true, freshDatabases: false }),
} as const

/** One registered case a verification ledger may cite, and where it can produce evidence. */
export interface EvidenceEntry {
  readonly name: string
  /** The conformance group, or `workflowEngine` for the upstream differential cases. */
  readonly group: ConformanceGroup | "workflowEngine"
  readonly requires: ReadonlyArray<ConformanceRequirement>
  /**
   * For each backend, whether it runs the case or skips it by name. Postgres
   * assumes the CI server's replica and logical decoding; the hosted edge
   * runs only the edge groups. A listed backend is where evidence can come
   * from, not evidence that the case passed there.
   */
  readonly backends: Readonly<Record<keyof typeof evidenceBackends, "runs" | "skips">>
}

/**
 * Every case a verification ledger may cite: the conformance registry and
 * the workflow-engine differential cases, derived from their registrations.
 */
export const evidenceIndex: ReadonlyArray<EvidenceEntry> = [
  ...allGroups.flatMap((group) =>
    conformanceGroups[group].cases.map((conformanceCase) => {
      const requires = requirementsOf(conformanceCase)

      const backends = Object.fromEntries(
        Object.entries(evidenceBackends).map(([backend, provided]) => [
          backend,
          requires.every((required) => provided.has(required)) ? "runs" : "skips",
        ]),
      ) as EvidenceEntry["backends"]

      return { name: conformanceCase.name, group, requires, backends }
    }),
  ),
  ...engineCases.map(({ name }) => ({
    name,
    group: "workflowEngine" as const,
    requires: [],
    backends: { pglite: "runs", postgres: "skips", neki: "skips" } as const,
  })),
]

/** `suites` and every suite they use, each once, dependencies first. */
const withDependencies = (
  suites: ReadonlyArray<ConformanceSuite<unknown>>,
): ReadonlyArray<ConformanceSuite<unknown>> => {
  const ordered: Array<ConformanceSuite<unknown>> = []

  const visit = (suite: ConformanceSuite<unknown>) => {
    if (ordered.includes(suite)) return

    for (const used of suite.uses ?? []) visit(used)
    ordered.push(suite)
  }

  for (const suite of suites) visit(suite)

  return ordered
}

interface ConformanceStore {
  readonly database: ConformanceDatabase
  readonly freshDatabase: Effect.Effect<ConformanceDatabase>
  readonly copy: (database: ConformanceDatabase) => Effect.Effect<ConformanceDatabase>
  readonly connect?: Effect.Effect<ConformanceConnection, never, Scope.Scope>
  readonly replica?: ConformanceReplica | undefined
  readonly close: Effect.Effect<void>
}

/**
 * Registers the named groups' cases, or every group's, against `backend`.
 * Only the selected groups' suites, and the suites they use, build their
 * actors and fixtures. The same case names run on every backend; a case
 * whose requirements the backend lacks is reported through `registrar.skip`.
 *
 * Each case runs under the registrar's abort signal: a timed-out or
 * cancelled case is interrupted, its finalizers run, and the next case waits
 * for them, then restarts a runtime the case left stopped and starts with
 * open test authorization.
 */
export const describeConformance = (options: {
  readonly name: string
  readonly backend: ConformanceBackend
  readonly registrar: ConformanceRegistrar
  readonly groups?: ReadonlyArray<ConformanceGroup>
}): void =>
  registerConformance({
    ...options,
    selected: (options.groups ?? allGroups).map((group) => conformanceGroups[group]),
  })

/** How long the next case waits for an interrupted case's finalizers before it starts anyway. */
const SETTLE_TIMEOUT = "20 seconds"

/** Registers `selected` groups; `describeConformance` passes registry groups, tests pass their own. */
export const registerConformance = (options: {
  readonly name: string
  readonly backend: ConformanceBackend
  readonly registrar: ConformanceRegistrar
  readonly selected: ReadonlyArray<ConformanceGroupCases>
}): void => {
  const { name, backend, registrar, selected } = options
  const suites = withDependencies(selected.map(({ suite }) => suite))
  const fixtures = new Map(suites.map((suite) => [suite, suite.fixture?.()] as const))

  const fixtureOf = <G>(suite: ConformanceSuite<G>): G => {
    if (!fixtures.has(suite as ConformanceSuite<unknown>))
      throw new Error("A conformance case read the fixture of a suite its own suite does not use")

    return fixtures.get(suite as ConformanceSuite<unknown>) as G
  }

  const access: ConformanceAccess = { allowed: true, denied: new Set(), revoked: new Set() }

  const turnHooks = suites.flatMap((suite) => suite.turn?.(fixtureOf(suite)) ?? [])
  const contentHooks = suites.flatMap((suite) => suite.content?.(fixtureOf(suite)) ?? [])
  const loggers = suites.flatMap((suite) => suite.logger?.(fixtureOf(suite)) ?? [])

  let live: Layer.Layer<never, unknown, ConformanceSuiteServices> = Layer.empty

  for (const suite of suites)
    if (suite.layer !== undefined) live = Layer.merge(live, suite.layer(fixtureOf(suite)))

  const capabilities = capabilitiesOf(backend)

  let store: ConformanceStore | undefined

  let current: ConformanceRuntime | undefined

  const opened = () => {
    if (store === undefined) throw new Error("Conformance environment is not open")

    return store
  }

  const environment: ConformanceEnvironment = {
    run: (effect) => {
      if (current === undefined)
        return Promise.reject(new Error("Conformance environment is stopped"))

      return current.runPromise(Effect.scoped(effect))
    },
    build: (overrides) =>
      ManagedRuntime.make(
        live.pipe(
          Layer.provideMerge(
            ActorTest.layer({
              database: overrides?.database ?? opened().database,
              maxConnections: 6,
              replica: overrides?.replica,
              as: User.make({ subject: "alice" }),
              authorize: (request) =>
                Effect.sync(
                  () =>
                    access.allowed &&
                    !access.denied.has(request.command) &&
                    Option.match(principal(request.caller), {
                      onNone: () => true,
                      onSome: ({ subject }) => !access.revoked.has(subject),
                    }),
                ),
              retryWindowMs: overrides?.retryWindowMs ?? 60_000,
              content: overrides?.content,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(TurnHooks, {
                    at: (point, request) =>
                      Effect.forEach(turnHooks, (hook) => hook(point, request), { discard: true }),
                  }),
                  Layer.succeed(ContentHooks, {
                    at: (point) =>
                      Effect.forEach(contentHooks, (hook) => hook(point), { discard: true }),
                  }),
                  Layer.succeed(NekiTurnSessions, backend.neki === true),
                  overrides?.observe === undefined
                    ? Layer.empty
                    : Layer.succeed(Statement.CurrentTransformer, (statement) =>
                        Effect.sync(() => {
                          overrides.observe!(statement)

                          return statement
                        }),
                      ),
                ),
              ),
            ),
          ),
          Layer.provideMerge(backend.services),
          Layer.provide(Logger.layer(loggers, { mergeWithExisting: true })),
          Layer.orDie,
        ),
      ) as ConformanceRuntime,
    stop: Effect.suspend(() => {
      const previous = current
      current = undefined

      return previous === undefined ? Effect.void : Effect.promise(() => previous.dispose())
    }),
    restart: Effect.suspend(() =>
      Effect.andThen(environment.stop, () =>
        Effect.promise(() => {
          current = environment.build()

          return current.runPromise(Effect.void)
        }),
      ),
    ),
    freshDatabase: Effect.suspend(() => opened().freshDatabase),
    snapshot: Effect.suspend(() => {
      if (current !== undefined)
        return Effect.die(new Error("A snapshot needs the conformance runtime stopped"))

      return opened().copy(opened().database)
    }),
    get connect() {
      return store?.connect
    },
    get replica() {
      return store?.replica
    },
    httpServer: backend.httpServer,
    get edge() {
      return backend.edge
    },
  }

  /** The environment one case sees: its runs end with its signal, and only a declared case opens databases. */
  const environmentFor = (
    conformanceCase: ConformanceCase<unknown>,
    signal: AbortSignal | undefined,
  ): ConformanceEnvironment => {
    const undeclared = Effect.die(
      new Error(
        `Conformance case "${conformanceCase.name}" opens a fresh database or snapshot without declaring requiresFreshDatabase`,
      ),
    )

    return {
      run: (effect) => {
        if (current === undefined)
          return Promise.reject(new Error("Conformance environment is stopped"))

        return current.runPromise(Effect.scoped(effect), { signal })
      },
      build: environment.build,
      stop: environment.stop,
      restart: environment.restart,
      freshDatabase:
        conformanceCase.requiresFreshDatabase === true ? environment.freshDatabase : undeclared,
      snapshot: conformanceCase.requiresFreshDatabase === true ? environment.snapshot : undeclared,
      get connect() {
        return environment.connect
      },
      get replica() {
        return environment.replica
      },
      httpServer: environment.httpServer,
      get edge() {
        return environment.edge
      },
    }
  }

  let previousCase: Promise<unknown> = Promise.resolve()

  registrar.describe(name, () => {
    registrar.beforeAll(
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            store = yield* Effect.promise(() => backend.open())
            yield* environment.restart
          }),
        ),
      30_000,
    )

    registrar.afterAll(() =>
      previousCase.then(constVoid, constVoid).then(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* environment.stop

            if (store !== undefined) yield* store.close

            store = undefined
          }),
        ),
      ),
    )

    for (const { suite, cases } of selected)
      for (const conformanceCase of cases) {
        if (requirementsOf(conformanceCase).some((required) => !capabilities.has(required))) {
          registrar.skip(conformanceCase.name)
          continue
        }

        registrar.it(
          conformanceCase.name,
          ({ signal }) => {
            const settled = Effect.runPromise(
              Effect.promise(() => previousCase.then(constVoid, constVoid)).pipe(
                Effect.timeoutOption(SETTLE_TIMEOUT),
              ),
            )

            const running = settled
              .then(() => {
                access.allowed = true
                access.denied.clear()
                access.revoked.clear()

                return Effect.runPromise(
                  Effect.suspend(() => (current === undefined ? environment.restart : Effect.void)),
                )
              })
              .then(() =>
                conformanceCase.run({
                  expect: registrar.expect,
                  environment: environmentFor(conformanceCase, signal),
                  fixture: fixtureOf(suite),
                  access,
                  fixtureOf,
                }),
              )

            previousCase = running

            return running
          },
          conformanceCase.timeoutMs,
        )
      }
  })
}
