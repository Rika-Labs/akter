/**
 * durable-actors/testing — the test surface (typecheck-only sketch, Effect 4.0.0-rc.116).
 *
 * Tests never mock the actor. Every test runs the real `turn()`, the real Cluster entity and the real
 * tables; only the edges are swapped:
 *   database   →  PGlite in-process over pglite-socket (the production PgClient), or a Postgres / Neki url
 *   storage    →  the production SqlMessageStorage on that same SqlClient (never MessageStorage.layerMemory: its
 *                 saveEnvelope writes immediately, so an intent written before a crashed COMMIT would stay deliverable
 *                 and the "intents in the turn transaction" property could not be tested)
 *   transport  →  Sharding + Runners.layerNoop + a harness RunnerStorage for one runner, or N Shardings, each with its own
 *                 MessageStorage.makeEncoded wrapper over the shared SQL backend (reply listeners are per wrapper), a harness
 *                 RunnerStorage (per-address shard locks that expire on the Clock) and a Runners.make bus
 *   time       →  TestClock: DeliverAt timers, Hibernate.after, Effects.retry, Commands.timeout and DurableClock all read Clock
 *   executors  →  held by default; run, fail or override on demand
 *   caller     →  one default CurrentCaller for the whole test (`ActorTest.layer({ as })`); `test.actor(X, id, { as })`
 *                 and `Actor.as` override per handle / per call
 *   workflows  →  members of their owner: `test.actor(User, id).workflow(Onboard).crashActivity("welcome", { at })`
 *
 * What the framework does durably is observed through the tables (actor_generations, actor_timers,
 * actor_events, actor_outbox, actor_dead_letters, actor_receipts, cluster_messages) and through the
 * `TurnHooks` seam, which the harness uses to record every turn and to inject faults deterministically.
 *
 * Runtime internals are `declare`d; the types are the deliverable.
 */
import { Cause, Context, DateTime, Duration, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import { Arbitrary } from "effect/unstable/arbitrary"
import type { EntityAddress, RunnerAddress } from "effect/unstable/cluster"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type {
  ActorEvent,
  ActorRef,
  Actors,
  AnyActor,
  AnyCommand,
  AnyTable,
  AnyTagged,
  AnyWorkflow,
  Auth,
  Caller,
  Database,
  EffectExecutors,
  EventsOf,
  Handle,
  IdArgs,
  Principal,
  TenantId,
  TurnReport,
  WorkflowHandle
} from "./Actor.ts"

/** Structural extractors: concrete definitions are not assignable to `ActorDefinition<any, …>` (see `HandleOf`). */
export type IdOf<A> = A extends { readonly id: infer Id extends Schema.Top } ? Id["Type"] : never
/** The declared keyed state as a value (decision 125); `{}` for an actor without `state`. */
export type StateOf<A> = A extends { readonly state: infer S extends Schema.Struct.Fields } ? Schema.Struct.Type<S> : {}
type MembersOf<A> = A extends AnyActor ? A : never
type CommandsTupleOf<A> = A extends { readonly commands: infer Cs extends ReadonlyArray<AnyCommand> } ? Cs : never
export type CommandsOf<A> = CommandsTupleOf<A>[number]
export type CommandTagsOf<A> = CommandsOf<A>["tag"]
export type EffectsOf<A> = A extends { readonly effects: ReadonlyArray<infer Ef extends AnyTagged> } ? Ef : never
export type WorkflowsOf<A> = A extends { readonly workflows: infer Ws extends ReadonlyArray<AnyWorkflow> } ? Ws[number] : never
export type WorkflowTagsOf<A> = WorkflowsOf<A>["tag"]
export type PromiseClientOf<A> = A extends { readonly client: (...args: any) => infer P } ? P : never
/** Requirements of a fakes object, read off each executor's returned Effect. */
type ExecutorServices<X> = {
  [K in keyof X]-?: NonNullable<X[K]> extends (...args: any) => infer Ret ? Effect.Services<Ret> : never
}[keyof X]
/** Object literals against a type parameter skip excess-property checks; this turns a stray key into a `never` mismatch. */
type NoExtraKeys<X, Allowed extends PropertyKey> = { readonly [K in Exclude<keyof X, Allowed>]: never }

/** One command invocation, as a value: what scripts and model-based tests are made of. */
type StepOf<C> = C extends { readonly tag: infer T extends string; readonly input: infer I }
  ? { readonly command: T; readonly input: I extends Schema.Top ? I["Type"] : undefined; readonly commandId?: string }
  : never
export type Step<A> = StepOf<CommandsOf<A>>
export interface Script<A> {
  readonly steps: ReadonlyArray<Step<A>>
}

/** A turn's result, discriminated on the command so `exit` is typed per command. */
type OutcomeOf<C> = C extends {
  readonly tag: infer T extends string
  readonly output: infer O extends Schema.Top
  readonly errors: infer Er extends ReadonlyArray<Schema.Top>
} ? { readonly command: T; readonly exit: Exit.Exit<O["Type"], Er[number]["Type"]> }
  : never
export type TurnOutcome<A> = OutcomeOf<CommandsOf<A>>

/** `TurnReport` narrowed to one actor: typed id, typed exit per command, typed events and effects. */
export type TurnRecord<A extends AnyActor> =
  & TurnOutcome<A>
  & Omit<TurnReport, "command" | "exit" | "emitted" | "performed">
  & {
    readonly actor: A["name"]
    readonly id: IdOf<A>
    readonly emitted: ReadonlyArray<EventsOf<A>["Type"]>
    readonly performed: ReadonlyArray<EffectsOf<A>["Type"]>
  }

export interface TimerRecord {
  readonly key: string
  readonly at: DateTime.Utc
  readonly command: string
  readonly input: unknown
}
export interface IntentRecord {
  readonly from: EntityAddress.EntityAddress | "external"
  readonly command: string
  readonly input: unknown
  readonly key?: string
  readonly deliverAt?: DateTime.Utc
}
export interface OutboxRecord<Ef> {
  readonly effect: Ef
  readonly attempt: number
  readonly nextAt: DateTime.Utc
  readonly commandId: string
}
export interface DeadLetter<Ef> {
  readonly effect: Ef
  readonly attempts: number
  readonly cause: Cause.Cause<unknown>
  readonly commandId: string
}
export interface Receipt {
  readonly commandId: string
  readonly command: string
  readonly payloadHash: string
  readonly exit: Exit.Exit<unknown, unknown>
  readonly at: DateTime.Utc
}
/** Placeholder for the drizzle row type of an `Actor.table`. */
export type RowOf<T extends AnyTable> = { readonly [K in keyof T["columns"]]: unknown } & {
  readonly tenant_id: TenantId
  readonly actor_id: string
}

/** Everything durable about one actor, read from the tables at the moment of the call. */
export interface ActorState<A extends AnyActor> {
  /** a generation row exists: some turn has committed (or `Lifecycle.createdBy` ran) */
  readonly exists: boolean
  readonly generation: number
  /** an activation is alive on some runner right now (false after `Hibernate.after` elapsed) */
  readonly resident: boolean
  readonly timers: ReadonlyArray<TimerRecord>
  /** unprocessed `cluster_messages` addressed to this actor */
  readonly pendingIntents: ReadonlyArray<IntentRecord>
  readonly outbox: ReadonlyArray<OutboxRecord<EffectsOf<A>["Type"]>>
  readonly deadLetters: ReadonlyArray<DeadLetter<EffectsOf<A>["Type"]>>
  readonly receipts: ReadonlyArray<Receipt>
  readonly events: ReadonlyArray<ActorEvent<EventsOf<A>["Type"]>>
  /**
   * The committed keyed state, decoded through the declared schema and its `migrations` exactly as the next turn would
   * load it (decisions 125, 162); `None` when no turn has written state yet. Reading it here never wakes the actor.
   */
  readonly state: Option.Option<StateOf<A>>
  readonly rows: <T extends AnyTable>(table: T) => Effect.Effect<ReadonlyArray<RowOf<T>>>
}

export class TimedOut extends Schema.TaggedError<TimedOut>()("TimedOut", {
  waitingFor: Schema.String,
  after: Schema.String
}) {}
export class UnsupportedOnPglite extends Schema.TaggedError<UnsupportedOnPglite>()("UnsupportedOnPglite", {
  feature: Schema.String
}) {}

/** The turn log, fed by `TurnHooks.afterCommit` (and by `beforeCommit` for turns that then crashed). */
export interface Turns {
  readonly all: Effect.Effect<ReadonlyArray<TurnReport>>
  readonly of: <A extends AnyActor>(actor: A, id?: IdOf<A>) => Effect.Effect<ReadonlyArray<TurnRecord<A>>>
  /** waits in live time (bounded) for the next committed turn of this actor: timer-, intent- and redelivery-triggered turns are asynchronous */
  readonly next: <A extends AnyActor>(
    actor: A,
    id?: IdOf<A>,
    options?: { readonly timeout?: Duration.Input }
  ) => Effect.Effect<TurnRecord<A>, TimedOut>
  readonly clear: Effect.Effect<void>
}
/** Pure helper for narrowing a captured log after the fact (e.g. from `record`). */
export declare const turnsOf: <A extends AnyActor>(turns: ReadonlyArray<TurnReport>, actor: A, id?: IdOf<A>) => ReadonlyArray<TurnRecord<A>>

export interface Recorded<A, E> {
  readonly exit: Exit.Exit<A, E>
  /** every turn, on every actor, that committed while `self` ran (including intents it caused) */
  readonly turns: ReadonlyArray<TurnReport>
}

export interface PendingEffect<Ef> {
  readonly actor: string
  readonly id: string
  readonly tenantId: TenantId
  readonly commandId: string
  readonly effect: Ef
  readonly attempt: number
}
/**
 * Executors are held by default (`effects: "hold"`): `ctx.perform` writes the outbox row, nothing
 * runs until the test says so. That keeps model calls and emails out of the happy path and makes the
 * retry → dead-letter → `onEffectFailed` chain a sequence of explicit steps.
 */
export interface EffectsHarness {
  readonly pending: {
    (): Effect.Effect<ReadonlyArray<PendingEffect<{ readonly _tag: string }>>>
    <A extends AnyActor>(actor: A, id?: IdOf<A>): Effect.Effect<ReadonlyArray<PendingEffect<EffectsOf<A>["Type"]>>>
  }
  /** runs the registered (or overridden) executor once for every pending effect, in outbox order per actor, then settles */
  readonly run: Effect.Effect<void>
  /** `run` until the outbox is empty or only dead letters remain, advancing the TestClock through `Effects.retry` delays */
  readonly drain: Effect.Effect<void>
  /** the next `times` attempts of matching effects fail with `cause` (default once); then the real executor runs again */
  readonly fail: <A extends AnyActor, Ef extends EffectsOf<A>>(
    actor: A,
    effect: Ef,
    cause: Cause.Cause<unknown>,
    options?: { readonly times?: number | "always" }
  ) => Effect.Effect<void>
  /**
   * Replaces executors for the rest of the scope: the fake model, the fake mailer. Same shape as
   * `Entity.toLayer<Handlers extends HandlersFrom<Rpcs>>`: the fakes object is the type parameter, so
   * `effect`/`ctx` are contextually typed and requirements are derived from the fakes' return types.
   */
  readonly override: <A extends AnyActor, const X extends Partial<EffectExecutors<A, any>>>(
    actor: A,
    executors: X & NoExtraKeys<X, EffectsOf<A>["Type"]["_tag"]>
  ) => Effect.Effect<void, never, Scope.Scope | ExecutorServices<X>>
}

/**
 * Where a turn can die. `before-commit`: the transaction rolls back (`SqlClient.withTransaction` on a
 * failed Exit), nothing persisted, the handler runs again. `after-commit`: committed, reply lost;
 * the retried turn hits the receipt and replays it (`replayed: true`), which is the exactly-once
 * property under test.
 */
export type CrashPoint = "before-handler" | "before-commit" | "after-commit"
export interface Lease {
  readonly release: Effect.Effect<void>
}
/** A turn parked inside `turn()`; `reached` resolves when the hook is entered, `release` lets it continue. */
export interface Paused {
  readonly reached: Effect.Effect<void, TimedOut>
  readonly release: Effect.Effect<void>
}
export interface Faults {
  /**
   * The `TurnHooks` hook at `at` dies with a defect. That is the EntityManager's in-memory restart
   * path (rc.116 `entityManager.ts`: "Defect in entity, restarting"): the RpcServer is rebuilt and
   * the same envelope (same requestId) is written to it again after the `Defects.retry` delay, which
   * the harness advances the TestClock through, so the calling test does not need to fork.
   */
  readonly crash: <A extends AnyActor>(
    actor: A,
    id: IdOf<A>,
    options: { readonly at: CrashPoint; readonly command?: CommandTagsOf<A>; readonly times?: number }
  ) => Effect.Effect<void>
  /**
   * The hook at `at` blocks until `release`. Used with `cluster.kill` for runner death mid-turn: the
   * killed runner's fiber is interrupted, its transaction rolls back, the shard moves after
   * `shardLockExpiration`, and the survivor re-reads the envelope from storage (`trigger: "redelivery"`).
   */
  readonly pause: <A extends AnyActor>(
    actor: A,
    id: IdOf<A>,
    options: { readonly at: CrashPoint; readonly command?: CommandTagsOf<A> }
  ) => Effect.Effect<Paused, never, Scope.Scope>
  /** bumps `actor_generations` as a rebalance would: the resident activation's next turn dies on the fence */
  readonly staleGeneration: <A extends AnyActor>(actor: A, id: IdOf<A>) => Effect.Effect<void>
  /** holds `SELECT … FOR UPDATE` on the generation row from a second connection; PGlite has one connection, so real Postgres only */
  readonly holdLock: <A extends AnyActor>(actor: A, id: IdOf<A>) => Effect.Effect<Lease, UnsupportedOnPglite, Scope.Scope>
  /** marks the envelope unprocessed again: Cluster redelivers and the receipt must replay */
  readonly redeliver: <A extends AnyActor>(actor: A, id: IdOf<A>, commandId: string) => Effect.Effect<void>
  /** seeded random crashes for the rest of the scope, for model-based tests */
  readonly chaos: (options: {
    readonly probability: number
    readonly at?: ReadonlyArray<CrashPoint>
    readonly seed?: number
  }) => Effect.Effect<void, never, Scope.Scope>
}

export interface RunnerRef {
  readonly index: number
  readonly address: RunnerAddress.RunnerAddress
}
/**
 * The test fiber's `Actors` is bound to a client-only Sharding (`ShardingConfig.runnerAddress: None`),
 * so `kill` never takes down the caller: an in-flight call survives its host's death and receives the
 * survivor's reply.
 */
/**
 * Present when `ActorTest.layer({ runners: n })` with n > 1: N `Sharding` instances over one in-memory `MessageStorage`,
 * a harness `RunnerStorage` and an in-process `Runners.make` bus. Not `RunnerStorage.layerMemory` (its `acquire` grants every
 * shard to any caller) and not `SqlRunnerStorage` (lock expiry reads the database's `now()`, not the TestClock).
 */
export interface ClusterHarness {
  readonly runners: Effect.Effect<ReadonlyArray<RunnerRef>>
  /** `None` when the actor is not resident anywhere */
  readonly runnerOf: <A extends AnyActor>(actor: A, id: IdOf<A>) => Effect.Effect<Option.Option<RunnerRef>>
  /**
   * Runner death, not shutdown: closing a Sharding scope is a graceful exit that unregisters the runner
   * and releases its locks (`Sharding.ts` finalizers), so `kill` first tells the harness RunnerStorage
   * and bus to drop every call from this address, then closes the scope. Its shard locks expire after
   * `shardLockExpiration` (advance the clock) and the others take over.
   */
  readonly kill: (runner: RunnerRef) => Effect.Effect<void>
  readonly start: Effect.Effect<RunnerRef>
  /** partition for the rest of the scope: pings fail, sends time out */
  readonly isolate: (runner: RunnerRef) => Effect.Effect<void, never, Scope.Scope>
}

export interface TestClockHarness {
  readonly now: Effect.Effect<DateTime.Utc>
  /**
   * `TestClock.adjust` in steps of `ShardingConfig.entityMessagePollInterval`, settling between steps,
   * so a timer that arms another timer fires in order instead of both being seen at the end.
   */
  readonly advance: (by: Duration.Input) => Effect.Effect<void>
  readonly set: (to: DateTime.Utc) => Effect.Effect<void>
}

export interface WorkflowState {
  readonly status: "running" | "sleeping" | "waiting" | "completed" | "failed"
  readonly activities: ReadonlyArray<{
    readonly name: string
    readonly attempts: number
    readonly exit: Option.Option<Exit.Exit<unknown, unknown>>
  }>
  readonly sleepingUntil: Option.Option<DateTime.Utc>
  /** the owner event a `ctx.waitFor` is parked on, if any */
  readonly waitingFor: Option.Option<string>
}
/**
 * Where an activity can die (decision 143). `beforeBody`: nothing ran, the engine retries the activity. `afterBodyBeforeResult`:
 * the body's side effects happened (a command was sent), the result was not persisted: the retry replays through the
 * receipt the framework keyed on `${executionId}:${activity}`. `afterResult`: the result is durable, the workflow fiber
 * dies before the next step: resumption skips the activity. `Effect.die` inside a body is *not* process loss (the engine
 * may record it as a result); this hook is.
 */
export type ActivityCrashPoint = "beforeBody" | "afterBodyBeforeResult" | "afterResult"
/** Workflows are members (decision 158): every operation names the owner and the member. */
export interface WorkflowsHarness {
  readonly inspect: <A extends AnyActor>(owner: A, id: IdOf<A>, workflow: WorkflowsOf<A>, options?: { readonly key?: string }) => Effect.Effect<Option.Option<WorkflowState>>
  /** the next `times` runs of this activity die at `at` (default `beforeBody`, once) */
  readonly crashActivity: <A extends AnyActor>(
    owner: A,
    id: IdOf<A>,
    workflow: WorkflowsOf<A>,
    activity: string,
    options?: { readonly at?: ActivityCrashPoint; readonly times?: number }
  ) => Effect.Effect<void>
  /** waits (live time, bounded) until the run under `key` is parked on `waitFor` / `sleep` or has finished */
  readonly settled: <A extends AnyActor>(owner: A, id: IdOf<A>, workflow: WorkflowsOf<A>, options?: { readonly key?: string; readonly timeout?: Duration.Input }) => Effect.Effect<WorkflowState, TimedOut>
}

/**
 * One actor, bound once (decision 120): the outside handle plus every harness operation for this id, so a test reads
 * `counter.crash({ at: "after-commit" })` instead of repeating `(Counter, id)` on each call. `as` overrides the test's
 * default caller for this handle only.
 */
export interface BoundActor<A extends AnyActor> {
  readonly handle: Handle<A>
  /**
   * The handle a `System` caller sees: internal commands included, request/reply allowed, the same handle a workflow
   * body gets as `ctx.owner`. For delivering `SandboxReady` / `TurnDone`-style commands directly instead of driving
   * the executor or run loop that would normally send them. Caller is `System("actor", { onBehalfOf: as })`.
   */
  readonly system: WorkflowHandle<MembersOf<A>>
  readonly ref: ActorRef
  readonly id: IdOf<A>
  readonly inspect: Effect.Effect<ActorState<A>>
  readonly turns: Effect.Effect<ReadonlyArray<TurnRecord<A>>>
  readonly next: (options?: { readonly timeout?: Duration.Input }) => Effect.Effect<TurnRecord<A>, TimedOut>
  readonly effects: Effect.Effect<ReadonlyArray<PendingEffect<EffectsOf<A>["Type"]>>>
  readonly rows: <T extends AnyTable>(table: T) => Effect.Effect<ReadonlyArray<RowOf<T>>>
  /**
   * Writes rows the way an *older* deployment would have left them, bypassing the current schema: `state` is stored
   * as-is (so a V1 shape can be seeded and the next turn must run `migrations` over it), `rows` insert into a declared
   * table under this actor's `(tenant_id, actor_id)`. Seeding never wakes the actor and never bumps the generation.
   */
  readonly seed: (data: {
    readonly state?: unknown
    readonly rows?: ReadonlyArray<{ readonly table: AnyTable; readonly values: Record<string, unknown> }>
  }) => Effect.Effect<void>
  readonly crash: (options: { readonly at: CrashPoint; readonly command?: CommandTagsOf<A>; readonly times?: number }) => Effect.Effect<void>
  readonly pause: (options: { readonly at: CrashPoint; readonly command?: CommandTagsOf<A> }) => Effect.Effect<Paused, never, Scope.Scope>
  readonly staleGeneration: Effect.Effect<void>
  readonly redeliver: (commandId: string) => Effect.Effect<void>
  readonly workflow: <W extends WorkflowsOf<A>>(workflow: W, options?: { readonly key?: string }) => {
    readonly inspect: Effect.Effect<Option.Option<WorkflowState>>
    readonly crashActivity: (activity: string, options?: { readonly at?: ActivityCrashPoint; readonly times?: number }) => Effect.Effect<void>
    readonly settled: (options?: { readonly timeout?: Duration.Input }) => Effect.Effect<WorkflowState, TimedOut>
  }
}

/** `Actor.serve` on an in-process HttpServer test client: the real Rpc serialization, no port. */
export interface TestServer {
  readonly client: <A extends AnyActor>(actor: A, options?: { readonly headers?: Record<string, string> }) => PromiseClientOf<A>
  /** for the derived HttpApi / OpenAPI surface */
  readonly http: HttpClient
}

/** A pure model of an actor: fold the committed turns, compare with the durable state. */
export interface Model<A extends AnyActor, S> {
  readonly initial: S
  /** applied only to turns that committed and succeeded (`replayed` turns are skipped: they changed nothing) */
  readonly step: (state: S, step: Step<A>, outcome: TurnOutcome<A>) => S
  readonly observe: (state: ActorState<A>) => Effect.Effect<S>
}
export class ModelMismatch extends Schema.TaggedError<ModelMismatch>()("ModelMismatch", {
  actor: Schema.String,
  id: Schema.String,
  turns: Schema.Number,
  expected: Schema.Unknown,
  actual: Schema.Unknown
}) {}

export interface Options {
  /** default `"pglite"`; a url runs the same suite on Postgres or Neki */
  readonly database?: "pglite" | { readonly url: string; readonly neki?: boolean }
  /** default 1 (`Sharding` + `Runners.layerNoop` + harness `RunnerStorage`, never `TestRunner.layer`); more builds an in-process multi-runner cluster (harness `RunnerStorage`, `Runners.make` bus, `simulateRemoteSerialization: true`) */
  readonly runners?: number
  /** the app's principal schema, needed to round-trip `CurrentCaller` through envelope headers; default passes the value through unchecked */
  readonly principal?: Schema.Top & { readonly Type: Principal }
  /**
   * default `CurrentCaller` for the test fiber (default `Anonymous`): a `Principal` or a full `Caller`;
   * `Actor.as`, `X.get(id, { as })` and `test.actor(X, id, { as })` still win per call (decision 120)
   */
  readonly as?: Principal | Caller
  /** default `"hold"` */
  readonly effects?: "hold" | "run"
}

export class ActorTest extends Context.Service<ActorTest, {
  /** fresh per layer build, so files and describe blocks never share rows; `reset` clears it between tests */
  readonly tenant: TenantId
  readonly clock: TestClockHarness
  /** waits (live time, bounded) until no due message is unprocessed, no turn is running and no held effect is executing */
  readonly settle: Effect.Effect<void, TimedOut>
  /** deletes every row of this tenant and clears the turn log; activations are evicted */
  readonly reset: Effect.Effect<void>
  readonly turns: Turns
  /** runs `self` and returns its Exit together with every turn that committed meanwhile */
  readonly record: <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<Recorded<A, E>, never, R>
  readonly inspect: <A extends AnyActor>(actor: A, id: IdOf<A>) => Effect.Effect<ActorState<A>>
  /**
   * `X.get(id)` plus the harness, bound to one id (decision 120). Named and singleton ids take the same arguments as
   * `X.get`; a minted actor is bound with the id `X.create()` returned. The default caller is the layer's `as`.
   */
  readonly actor: <A extends AnyActor>(actor: A, ...args: [...IdArgs<A>, options?: { readonly as?: Principal | Caller; readonly tenant?: TenantId }]) => Effect.Effect<BoundActor<A>>
  /** `X.create()` plus the harness: mints the id and binds it (minted actors only, decision 164). */
  readonly create: <A extends AnyActor & { readonly mode: "minted" }>(actor: A, options?: { readonly as?: Principal | Caller; readonly tenant?: TenantId }) => Effect.Effect<BoundActor<A>>
  readonly effects: EffectsHarness
  readonly faults: Faults
  readonly cluster: ClusterHarness
  readonly workflows: WorkflowsHarness
  readonly serve: <R = never>(options: {
    readonly actors: ReadonlyArray<AnyActor>
    readonly auth?: Auth<R>
  }) => Effect.Effect<TestServer, never, Scope.Scope | Exclude<R, Scope.Scope>>
  /** runs a script against one actor (optionally with concurrent callers) and returns its committed turns in commit order */
  readonly run: <A extends AnyActor>(
    actor: A,
    id: IdOf<A>,
    script: Script<A>,
    options?: { readonly concurrency?: number }
  ) => Effect.Effect<ReadonlyArray<TurnRecord<A>>>
  /** `run`, then fold `model.step` over the committed turns and compare with `model.observe(inspect)` */
  readonly check: <A extends AnyActor, S>(
    actor: A,
    id: IdOf<A>,
    model: Model<A, S>,
    script: Script<A>,
    options?: { readonly concurrency?: number }
  ) => Effect.Effect<void, ModelMismatch>
}>()("durable-actors/testing/ActorTest") {
  /**
   * `Actor.layer` over TestRunner (or the in-process multi-runner bus) and a PGlite `Database`, plus
   * a recording/fault-injecting `TurnHooks` and the default `CurrentCaller` (a `Context.Reference`, so it is set,
   * not provided: it never appears in the layer's output). Requires nothing: the TestClock comes from
   * `it.effect` / `it.layer` (`@effect/vitest` test services).
   */
  static readonly layer: (options?: Options) => Layer.Layer<ActorTest | Actors | Database> = undefined as never
}

/** Command sequences drawn from the actor's own input schemas (`Arbitrary.schema(command.input)`). */
export const Scripts: {
  readonly arbitrary: <A extends AnyActor>(actor: A, options?: {
    readonly steps?: { readonly min: number; readonly max: number }
    /** probability that a step reuses an earlier step's commandId (exercises receipts); default 0.1 */
    readonly duplicateCommandIds?: number
    readonly commands?: ReadonlyArray<CommandTagsOf<A>>
  }) => Arbitrary.Arbitrary<Script<A>>
} = undefined as never

/**
 * The database gates from DECISIONS.md §3, as runnable cases. `requires: "postgres"` cases skip on
 * PGlite (one connection). The same list runs against PGlite, Postgres and Neki: passing on Neki is
 * what "Neki supported" means (decision 66).
 */
export interface ConformanceCase {
  readonly name: string
  readonly requires: "any" | "postgres"
  readonly run: Effect.Effect<void, ConformanceFailure | TimedOut | UnsupportedOnPglite, ActorTest | Actors | Database | Scope.Scope>
}
export class ConformanceFailure extends Schema.TaggedError<ConformanceFailure>()("ConformanceFailure", {
  case: Schema.String,
  detail: Schema.String
}) {}
export declare const conformance: ReadonlyArray<ConformanceCase>
/** Registers one `it.effect` per case; call inside `it.layer(ActorTest.layer({ database }))`. */
export declare const describeConformance: (
  it: Vitest.Test<Scope.Scope | ActorTest | Actors | Database>,
  options?: { readonly only?: ReadonlyArray<string> }
) => void

export const ActorTesting = { ActorTest, Scripts, conformance, describeConformance, turnsOf }
