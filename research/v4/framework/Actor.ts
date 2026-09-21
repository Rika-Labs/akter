/**
 * Durable Actors — proposed public surface (typecheck-only sketch, Effect 4.0.0-rc.116).
 *
 * Everything compiles down to Effect primitives:
 *   Actor.command / query / stream   →  Rpc.make (stream: true for streams, Persisted: false)
 *   Actor.make                       →  RpcGroup.make + Entity.fromRpcGroup (commands + streams only)
 *   X.toLayer                        →  Entity.toLayer({ concurrency: 1, maxIdleTime, mailboxCapacity, defectRetryPolicy })
 *   X.queries                        →  in-process query registry over Database (no entity, no Sharding)
 *   X.get(id)                        →  Sharding.makeClient(entity)(id), wrapped so methods are plain Effects
 *   Actor.workflow                   →  Workflow.make + Activity.make + DurableClock + DurableDeferred
 *   Actor.cron                       →  ClusterCron.make (cluster-wide, one run per schedule)
 *   Actor.commandId / tenant         →  Effect.provideService on a Context.Reference (ambient, with defaults)
 *   Actor.as / Actor.anonymous       →  Effect.provideService on CurrentCaller (no default: callers must be explicit)
 *   ctx.emit / perform / self.send   →  rows in actor_events / actor_outbox and envelopes in cluster_messages
 *   handle.events(E, { from })       →  actor_events replay + runner-side PubSub over a non-persisted Cluster stream
 *
 * The wrapping adds the contracts the framework promises: one transaction per command ("turn"),
 * generation fence, receipts keyed by commandId, typed channels everywhere, and "retryable = defect".
 *
 * Intents: inside `turn()` the framework inserts the intent envelopes into `cluster_messages` in the
 * same transaction (`MessageStorage.saveEnvelope` on the fiber-scoped transaction connection) and
 * notifies the target runner after COMMIT. On Neki that is a cross-shard-group transaction and needs
 * provider verification (see README "Verification gates").
 *
 * Receipts: a duplicate `commandId` carrying the same payload hash replays the stored `Exit`
 * (`Schema.Exit(output, Schema.Union(errors))`), declared failures included; a different payload for
 * the same `commandId` fails with `CommandConflict`.
 *
 * Observability: the framework opens the spans `actor.turn`, `actor.intent`, `actor.effect`,
 * `actor.query` and `actor.stream`, with the attributes `actor.type`, `actor.id`, `tenant`,
 * `command`, `commandId` and `generation`, so handlers do not name their own spans.
 *
 * `Drizzle`, `OwnedTable`, `Scoped` are placeholders for drizzle-orm/effect-postgres types so this
 * file typechecks from the repo root, where only `effect` is hoisted. Runtime internals are `declare`d.
 */
import { Cause, Context, Cron as EffectCron, DateTime, Duration, Effect, Layer, Option, Schedule, Schema, Scope, Stream } from "effect"
import type { ConfigError } from "effect/Config"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { ClusterSchema, Entity, EntityAddress, Sharding } from "effect/unstable/cluster"
import { AlreadyProcessingMessage, EntityNotAssignedToRunner, MailboxFull, PersistenceError } from "effect/unstable/cluster/ClusterError"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"
import type { Headers } from "effect/unstable/http/Headers"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/** Same commandId, different payload: the receipt does not match. Added to every command's E. */
export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  commandId: Schema.String
}, { httpApiStatus: 409 }) {}

/** Cluster could not deliver after `Delivery.retry`. `cause` keeps the original Cluster error. */
export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  reason: Schema.Literals(["mailbox_full", "already_processing", "persistence", "not_assigned"]),
  cause: Schema.Union([MailboxFull, AlreadyProcessingMessage, PersistenceError, EntityNotAssignedToRunner])
}, { httpApiStatus: 503 }) {}

/** The request carried no usable credentials: `Actor.auth` rejected the headers. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  reason: Schema.String
}, { httpApiStatus: 401 }) {}

/** The actor declares `Lifecycle.createdBy(Command)` and no creating command has run for this id. */
export class NotCreated extends Schema.TaggedError<NotCreated>()("NotCreated", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}

export const TenantId = Schema.String.pipe(Schema.brand("TenantId"))
export type TenantId = typeof TenantId.Type

/**
 * The application's authenticated subject. Empty here, augmented by the app:
 *
 *   declare module "durable-actors/Actor" {
 *     interface Principal { readonly userId: UserId }
 *   }
 */
export interface Principal {}

/** Who a command / query / stream runs for. `System` covers everything the framework starts itself. */
export type Caller =
  | { readonly _tag: "User"; readonly principal: Principal }
  | { readonly _tag: "System"; readonly source: "timer" | "cron" | "workflow" | "actor" | "effect"; readonly actor?: EntityAddress.EntityAddress }
  | { readonly _tag: "Anonymous" }

export const Caller = {
  user: (principal: Principal): Caller => ({ _tag: "User", principal }),
  anonymous: { _tag: "Anonymous" } as Caller,
  system: (source: "timer" | "cron" | "workflow" | "actor" | "effect", actor?: EntityAddress.EntityAddress): Caller => ({ _tag: "System", source, actor }),
  principal: (caller: Caller): Option.Option<Principal> => caller._tag === "User" ? Option.some(caller.principal) : Option.none()
}

/**
 * No default: every call from outside a turn has to say who it is for. Inside turns, workflows,
 * cron jobs and effect executors the framework provides `System`, so handles there have `R = never`.
 */
export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("durable-actors/Caller") {}

/** Ambient values with defaults. Set for a call with `Actor.tenant` / `Actor.commandId`. */
export const Tenant = Context.Reference<TenantId>("durable-actors/Tenant", { defaultValue: () => TenantId.make("default") })
export const CommandId = Context.Reference<string | undefined>("durable-actors/CommandId", { defaultValue: () => undefined })

export const tenant = (id: TenantId) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, Tenant, id)
export const as = (principal: Principal) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CurrentCaller, Caller.user(principal))
export const anonymous = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CurrentCaller, Caller.anonymous)
export const commandId = (id: string) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CommandId, id)

/** Placeholder for `EffectPgDatabase` from drizzle-orm/effect-postgres (same PgClient, joins Effect transactions). */
export interface Drizzle {
  readonly _: "drizzle-orm/effect-postgres EffectPgDatabase"
}
/** Placeholder for a drizzle table declared with `tenant_id` + `actor_id` columns (the Neki shard key). */
export interface OwnedTable<Name extends string, Cols extends Record<string, unknown>> {
  readonly _: "drizzle table with tenant_id, actor_id"
  readonly name: Name
  readonly columns: Cols
}
export type AnyTable = OwnedTable<string, Record<string, unknown>>
/** Placeholder for a drizzle query builder pre-filtered by (tenant_id, actor_id). */
export interface Scoped<T extends AnyTable> {
  readonly table: T
  readonly _: "query builder pre-filtered by (tenant_id, actor_id)"
}
/** Placeholder for the helper that adds `tenant_id`, `actor_id` and the composite index to a `pgTable`. */
export const table = <const Name extends string, Cols extends Record<string, unknown>>(name: Name, columns: Cols): OwnedTable<Name, Cols> =>
  ({ _: "drizzle table with tenant_id, actor_id", name, columns })

/** Nominal service: `PgClient` structurally extends `SqlClient`, so we never key on either directly. */
export class Database extends Context.Service<Database, {
  readonly sql: SqlClient
  readonly drizzle: Drizzle
}>()("durable-actors/Database") {
  /** `migrate: "auto"` runs the framework migrations at layer construction; `"manual"` defers to `Database.migrate`. */
  static readonly layer: (options: {
    readonly url: string
    readonly neki?: boolean
    readonly migrate?: "auto" | "manual"
  }) => Layer.Layer<Database, ConfigError | SqlError> = undefined as never
  /** The `"manual"` path: run the framework migrations explicitly (deploy job, test setup). */
  static readonly migrate: Effect.Effect<void, never, Database> = undefined as never
}

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
  | CreatedBy<AnyCommand>

/** Explicit creation: every other command fails with `NotCreated` until this one has run. */
export interface CreatedBy<C extends AnyCommand> {
  readonly _tag: "CreatedBy"
  readonly command: C
}

export const Hibernate = {
  after: (after: Duration.Input): Extract<Policy, { _tag: "Hibernate" }> => ({ _tag: "Hibernate", after })
}
export const Mailbox = {
  capacity: (size: number | "unbounded"): Extract<Policy, { _tag: "MailboxCapacity" }> => ({ _tag: "MailboxCapacity", size })
}
export const Defects = {
  retry: (schedule: Schedule.Schedule<any, unknown>): Extract<Policy, { _tag: "DefectRetry" }> => ({ _tag: "DefectRetry", schedule })
}
export const Delivery = {
  retry: (schedule: Schedule.Schedule<any, unknown>): Extract<Policy, { _tag: "DeliveryRetry" }> => ({ _tag: "DeliveryRetry", schedule })
}
export const Effects = {
  retry: (schedule: Schedule.Schedule<any, unknown>): Extract<Policy, { _tag: "EffectsRetry" }> => ({ _tag: "EffectsRetry", schedule })
}
export const Commands = {
  timeout: (after: Duration.Input): Extract<Policy, { _tag: "CommandTimeout" }> => ({ _tag: "CommandTimeout", after }),
  lockWait: (after: Duration.Input): Extract<Policy, { _tag: "LockWait" }> => ({ _tag: "LockWait", after })
}
export const Receipts = {
  keep: (keep: Duration.Input): Extract<Policy, { _tag: "ReceiptsRetention" }> => ({ _tag: "ReceiptsRetention", keep })
}
export const Events = {
  keep: (keep: Duration.Input | "forever"): Extract<Policy, { _tag: "EventsRetention" }> => ({ _tag: "EventsRetention", keep })
}
export const Cron = {
  /** Only zero-input commands: cron cannot supply a payload. */
  every: (expression: string, command: Command<string, undefined, any, any>): Extract<Policy, { _tag: "Cron" }> => ({ _tag: "Cron", expression, command })
}
export const Lifecycle = {
  /** Opt-in to explicit creation. The creating command itself never fails with `NotCreated`. */
  createdBy: <C extends AnyCommand>(command: C): CreatedBy<C> => ({ _tag: "CreatedBy", command })
}

type Args<C> = C extends { readonly input: infer I } ? (I extends Schema.Top ? [input: I["Type"]] : []) : []
type OutOf<C> = C extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never
type ErrOf<C> = C extends { readonly errors: infer Er extends ReadonlyArray<Schema.Top> } ? Er[number]["Type"] : never
type ErrorSchemaOf<Er extends ReadonlyArray<Schema.Top>> = Er extends readonly [] ? typeof Schema.Never : Schema.Union<Er>

/** `NotCreated` is added to every command except the one named by `Lifecycle.createdBy`. */
type CreatingTag<Ps extends ReadonlyArray<Policy>> = Extract<Ps[number], { readonly _tag: "CreatedBy" }>["command"]["tag"]
type CreationError<Ps extends ReadonlyArray<Policy>, C extends AnyCommand> = [Extract<Ps[number], { readonly _tag: "CreatedBy" }>] extends [never] ? never
  : C["tag"] extends CreatingTag<Ps> ? never
  : NotCreated

export interface GetOptions {
  /** explicit tenant; otherwise the ambient `Tenant` reference */
  readonly tenant?: TenantId
}
export interface IntentOptions {
  /** same key replaces the pending intent; cancel with ctx.timers.cancel(key) */
  readonly key?: string
}

/** One row of `actor_events`: the cursor (`sequence`) is what makes replay-then-live possible. */
export interface ActorEvent<E> {
  readonly sequence: number
  readonly at: DateTime.Utc
  readonly commandId: string
  readonly event: E
}
export interface EventsOptions {
  /** replay `actor_events` from this sequence (exclusive) and then join the live feed */
  readonly from?: number
}
/**
 * Fan-out goes through the actor's runner: after the turn commits, the activation publishes into its
 * PubSub and subscribers receive the events over a non-persisted Cluster stream. `from` replays
 * `actor_events` first and joins the live feed without a gap.
 */
export interface EventsMethod<Ev extends AnyTagged> {
  (options?: EventsOptions): Stream.Stream<ActorEvent<Ev["Type"]>, never, Scope.Scope>
  <E extends Ev>(event: E, options?: EventsOptions): Stream.Stream<ActorEvent<E["Type"]>, never, Scope.Scope>
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

export type Handle<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Ev extends AnyTagged,
  Ps extends ReadonlyArray<Policy>
> =
  & { readonly id: Id["Type"]; readonly address: EntityAddress.EntityAddress }
  & { readonly [C in Cs[number] as C["tag"]]: (...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C> | CommandConflict | ActorUnavailable | CreationError<Ps, C>, CurrentCaller> }
  /** queries run on the caller's node against committed rows: no Cluster hop, no ActorUnavailable */
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>, CurrentCaller> }
  /** streams run on the actor's node but are forked past the mailbox, and are live only (not persisted) */
  & { readonly [S in Ss[number] as S["tag"]]: (...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S> | ActorUnavailable, CurrentCaller> }
  & { readonly events: EventsMethod<Ev> }

/** Inside a workflow the caller is `System("workflow")` and delivery failures are the engine's problem. */
export type WorkflowHandle<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Ev extends AnyTagged,
  Ps extends ReadonlyArray<Policy>
> =
  & { readonly id: Id["Type"]; readonly address: EntityAddress.EntityAddress }
  & { readonly [C in Cs[number] as C["tag"]]: (...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C> | CreationError<Ps, C>> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>> }
  & { readonly [S in Ss[number] as S["tag"]]: (...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S>> }
  & { readonly events: EventsMethod<Ev> }

/** Derived, Promise-based client for non-Effect callers (browsers, coding agents). Same error classes, thrown. */
export type PromiseHandle<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged> =
  & { readonly id: Id["Type"] }
  & { readonly [C in Cs[number] as C["tag"]]: (...args: Args<C>) => Promise<OutOf<C>> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: Args<Q>) => Promise<OutOf<Q>> }
  & { readonly [S in Ss[number] as S["tag"]]: (...args: Args<S>) => AsyncIterable<OutOf<S>> }
  & { readonly events: <E extends Ev>(event: E, options?: EventsOptions) => AsyncIterable<ActorEvent<E["Type"]>> }
export interface PromiseClient<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged> {
  readonly get: (id: Id["Type"], options?: GetOptions) => PromiseHandle<Id, Cs, Qs, Ss, Ev>
}

export interface CommandContext<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Ev extends AnyTagged, Ef extends AnyTagged> {
  readonly address: EntityAddress.EntityAddress
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  /** framework-generated unless the caller piped `Actor.commandId`; receipts key on it */
  readonly commandId: string
  readonly caller: Caller
  readonly now: DateTime.Utc
  /** joined to the turn transaction */
  readonly db: Drizzle
  /** declared `tables`, pre-scoped to this actor */
  readonly rows: <T extends AnyTable>(table: T) => Scoped<T>
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
  /** tombstones this generation, deletes the declared `tables` rows and purges timers; later commands recreate the actor (or fail `NotCreated`) */
  readonly terminate: Effect.Effect<void>
}
/** Ambient access to the current turn from deep inside handler code. Present only inside a command handler. */
export class Turn extends Context.Service<Turn, CommandContext<any, any, any, any>>()("durable-actors/Turn") {}

/** Runs on the caller's node. No fence, no receipt, no transaction. */
export interface QueryContext<Id extends Schema.Top> {
  readonly address: EntityAddress.EntityAddress
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  readonly caller: Caller
  readonly db: Drizzle
  readonly rows: <T extends AnyTable>(table: T) => Scoped<T>
}
export class Query extends Context.Service<Query, QueryContext<any>>()("durable-actors/Query") {}

/**
 * Runs on the actor's node, forked past `concurrency: 1` (Rpc.fork), so a long stream never blocks
 * commands. Streams are live only: the rpc is annotated `Persisted: false`, so chunks never go
 * through `cluster_replies` and a reconnect starts a fresh stream.
 */
export interface StreamContext<Id extends Schema.Top> extends QueryContext<Id> {}

/** OnWake / OnSleep: no transaction, no caller. */
export interface WakeContext<Id extends Schema.Top> {
  readonly address: EntityAddress.EntityAddress
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  readonly db: Drizzle
  readonly rows: <T extends AnyTable>(table: T) => Scoped<T>
}

/** Outbox executor context. There is no `db`: results come back to the actor as intents on `ctx.self`. */
export interface EffectContext<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>> {
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  readonly attempt: number
  readonly self: IntentHandle<Cs>
}

export interface Hook<R> {
  readonly _tag: "OnCreate" | "OnWake" | "OnSleep" | "OnEffectFailed"
  readonly run: (...args: ReadonlyArray<any>) => Effect.Effect<void, never, R>
}

export type HandlersFor<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Ss extends ReadonlyArray<AnyStream>,
  Ev extends AnyTagged,
  Ef extends AnyTagged,
  R
> =
  & { readonly [C in Cs[number] as C["tag"]]: (ctx: CommandContext<Id, Cs, Ev, Ef>, ...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C>, R> }
  & { readonly [S in Ss[number] as S["tag"]]: (ctx: StreamContext<Id>, ...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S>, R> }

export type QueryHandlersFor<Id extends Schema.Top, Qs extends ReadonlyArray<AnyQuery>, R> = {
  readonly [Q in Qs[number] as Q["tag"]]: (ctx: QueryContext<Id>, ...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>, R>
}

export type EffectExecutors<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Ef extends AnyTagged, R> = {
  readonly [E in Ef as E["Type"]["_tag"]]: (effect: E["Type"], ctx: EffectContext<Id, Cs>) => Effect.Effect<void, unknown, R>
}

/** Server-side lifecycle: hooks and outbox executors carry code, so they live with `toLayer` / `X.of`. */
export interface ServeOptions<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Ef extends AnyTagged, RX> {
  readonly lifecycle?: ReadonlyArray<Hook<RX>>
  readonly effects?: EffectExecutors<Id, Cs, Ef, RX>
}

export const ServeTypeId = "~durable-actors/Serve" as const
export type ServeTypeId = typeof ServeTypeId

/** What `X.of(handlers, options)` returns: the handlers plus the closure the activation captured. */
export interface Serve<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Ss extends ReadonlyArray<AnyStream>,
  Ev extends AnyTagged,
  Ef extends AnyTagged,
  R,
  RX
> {
  readonly [ServeTypeId]: ServeTypeId
  readonly handlers: HandlersFor<Id, Cs, Ss, Ev, Ef, R>
  readonly lifecycle?: ReadonlyArray<Hook<RX>>
  readonly effects?: EffectExecutors<Id, Cs, Ef, RX>
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
  Ps extends ReadonlyArray<Policy>
> {
  readonly name: Name
  readonly id: Id
  readonly commands: Cs
  readonly queryDefs: Qs
  readonly streams: Ss
  readonly events: ReadonlyArray<Ev>
  readonly effects: ReadonlyArray<Ef>
  readonly tables: ReadonlyArray<AnyTable>
  readonly lifecycle: Ps
  /** `const counter = yield* Counter.get(id)` — resolves the runtime once; methods are then plain Effects. */
  readonly get: (id: Id["Type"], options?: GetOptions) => Effect.Effect<Handle<Id, Cs, Qs, Ss, Ev, Ps>, never, Actors>
  /** Promise client derived from `rpcs` over HTTP/WebSocket. */
  readonly client: (options: { readonly baseUrl: string }) => PromiseClient<Id, Cs, Qs, Ss, Ev>
  /** Lives in the server file. Handlers may be an object or an Effect returning `X.of(...)` (one closure per activation). */
  readonly toLayer: {
    <R, RX = never>(
      handlers: HandlersFor<Id, Cs, Ss, Ev, Ef, R>,
      options?: ServeOptions<Id, Cs, Ef, RX>
    ): Layer.Layer<never, never, Exclude<R | RX, Turn | Query> | Actors>
    <R, RX, RB>(
      build: Effect.Effect<Serve<Id, Cs, Ss, Ev, Ef, R, RX>, never, RB>
    ): Layer.Layer<never, never, Exclude<R | RB | RX, Scope.Scope | Turn | Query> | Actors>
  }
  /** Queries never touch the entity: they read committed rows on the caller's node. */
  readonly queries: {
    <R>(handlers: QueryHandlersFor<Id, Qs, R>): Layer.Layer<never, never, Exclude<R, Query> | Database>
    <R, RB>(build: Effect.Effect<QueryHandlersFor<Id, Qs, R>, never, RB>): Layer.Layer<never, never, Exclude<R | RB, Query | Scope.Scope> | Database>
  }
  /** packages the handlers with the activation closure's hooks and executors */
  readonly of: <R, RX = never>(
    handlers: HandlersFor<Id, Cs, Ss, Ev, Ef, R>,
    options?: ServeOptions<Id, Cs, Ef, RX>
  ) => Serve<Id, Cs, Ss, Ev, Ef, R, RX>
  /** identity with contextual typing, for query handlers returned from an Effect */
  readonly ofQueries: <R>(handlers: QueryHandlersFor<Id, Qs, R>) => QueryHandlersFor<Id, Qs, R>
  /** first turn ever for this id; runs inside that turn's transaction before the command handler */
  readonly onCreate: <R>(run: (ctx: CommandContext<Id, Cs, Ev, Ef>) => Effect.Effect<void, never, R>) => Hook<R>
  readonly onWake: <R>(run: (ctx: WakeContext<Id>) => Effect.Effect<void, never, R>) => Hook<R>
  readonly onSleep: <R>(run: (ctx: WakeContext<Id>) => Effect.Effect<void, never, R>) => Hook<R>
  /** runs inside a turn: the dead-lettered effect is delivered to the actor as a framework command after `Effects.retry` is exhausted */
  readonly onEffectFailed: <R>(
    run: (ctx: CommandContext<Id, Cs, Ev, Ef>, effect: Ef["Type"], cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R>
  ) => Hook<R>
  /** escape hatches: the Effect primitives underneath */
  readonly rpcs: RpcGroup.RpcGroup<RpcsOf<[...Cs, ...Qs, ...Ss]>>
  readonly entity: Entity.Entity<Name, RpcsOf<[...Cs, ...Ss]>>
}
/** Structural minimum shared by every actor definition, for APIs that only need identity. */
export interface AnyActor {
  readonly name: string
  readonly id: Schema.Top
}
export type HandleOf<A extends { readonly get: (...args: any) => Effect.Effect<any, any, any> }> = Effect.Success<ReturnType<A["get"]>>
/**
 * Structural, not `infer` on `ActorDefinition`: a concrete definition is not assignable to
 * `ActorDefinition<any, …>`, because the `any` tuples collapse `Handle`'s mapped types into string
 * index signatures. The same reason `HandleOf` reads `get` instead of destructuring the definition.
 */
export type EventsOf<A> = A extends { readonly events: ReadonlyArray<infer Ev extends AnyTagged> } ? Ev : never

export interface ActorIntents {
  readonly get: <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged, Ef extends AnyTagged, Ps extends ReadonlyArray<Policy>>(
    actor: ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Ps>,
    id: Id["Type"],
    options?: GetOptions
  ) => IntentHandle<Cs>
}

export interface WorkflowActors {
  readonly get: <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged, Ef extends AnyTagged, Ps extends ReadonlyArray<Policy>>(
    actor: ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Ps>,
    id: Id["Type"],
    options?: GetOptions
  ) => WorkflowHandle<Id, Cs, Qs, Ss, Ev, Ps>
}

export interface WorkflowContext {
  readonly executionId: string
  /**
   * Activity.make: the result is persisted, so output/errors need schemas. The framework pipes
   * `Actor.commandId(`${executionId}:${name}`)` around `run`, so command calls inside an activity
   * are idempotent across retries.
   */
  readonly activity: <Out extends Schema.Top, const Errors extends ReadonlyArray<Schema.Top>, R>(
    name: string,
    options: { readonly output: Out; readonly errors?: Errors; readonly run: Effect.Effect<Out["Type"], Errors[number]["Type"], R> }
  ) => Effect.Effect<Out["Type"], Errors[number]["Type"], R>
  /** DurableClock.sleep */
  readonly sleep: (duration: Duration.Input) => Effect.Effect<void>
  /** full handles: request/reply is fine inside a workflow (there is no turn to hold open) */
  readonly actors: WorkflowActors
  /**
   * DurableDeferred + a framework intent that resolves it when the actor emits `event`; `None` on
   * timeout. `event` is constrained to `EventsOf<typeof actor>`.
   */
  readonly waitFor: <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged, Ef extends AnyTagged, Ps extends ReadonlyArray<Policy>, E extends Ev>(
    actor: ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Ps>,
    id: Id["Type"],
    event: E,
    options?: { readonly timeout?: Duration.Input }
  ) => Effect.Effect<Option.Option<E["Type"]>>
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

/** A cluster-wide cron job (one run per schedule, not one per actor). The framework's caller is `System("cron")`. */
export interface CronDefinition<Name extends string> {
  readonly _kind: "cron"
  readonly name: Name
  readonly cron: EffectCron.Cron
  readonly toLayer: <R>(run: Effect.Effect<void, never, R>) => Layer.Layer<never, never, Exclude<R, Scope.Scope | CurrentCaller> | Actors>
}

/** The runtime. `actors.get(Counter, id)` is the non-sugared form of `Counter.get(id)`. */
export class Actors extends Context.Service<Actors, {
  readonly get: <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged, Ef extends AnyTagged, Ps extends ReadonlyArray<Policy>>(
    actor: ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Ps>,
    id: Id["Type"],
    options?: GetOptions
  ) => Handle<Id, Cs, Qs, Ss, Ev, Ps>
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
  const Ps extends ReadonlyArray<Policy> = []
>(
  name: Name,
  def: {
    readonly id?: Id
    readonly commands: Cs
    readonly queries?: Qs
    readonly streams?: Ss
    readonly events?: ReadonlyArray<Ev>
    readonly effects?: ReadonlyArray<Ef>
    readonly tables?: ReadonlyArray<AnyTable>
    readonly lifecycle?: Ps
  }
): ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Ps> => {
  const commands = def.commands
  const queries = (def.queries ?? []) as unknown as Qs
  const streams = (def.streams ?? []) as unknown as Ss
  const lifecycle = (def.lifecycle ?? []) as unknown as Ps
  const policy = <T extends Policy["_tag"]>(tag: T) =>
    (lifecycle as ReadonlyArray<Policy>).find((p): p is Extract<Policy, { _tag: T }> => p._tag === tag)
  const toRpc = (d: AnyCommand | AnyQuery | AnyStream) =>
    Rpc.make(d.tag, {
      payload: d.input ?? Schema.Void,
      success: d.output,
      error: d.errors.length === 0 ? Schema.Never : Schema.Union(d.errors),
      stream: d._kind === "stream"
    })
  // commands and queries are persisted (receipts, redelivery); streams are live only
  const group = (ds: ReadonlyArray<AnyCommand | AnyQuery | AnyStream>, persisted: boolean) =>
    RpcGroup.make(...ds.map(toRpc)).annotateRpcs(ClusterSchema.Persisted, persisted) as any

  const rpcs = group([...commands, ...queries], true).merge(group(streams, false)) as any
  const entity = Entity.fromRpcGroup(name, group(commands, true).merge(group(streams, false))) as any

  const self: ActorDefinition<Name, Id, Cs, Qs, Ss, Ev, Ef, Ps> = {
    name,
    id: (def.id ?? Schema.String) as Id,
    commands,
    queryDefs: queries,
    streams,
    events: def.events ?? [],
    effects: def.effects ?? [],
    tables: def.tables ?? [],
    lifecycle,
    get: (id, options) => Effect.map(Actors, (actors) => actors.get(self, id, options)),
    client: (options) => makePromiseClient(self, options),
    toLayer: ((build: unknown, options?: ServeOptions<Id, Cs, Ef, any>) =>
      entity
        .toLayer(
          Effect.gen(function*() {
            const address = yield* Entity.CurrentAddress
            const built = Effect.isEffect(build) ? yield* (build as Effect.Effect<any>) : build
            const serve = built[ServeTypeId] === ServeTypeId ? built : { handlers: built, ...options }
            const handlers: Record<string, (...args: Array<any>) => Effect.Effect<any, any, any> | Stream.Stream<any, any, any>> = serve.handlers
            const wired: Record<string, (env: any) => unknown> = {}
            for (const d of commands) {
              wired[d.tag] = (env) => turn(address, env, lifecycle, serve, (ctx) => handlers[d.tag]!(ctx, env.payload) as Effect.Effect<any, any, any>)
            }
            for (const d of streams) {
              // Rpc.fork skips the entity's concurrency semaphore (RpcServer.ts: "if the handler requested forking")
              wired[d.tag] = (env) => Rpc.fork(streamTurn(address, (ctx) => handlers[d.tag]!(ctx, env.payload) as Stream.Stream<any, any, any>))
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
    queries: ((build: unknown) =>
      Layer.effectDiscard(
        Effect.gen(function*() {
          const handlers = Effect.isEffect(build) ? yield* (build as Effect.Effect<any>) : build
          yield* registerQueries(self, handlers as Record<string, unknown>)
        })
      )) as any,
    of: (handlers, options) => ({ [ServeTypeId]: ServeTypeId, handlers, ...options }) as any,
    ofQueries: (handlers) => handlers,
    onCreate: (run) => ({ _tag: "OnCreate", run }),
    onWake: (run) => ({ _tag: "OnWake", run }),
    onSleep: (run) => ({ _tag: "OnSleep", run }),
    onEffectFailed: (run) => ({ _tag: "OnEffectFailed", run }),
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

/** `ClusterCron.make({ name, cron, execute })`: the schedule is owned by the cluster, not by each runner. */
export const cron = <const Name extends string>(name: Name, options: { readonly cron: string }): CronDefinition<Name> => {
  const parsed = EffectCron.parse(options.cron) as unknown as EffectCron.Cron
  return {
    _kind: "cron",
    name,
    cron: parsed,
    toLayer: ((run: Effect.Effect<void, never, any>) => clusterCronLayer(name, parsed, run)) as any
  }
}

/** Where the runners live. One tagged value instead of a bag of optional host/port settings. */
export type Topology =
  | { readonly _tag: "Single" } // SingleRunner.layer
  | { readonly _tag: "Http"; readonly listen: { readonly host: string; readonly port: number }; readonly advertise: { readonly host: string; readonly port: number } } // HttpRunner.layerHttp + RunnerHealth.layerPing
  | { readonly _tag: "K8s" } // HttpRunner.layerHttp + RunnerHealth.layerK8s

export const Topology = {
  single: (): Topology => ({ _tag: "Single" }),
  http: (options: {
    readonly listen: { readonly host: string; readonly port: number }
    readonly advertise: { readonly host: string; readonly port: number }
  }): Topology => ({ _tag: "Http", ...options }),
  k8s: (): Topology => ({ _tag: "K8s" })
}

/** Turns request headers into a `Principal`; used by `Actor.serve` and by the Rpc middleware for `CurrentCaller`. */
export interface Auth<R> {
  readonly handler: (headers: Headers) => Effect.Effect<Principal, Unauthorized, R>
}
export const auth = <R>(handler: (headers: Headers) => Effect.Effect<Principal, Unauthorized, R>): Auth<R> => ({ handler })

/**
 * One transaction per command. Not implemented here; see README "Turn".
 * BEGIN → SELECT actor_generations … FOR UPDATE → receipt lookup → (OnCreate on first turn) → handler
 *       → actor_events / actor_outbox / cluster_messages / receipt → COMMIT → NOTIFY.
 * Retryable conditions (stale generation, lock timeout, commit-unknown, CommandTimeout) are defects.
 */
declare const turn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  envelope: unknown,
  lifecycle: ReadonlyArray<Policy>,
  serve: { readonly lifecycle?: ReadonlyArray<Hook<any>>; readonly effects?: unknown } | undefined,
  body: (ctx: CommandContext<any, any, any, any>) => Effect.Effect<A, E, R>
) => Effect.Effect<A, E | CommandConflict, Exclude<R, Turn> | Actors>
declare const streamTurn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  body: (ctx: StreamContext<any>) => Stream.Stream<A, E, R>
) => Stream.Stream<A, E, Exclude<R, Query> | Actors>
/** Query handlers are registered in-process by the query layer; `handle.Query()` runs them here, against Database. */
declare const registerQueries: (actor: AnyActor, handlers: Record<string, unknown>) => Effect.Effect<void, never, Database>
declare const clusterCronLayer: (name: string, cron: EffectCron.Cron, run: Effect.Effect<void, never, any>) => Layer.Layer<never, never, Actors>
declare const makePromiseClient: <Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged>(
  actor: ActorDefinition<any, Id, Cs, Qs, Ss, Ev, any, any>,
  options: { readonly baseUrl: string }
) => PromiseClient<Id, Cs, Qs, Ss, Ev>
declare const makeWorkflowContext: (executionId: string, actors: Actors["Service"]) => WorkflowContext
declare const makeHandle: <Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Ev extends AnyTagged, Ps extends ReadonlyArray<Policy>>(
  runtime: { readonly sharding: Sharding.Sharding["Service"]; readonly database: Database["Service"] },
  actor: ActorDefinition<any, Id, Cs, Qs, Ss, Ev, any, Ps>,
  id: Id["Type"],
  options: GetOptions | undefined
) => Handle<Id, Cs, Qs, Ss, Ev, Ps>

/**
 * Runtime layer: one per process. It builds the runner from `topology` and provides `Sharding` and
 * `WorkflowEngine` internally, so actor layers only ever require `Actors`.
 */
export declare const layer: (options: {
  readonly principal: Schema.Top & { readonly Type: Principal }
  readonly topology: Topology
  readonly shardGroup?: (tenant: TenantId) => string
}) => Layer.Layer<Actors, ConfigError, Database>

/** HTTP entrypoint: serves `X.rpcs` for the given actors and derives `CurrentCaller` from the request headers. */
export declare const serve: <R = never>(options: {
  readonly actors: ReadonlyArray<AnyActor>
  readonly auth?: Auth<R>
}) => Layer.Layer<never, never, Actors | Exclude<R, Scope.Scope>>

/** `Actor.layer` over TestRunner + ClusterWorkflowEngine; the test provides Database (real Postgres). */
export declare const testLayer: Layer.Layer<Actors, never, Database>

export const Actor = { make, command, query, stream, workflow, cron, table, layer, testLayer, serve, auth, tenant, as, anonymous, commandId }
