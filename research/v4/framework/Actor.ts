/**
 * Durable Actors — proposed public surface (typecheck-only sketch, Effect 4.0.0-rc.116).
 *
 * Everything compiles down to Effect primitives:
 *   Actor.command / query / stream   →  Rpc.make (stream: true for streams)
 *   Actor.make                       →  RpcGroup.make + Entity.fromRpcGroup (commands + streams only)
 *   X.toLayer                        →  Entity.toLayer({ concurrency: 1, maxIdleTime, mailboxCapacity, defectRetryPolicy })
 *   X.get(id)                        →  Sharding.makeClient(entity)(id), wrapped so methods are plain Effects
 *   Actor.workflow                   →  Workflow.make + Activity.make + DurableClock
 *   Actor.commandId / as / tenant    →  Effect.provideService on a Context.Reference (ambient, with defaults)
 *   ctx.emit / perform / self.send   →  rows in actor_events / actor_outbox / actor_intents inside the turn transaction
 *
 * The wrapping adds the contracts the framework promises: one transaction per command ("turn"),
 * generation fence, receipts keyed by commandId, typed channels everywhere, and "retryable = defect".
 *
 * `Drizzle`, `OwnedTable`, `Scoped` are placeholders for drizzle-orm/effect-postgres types so this
 * file typechecks from the repo root, where only `effect` is hoisted. Runtime internals are `declare`d.
 */
import { Context, DateTime, Duration, Effect, Layer, Ref, Schedule, Schema, Scope, Stream } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { ClusterSchema, Entity, EntityAddress, Sharding } from "effect/unstable/cluster"
import { AlreadyProcessingMessage, EntityNotAssignedToRunner, MailboxFull, PersistenceError } from "effect/unstable/cluster/ClusterError"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

/** Same commandId, different payload: the receipt does not match. Added to every command's E. */
export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  commandId: Schema.String
}, { httpApiStatus: 409 }) {}

/** Cluster could not deliver after `Delivery.retry`. `cause` keeps the original Cluster error. */
export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  reason: Schema.Literals(["mailbox_full", "already_processing", "persistence", "not_assigned"]),
  cause: Schema.Union([MailboxFull, AlreadyProcessingMessage, PersistenceError, EntityNotAssignedToRunner])
}, { httpApiStatus: 503 }) {}

export const TenantId = Schema.String.pipe(Schema.brand("TenantId"))
export type TenantId = typeof TenantId.Type

export interface CallerInfo {
  readonly userId: string
}

/** Ambient values with defaults. Set for a call with `Actor.tenant`, `Actor.as`, `Actor.commandId`. */
export const Tenant = Context.Reference<TenantId>("durable-actors/Tenant", { defaultValue: () => TenantId.make("default") })
export const Caller = Context.Reference<CallerInfo>("durable-actors/Caller", { defaultValue: () => ({ userId: "anonymous" }) })
export const CommandId = Context.Reference<string | undefined>("durable-actors/CommandId", { defaultValue: () => undefined })

export const tenant = (id: TenantId) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, Tenant, id)
export const as = (caller: CallerInfo) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, Caller, caller)
export const commandId = (id: string) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CommandId, id)

/** Placeholder for `EffectPgDatabase` from drizzle-orm/effect-postgres (same PgClient, joins Effect transactions). */
export interface Drizzle {
  readonly _: "drizzle-orm/effect-postgres EffectPgDatabase"
}
/** Placeholder for a drizzle table declared with `tenant_id` + `actor_id` columns (the Neki shard key). */
export interface OwnedTable {
  readonly _: "drizzle table with tenant_id, actor_id"
}
/** Placeholder for a drizzle query builder pre-filtered by (tenant_id, actor_id). */
export interface Scoped<T extends OwnedTable> {
  readonly table: T
  readonly _: "query builder pre-filtered by (tenant_id, actor_id)"
}
/** Nominal service: `PgClient` structurally extends `SqlClient`, so we never key on either directly. */
export class Database extends Context.Service<Database, {
  readonly sql: SqlClient
  readonly drizzle: Drizzle
}>()("durable-actors/Database") {}

export interface Command<Tag extends string, In extends Schema.Top | undefined, Out extends Schema.Top, Errors extends ReadonlyArray<Schema.Top>> {
  readonly _kind: "command"
  readonly tag: Tag
  readonly input: In
  readonly output: Out
  readonly errors: Errors
}
export interface QueryDef<Tag extends string, In extends Schema.Top | undefined, Out extends Schema.Top, Errors extends ReadonlyArray<Schema.Top>> {
  readonly _kind: "query"
  readonly tag: Tag
  readonly input: In
  readonly output: Out
  readonly errors: Errors
}
export interface StreamDef<Tag extends string, In extends Schema.Top | undefined, Out extends Schema.Top, Errors extends ReadonlyArray<Schema.Top>> {
  readonly _kind: "stream"
  readonly tag: Tag
  readonly input: In
  readonly output: Out
  readonly errors: Errors
}
export type AnyCommand = Command<string, any, any, any>
export type AnyQuery = QueryDef<string, any, any, any>
export type AnyStream = StreamDef<string, any, any, any>
/** Events and effects are `Schema.TaggedClass` values. */
export type AnyTagged = Schema.Top & { readonly Type: { readonly _tag: string } }

/** `input` may be a schema (positional arg), struct fields (object arg), or omitted (no arg). */
type NormalizeInput<In> = In extends Schema.Top ? In : In extends Schema.Struct.Fields ? Schema.Struct<In> : undefined
const normalizeInput = (input: unknown): Schema.Top | undefined =>
  input === undefined ? undefined : Schema.isSchema(input) ? input : Schema.Struct(input as Schema.Struct.Fields)

interface Definition<In, Out, Errors> {
  readonly input?: In
  readonly output?: Out
  readonly errors?: Errors
}

const define = (kind: "command" | "query" | "stream", tag: string, def: Definition<unknown, Schema.Top, ReadonlyArray<Schema.Top>> | undefined) => ({
  _kind: kind,
  tag,
  input: normalizeInput(def?.input),
  output: def?.output ?? Schema.Void,
  errors: def?.errors ?? []
})

export const command = <
  const Tag extends string,
  In extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<Schema.Top> = []
>(tag: Tag, def?: Definition<In, Out, Errors>): Command<Tag, NormalizeInput<In>, Out, Errors> => define("command", tag, def) as any

export const query = <
  const Tag extends string,
  In extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<Schema.Top> = []
>(tag: Tag, def?: Definition<In, Out, Errors>): QueryDef<Tag, NormalizeInput<In>, Out, Errors> => define("query", tag, def) as any

export const stream = <
  const Tag extends string,
  In extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<Schema.Top> = []
>(tag: Tag, def?: Definition<In, Out, Errors>): StreamDef<Tag, NormalizeInput<In>, Out, Errors> => define("stream", tag, def) as any

/** Contract-side lifecycle: serializable data, lives in the contract file. */
export type Policy =
  | { readonly _tag: "Hibernate"; readonly after: Duration.Input } // Entity.toLayer maxIdleTime
  | { readonly _tag: "MailboxCapacity"; readonly size: number | "unbounded" } // Entity.toLayer mailboxCapacity
  | { readonly _tag: "DefectRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // Entity.toLayer defectRetryPolicy
  | { readonly _tag: "DeliveryRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // client-side retry before ActorUnavailable
  | { readonly _tag: "EffectsRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // outbox executor retry before dead-letter
  | { readonly _tag: "CommandTimeout"; readonly after: Duration.Input } // turn(): handler timeout → defect → redelivery
  | { readonly _tag: "LockWait"; readonly after: Duration.Input } // turn(): SET LOCAL lock_timeout on the generation fence
  | { readonly _tag: "ReceiptsRetention"; readonly keep: Duration.Input } // actor_receipts purge (never before cluster_messages)
  | { readonly _tag: "EventsRetention"; readonly keep: Duration.Input | "forever" } // actor_events purge
  | { readonly _tag: "Cron"; readonly expression: string; readonly command: Command<string, undefined, any, any> } // per-actor timer re-armed after each run

export const Hibernate = {
  after: (after: Duration.Input): Policy => ({ _tag: "Hibernate", after })
}
export const Mailbox = {
  capacity: (size: number | "unbounded"): Policy => ({ _tag: "MailboxCapacity", size })
}
export const Defects = {
  retry: (schedule: Schedule.Schedule<any, unknown>): Policy => ({ _tag: "DefectRetry", schedule })
}
export const Delivery = {
  retry: (schedule: Schedule.Schedule<any, unknown>): Policy => ({ _tag: "DeliveryRetry", schedule })
}
export const Effects = {
  retry: (schedule: Schedule.Schedule<any, unknown>): Policy => ({ _tag: "EffectsRetry", schedule })
}
export const Commands = {
  timeout: (after: Duration.Input): Policy => ({ _tag: "CommandTimeout", after }),
  lockWait: (after: Duration.Input): Policy => ({ _tag: "LockWait", after })
}
export const Receipts = {
  keep: (keep: Duration.Input): Policy => ({ _tag: "ReceiptsRetention", keep })
}
export const Events = {
  keep: (keep: Duration.Input | "forever"): Policy => ({ _tag: "EventsRetention", keep })
}
export const Cron = {
  /** Only zero-input commands: cron cannot supply a payload. */
  every: (expression: string, command: Command<string, undefined, any, any>): Policy => ({ _tag: "Cron", expression, command })
}

type Args<C> = C extends { readonly input: infer I } ? (I extends Schema.Top ? [input: I["Type"]] : []) : []
type OutOf<C> = C extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never
type ErrOf<C> = C extends { readonly errors: infer Er extends ReadonlyArray<Schema.Top> } ? Er[number]["Type"] : never
type ErrorSchemaOf<Er extends ReadonlyArray<Schema.Top>> = Er extends readonly [] ? typeof Schema.Never : Schema.Union<Er>

export interface GetOptions {
  /** explicit tenant; otherwise the ambient `Tenant` reference */
  readonly tenant?: TenantId
}
export interface IntentOptions {
  /** same key replaces the pending intent; cancel with ctx.timers.cancel(key) */
  readonly key?: string
}

/** Inside a turn, other actors (and self) are reachable only as durable intents. */
export interface IntentMethod<C> {
  readonly send: (...args: [...Args<C>, options?: IntentOptions]) => Effect.Effect<void>
  readonly after: (delay: Duration.Input, ...args: [...Args<C>, options?: IntentOptions]) => Effect.Effect<void>
  readonly at: (when: DateTime.Utc, ...args: [...Args<C>, options?: IntentOptions]) => Effect.Effect<void>
}
export type IntentHandle<Cs extends ReadonlyArray<AnyCommand>> = {
  readonly [C in Cs[number] as C["tag"]]: IntentMethod<C>
}

export type Handle<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged> =
  & { readonly id: Id["Type"]; readonly address: EntityAddress.EntityAddress }
  & { readonly [C in Cs[number] as C["tag"]]: (...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C> | CommandConflict | ActorUnavailable> }
  /** queries run on the caller's node against committed rows: no Cluster hop, no ActorUnavailable */
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>> }
  /** streams run on the actor's node (they can read memory) but are forked past the mailbox */
  & { readonly [S in Ss[number] as S["tag"]]: (...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S> | ActorUnavailable> }
  & {
    readonly events: {
      (): Stream.Stream<Ev["Type"], never, Scope.Scope>
      <E extends Ev>(event: E): Stream.Stream<E["Type"], never, Scope.Scope>
    }
  }

/** Derived, Promise-based client for non-Effect callers (browsers, coding agents). Same error classes, thrown. */
export type PromiseHandle<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged> =
  & { readonly id: Id["Type"] }
  & { readonly [C in Cs[number] as C["tag"]]: (...args: Args<C>) => Promise<OutOf<C>> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: Args<Q>) => Promise<OutOf<Q>> }
  & { readonly [S in Ss[number] as S["tag"]]: (...args: Args<S>) => AsyncIterable<OutOf<S>> }
  & { readonly events: <E extends Ev>(event: E) => AsyncIterable<E["Type"]> }
export interface PromiseClient<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged> {
  readonly get: (id: Id["Type"], options?: GetOptions) => PromiseHandle<Id, Cs, Qs, Ss, Ev>
}

export interface CommandContext<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Ev extends AnyTagged, Ef extends AnyTagged, Mem> {
  readonly address: EntityAddress.EntityAddress
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  /** framework-generated unless the caller piped `Actor.commandId`; receipts key on it */
  readonly commandId: string
  readonly caller: CallerInfo
  readonly now: DateTime.Utc
  /** joined to the turn transaction */
  readonly db: Drizzle
  /** declared `tables`, pre-scoped to this actor */
  readonly rows: <T extends OwnedTable>(table: T) => Scoped<T>
  /** process-local, lives for the activation */
  readonly memory: Ref.Ref<Mem>
  /** durable intents to self; no request/reply inside a turn */
  readonly self: IntentHandle<Cs>
  /** durable intents to other actors */
  readonly actors: ActorIntents
  readonly workflows: {
    readonly start: <W extends AnyWorkflow>(workflow: W, input: WorkflowInput<W>) => Effect.Effect<void>
  }
  readonly timers: {
    readonly cancel: (key: string) => Effect.Effect<void>
  }
  /** typed to the actor's declared `events`; delivered after commit */
  readonly emit: (event: Ev["Type"]) => Effect.Effect<void>
  /** typed to the actor's declared `effects`; executed after commit, at least once, by the executor in the server file */
  readonly perform: (effect: Ef["Type"]) => Effect.Effect<void>
}
/** Ambient access to the current turn from deep inside handler code. Present only inside a command handler. */
export class Turn extends Context.Service<Turn, CommandContext<any, any, any, any, any>>()("durable-actors/Turn") {}

/** Runs on the caller's node. No fence, no receipt, no transaction. */
export interface QueryContext<Id extends Schema.Top> {
  readonly address: EntityAddress.EntityAddress
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  readonly caller: CallerInfo
  readonly db: Drizzle
  readonly rows: <T extends OwnedTable>(table: T) => Scoped<T>
}
export class Query extends Context.Service<Query, QueryContext<any>>()("durable-actors/Query") {}

/** Runs on the actor's node, forked past `concurrency: 1` (Rpc.fork), so a long stream never blocks commands. */
export interface StreamContext<Id extends Schema.Top, Mem> extends QueryContext<Id> {
  readonly memory: Ref.Ref<Mem>
}

/** OnWake / OnSleep: no transaction, no caller. */
export interface WakeContext<Id extends Schema.Top, Mem> {
  readonly address: EntityAddress.EntityAddress
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  readonly db: Drizzle
  readonly rows: <T extends OwnedTable>(table: T) => Scoped<T>
  readonly memory: Ref.Ref<Mem>
}

/** Outbox executor context. */
export interface EffectContext<Id extends Schema.Top> {
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  readonly attempt: number
}

export interface Hook<R> {
  readonly _tag: "OnCreate" | "OnWake" | "OnSleep"
  readonly run: (ctx: any) => Effect.Effect<void, never, R>
}

export type HandlersFor<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Ev extends AnyTagged,
  Ef extends AnyTagged,
  Mem,
  R
> =
  & { readonly [C in Cs[number] as C["tag"]]: (ctx: CommandContext<Id, Cs, Ev, Ef, Mem>, ...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C>, R> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (ctx: QueryContext<Id>, ...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>, R> }
  & { readonly [S in Ss[number] as S["tag"]]: (ctx: StreamContext<Id, Mem>, ...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S>, R> }

export type EffectExecutors<Id extends Schema.Top, Ef extends AnyTagged, R> = {
  readonly [E in Ef as E["Type"]["_tag"]]: (effect: E["Type"], ctx: EffectContext<Id>) => Effect.Effect<void, unknown, R>
}

/** Server-side lifecycle: hooks and outbox executors carry code, so they live with `toLayer`. */
export interface ServeOptions<Id extends Schema.Top, Ef extends AnyTagged, RX> {
  readonly lifecycle?: ReadonlyArray<Hook<RX>>
  readonly effects?: EffectExecutors<Id, Ef, RX>
}

type RpcOfDef<D> = D extends Command<infer T, infer I, infer O, infer Er>
  ? Rpc.Rpc<T, I extends Schema.Top ? I : typeof Schema.Void, O, ErrorSchemaOf<Er>>
  : D extends QueryDef<infer T, infer I, infer O, infer Er>
    ? Rpc.Rpc<T, I extends Schema.Top ? I : typeof Schema.Void, O, ErrorSchemaOf<Er>>
    : D extends StreamDef<infer T, infer I, infer O, infer Er>
      ? Rpc.Rpc<T, I extends Schema.Top ? I : typeof Schema.Void, RpcSchema.Stream<O, ErrorSchemaOf<Er>>, typeof Schema.Never>
      : never
export type RpcsOf<Ds extends ReadonlyArray<AnyCommand | AnyQuery | AnyStream>> = Extract<RpcOfDef<Ds[number]>, Rpc.Any>

export interface ActorDefinition<
  Name extends string,
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Ev extends AnyTagged,
  Ef extends AnyTagged,
  Mem
> {
  readonly name: Name
  readonly id: Id
  readonly commands: Cs
  readonly queries: Qs
  readonly streams: Ss
  readonly events: ReadonlyArray<Ev>
  readonly effects: ReadonlyArray<Ef>
  readonly tables: ReadonlyArray<OwnedTable>
  readonly lifecycle: ReadonlyArray<Policy>
  readonly memory: () => Mem
  /** `const counter = yield* Counter.get(id)` — resolves the runtime once; methods are then plain Effects. */
  readonly get: (id: Id["Type"], options?: GetOptions) => Effect.Effect<Handle<Id, Cs, Qs, Ss, Ev>, never, Actors>
  /** Promise client derived from `rpcs` over HTTP/WebSocket. */
  readonly client: (options: { readonly baseUrl: string }) => PromiseClient<Id, Cs, Qs, Ss, Ev>
  /** Lives in the server file. Handlers may be an object or an Effect that acquires services once per activation. */
  readonly toLayer: {
    <R, RX = never>(
      handlers: HandlersFor<Id, Cs, Qs, Ss, Ev, Ef, Mem, R>,
      options?: ServeOptions<Id, Ef, RX>
    ): Layer.Layer<never, never, Exclude<R | RX, Turn | Query> | Actors>
    <R, RB, RX = never>(
      build: Effect.Effect<HandlersFor<Id, Cs, Qs, Ss, Ev, Ef, Mem, R>, never, RB>,
      options?: ServeOptions<Id, Ef, RX>
    ): Layer.Layer<never, never, Exclude<R | RB | RX, Scope.Scope | Turn | Query> | Actors>
  }
  /** identity with contextual typing, for handlers returned from an Effect */
  readonly of: <R>(handlers: HandlersFor<Id, Cs, Qs, Ss, Ev, Ef, Mem, R>) => HandlersFor<Id, Cs, Qs, Ss, Ev, Ef, Mem, R>
  /** first turn ever for this id; runs inside that turn's transaction before the command handler */
  readonly onCreate: <R>(run: (ctx: CommandContext<Id, Cs, Ev, Ef, Mem>) => Effect.Effect<void, never, R>) => Hook<R>
  readonly onWake: <R>(run: (ctx: WakeContext<Id, Mem>) => Effect.Effect<void, never, R>) => Hook<R>
  readonly onSleep: <R>(run: (ctx: WakeContext<Id, Mem>) => Effect.Effect<void, never, R>) => Hook<R>
  /** escape hatches: the Effect primitives underneath */
  readonly rpcs: RpcGroup.RpcGroup<RpcsOf<[...Cs, ...Qs, ...Ss]>>
  readonly entity: Entity.Entity<Name, RpcsOf<[...Cs, ...Ss]>>
}
export type HandleOf<A> = A extends ActorDefinition<any, infer Id, infer Cs, infer Qs, infer Ss, infer Ev, any, any> ? Handle<Id, Cs, Qs, Ss, Ev> : never

export interface ActorIntents {
  readonly get: <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged, Ef extends AnyTagged, Mem>(
    actor: ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Mem>,
    id: Id["Type"],
    options?: GetOptions
  ) => IntentHandle<Cs>
}

export interface WorkflowContext {
  readonly executionId: string
  /** Activity.make: the result is persisted, so output/errors need schemas */
  readonly activity: <Out extends Schema.Top, const Errors extends ReadonlyArray<Schema.Top>, R>(
    name: string,
    options: { readonly output: Out; readonly errors?: Errors; readonly run: Effect.Effect<Out["Type"], Errors[number]["Type"], R> }
  ) => Effect.Effect<Out["Type"], Errors[number]["Type"], R>
  /** DurableClock.sleep */
  readonly sleep: (duration: Duration.Input) => Effect.Effect<void>
  /** full handles: request/reply is fine inside a workflow (there is no turn to hold open) */
  readonly actors: Actors["Service"]
}
export interface WorkflowDefinition<Name extends string, In extends Schema.Struct.Fields, Out extends Schema.Top, Errors extends ReadonlyArray<Schema.Top>> {
  readonly _kind: "workflow"
  readonly name: Name
  readonly input: Schema.Struct<In>
  readonly output: Out
  readonly errors: Errors
  /** run to completion (durable; resumes after crashes) */
  readonly execute: (input: Schema.Struct.Type<In>) => Effect.Effect<Out["Type"], Errors[number]["Type"], Actors>
  /** start and return the executionId */
  readonly start: (input: Schema.Struct.Type<In>) => Effect.Effect<string, never, Actors>
  readonly toLayer: <R>(
    run: (ctx: WorkflowContext, input: Schema.Struct.Type<In>) => Effect.Effect<Out["Type"], Errors[number]["Type"], R>
  ) => Layer.Layer<never, never, Exclude<R, Scope.Scope> | Actors>
  readonly workflow: Workflow.Workflow<Name, Schema.Struct<In>, Out, ErrorSchemaOf<Errors>>
}
export type AnyWorkflow = WorkflowDefinition<string, any, any, any>
export type WorkflowInput<W> = W extends WorkflowDefinition<any, infer In, any, any> ? Schema.Struct.Type<In> : never

/** The runtime. `actors.get(Counter, id)` is the non-sugared form of `Counter.get(id)`. */
export class Actors extends Context.Service<Actors, {
  readonly get: <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged, Ef extends AnyTagged, Mem>(
    actor: ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Mem>,
    id: Id["Type"],
    options?: GetOptions
  ) => Handle<Id, Cs, Qs, Ss, Ev>
  readonly sharding: Sharding.Sharding["Service"]
  readonly database: Database["Service"]
  readonly engine: WorkflowEngine.WorkflowEngine["Service"]
}>()("durable-actors/Actors") {}

export const make = <
  const Name extends string,
  const Cs extends ReadonlyArray<AnyCommand>,
  Id extends Schema.Top = typeof Schema.String,
  const Qs extends ReadonlyArray<AnyQuery> = [],
  const Ss extends ReadonlyArray<AnyStream> = [],
  const Ev extends AnyTagged = never,
  const Ef extends AnyTagged = never,
  Mem = void
>(
  name: Name,
  def: {
    readonly id?: Id
    readonly commands: Cs
    readonly queries?: Qs
    readonly streams?: Ss
    readonly events?: ReadonlyArray<Ev>
    readonly effects?: ReadonlyArray<Ef>
    readonly tables?: ReadonlyArray<OwnedTable>
    readonly lifecycle?: ReadonlyArray<Policy>
    readonly memory?: () => Mem
  }
): ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Mem> => {
  const commands = def.commands
  const queries = (def.queries ?? []) as unknown as Qs
  const streams = (def.streams ?? []) as unknown as Ss
  const lifecycle = def.lifecycle ?? []
  const policy = <T extends Policy["_tag"]>(tag: T) => lifecycle.find((p): p is Extract<Policy, { _tag: T }> => p._tag === tag)
  const toRpc = (d: AnyCommand | AnyQuery | AnyStream) =>
    Rpc.make(d.tag, {
      payload: d.input ?? Schema.Void,
      success: d.output,
      error: d.errors.length === 0 ? Schema.Never : Schema.Union(d.errors),
      stream: d._kind === "stream"
    })

  const rpcs = RpcGroup.make(...[...commands, ...queries, ...streams].map(toRpc)).annotateRpcs(ClusterSchema.Persisted, true) as any
  const entity = Entity.fromRpcGroup(name, RpcGroup.make(...[...commands, ...streams].map(toRpc)).annotateRpcs(ClusterSchema.Persisted, true)) as any

  const self: ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Mem> = {
    name,
    id: (def.id ?? Schema.String) as Id,
    commands,
    queries,
    streams,
    events: def.events ?? [],
    effects: def.effects ?? [],
    tables: def.tables ?? [],
    lifecycle,
    memory: def.memory ?? (() => undefined as Mem),
    get: (id, options) => Effect.map(Actors, (actors) => actors.get(self, id, options)),
    client: (options) => makePromiseClient(self, options),
    toLayer: ((build: unknown, options?: ServeOptions<Id, Ef, any>) =>
      entity
        .toLayer(
          Effect.gen(function*() {
            const address = yield* Entity.CurrentAddress
            const memory = yield* Ref.make(self.memory())
            const handlers: Record<string, (...args: Array<any>) => Effect.Effect<any, any, any> | Stream.Stream<any, any, any>> = Effect.isEffect(build)
              ? yield* (build as Effect.Effect<any>)
              : build
            yield* registerQueries(self, handlers)
            const wired: Record<string, (env: any) => unknown> = {}
            for (const d of commands) {
              wired[d.tag] = (env) => turn(address, env, lifecycle, options, memory, (ctx) => handlers[d.tag]!(ctx, env.payload) as Effect.Effect<any, any, any>)
            }
            for (const d of streams) {
              // Rpc.fork skips the entity's concurrency semaphore (RpcServer.ts: "if the handler requested forking")
              wired[d.tag] = (env) => Rpc.fork(streamTurn(address, memory, (ctx) => handlers[d.tag]!(ctx, env.payload) as Stream.Stream<any, any, any>))
            }
            return wired
          }),
          {
            concurrency: 1,
            maxIdleTime: policy("Hibernate")?.after ?? Duration.minutes(1),
            mailboxCapacity: policy("MailboxCapacity")?.size,
            defectRetryPolicy: policy("DefectRetry")?.schedule
          }
        )
        .pipe(Layer.provide(Layer.effect(Sharding.Sharding, Effect.map(Actors, (a) => a.sharding))))) as any,
    of: (handlers) => handlers,
    onCreate: (run) => ({ _tag: "OnCreate", run }),
    onWake: (run) => ({ _tag: "OnWake", run }),
    onSleep: (run) => ({ _tag: "OnSleep", run }),
    rpcs,
    entity
  }
  return self
}

export const workflow = <
  const Name extends string,
  const In extends Schema.Struct.Fields,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<Schema.Top> = []
>(
  name: Name,
  def: {
    readonly input: In
    readonly output?: Out
    readonly errors?: Errors
    readonly idempotencyKey: (input: Schema.Struct.Type<In>) => string
  }
): WorkflowDefinition<Name, In, Out, Errors> => {
  const output = (def.output ?? Schema.Void) as Out
  const errors = (def.errors ?? []) as Errors
  const wf = Workflow.make(name, {
    payload: def.input,
    idempotencyKey: def.idempotencyKey,
    success: output,
    error: errors.length === 0 ? Schema.Never : Schema.Union(errors)
  }) as any
  return {
    _kind: "workflow",
    name,
    input: Schema.Struct(def.input),
    output,
    errors,
    execute: (input) => Effect.flatMap(Actors, (actors) => Effect.provideService(wf.execute(input), WorkflowEngine.WorkflowEngine, actors.engine)),
    start: (input) => Effect.flatMap(Actors, (actors) => Effect.provideService(wf.execute(input, { discard: true }), WorkflowEngine.WorkflowEngine, actors.engine)),
    toLayer: ((run: (ctx: WorkflowContext, input: any) => Effect.Effect<any, any, any>) =>
      wf.toLayer((payload: any, executionId: string) => Effect.flatMap(Actors, (actors) => run(makeWorkflowContext(executionId, actors), payload)))
        .pipe(Layer.provide(Layer.effect(WorkflowEngine.WorkflowEngine, Effect.map(Actors, (a) => a.engine))))) as any,
    workflow: wf
  }
}

/**
 * One transaction per command. Not implemented here; see README "Turn".
 * BEGIN → SELECT actor_generations … FOR UPDATE → receipt lookup → (OnCreate on first turn) → handler
 *       → actor_events / actor_outbox / actor_intents / receipt → COMMIT → NOTIFY.
 * Retryable conditions (stale generation, lock timeout, commit-unknown, CommandTimeout) are defects.
 */
declare const turn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  envelope: unknown,
  lifecycle: ReadonlyArray<Policy>,
  options: ServeOptions<any, any, any> | undefined,
  memory: Ref.Ref<any>,
  body: (ctx: CommandContext<any, any, any, any, any>) => Effect.Effect<A, E, R>
) => Effect.Effect<A, E | CommandConflict, Exclude<R, Turn> | Actors>
declare const streamTurn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  memory: Ref.Ref<any>,
  body: (ctx: StreamContext<any, any>) => Stream.Stream<A, E, R>
) => Stream.Stream<A, E, Exclude<R, Query> | Actors>
/** Query handlers are registered in-process; `handle.Query()` runs them here, against Database. Missing registration is a defect (misconfiguration). */
declare const registerQueries: (actor: ActorDefinition<any, any, any, any, any, any, any, any>, handlers: Record<string, unknown>) => Effect.Effect<void, never, Actors>
declare const makePromiseClient: <Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged>(
  actor: ActorDefinition<any, Id, Cs, Qs, Ss, Ev, any, any>,
  options: { readonly baseUrl: string }
) => PromiseClient<Id, Cs, Qs, Ss, Ev>
declare const makeWorkflowContext: (executionId: string, actors: Actors["Service"]) => WorkflowContext
declare const makeHandle: <Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged>(
  runtime: { readonly sharding: Sharding.Sharding["Service"]; readonly database: Database["Service"] },
  actor: ActorDefinition<any, Id, Cs, Qs, Ss, Ev, any, any>,
  id: Id["Type"],
  options: GetOptions | undefined
) => Handle<Id, Cs, Qs, Ss, Ev>

/** Runtime layer: one per process. */
export const layer: Layer.Layer<Actors, never, Database | Sharding.Sharding | WorkflowEngine.WorkflowEngine> = Layer.effect(
  Actors,
  Effect.gen(function*() {
    const sharding = yield* Sharding.Sharding
    const database = yield* Database
    const engine = yield* WorkflowEngine.WorkflowEngine
    return Actors.of({ get: (actor, id, options) => makeHandle({ sharding, database }, actor, id, options), sharding, database, engine })
  })
)
/** `Actor.layer` over TestRunner + ClusterWorkflowEngine; the test provides Database (real Postgres). */
export declare const testLayer: Layer.Layer<Actors, never, Database>

export const Actor = { make, command, query, stream, workflow, layer, testLayer, tenant, as, commandId }
