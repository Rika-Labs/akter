/**
 * Durable Actors — proposed public surface (typecheck-only sketch, Effect 4.0.0-rc.116).
 * Embodies DECISIONS.md 1–150. Everything compiles down to Effect primitives:
 *
 *   primitives  Actor.make        →  RpcGroup.make + Entity.fromRpcGroup, Persisted: true, one transaction per command ("turn")
 *               Actor.ephemeral   →  the same Entity, Persisted: false, no transaction, `memory` in the activation closure
 *               Workflow.make     →  Workflow.make + Activity.make + DurableClock + DurableDeferred   (alias: Actor.workflow)
 *   facilities  Durable.cron      →  ClusterCron.make (one run per schedule, cluster-wide)              (alias: Actor.cron)
 *               Durable.singleton →  Singleton.make(name, run, { shardGroup })                          (alias: Actor.singleton)
 *   members   Actor.command / query / stream / connection   →  Rpc.make (stream: true for streams and connections)
 *             Actor.table / blob                             →  drizzle pgTable with (tenant_id, actor_id); actor_blobs
 *   runtime   Actor.layer / serve / auth / toolkit / mcp     →  Sharding + WorkflowEngine; HttpRouter + RpcServer; ai/Toolkit; McpServer
 *   ambient   Actor.as / tenant / commandId                  →  Effect.provideService on CurrentCaller / Tenant / CommandId
 *
 * The wrapping adds the contracts the framework promises: a generation fence, receipts keyed by a
 * client-minted commandId, typed channels everywhere, intents/events/effects committed with the turn,
 * "retryable = defect", and a caller on every handle.
 *
 * `Drizzle`, `OwnedTable`, `Scoped` are placeholders for drizzle-orm/effect-postgres types so this file
 * typechecks from the repo root, where only `effect` is hoisted. Runtime internals are `declare`d.
 *
 * @since 0.1.0
 */
import { Cause, Config, Context, Cron as EffectCron, DateTime, Duration, Effect, Exit, Layer, Option, Redacted, Schedule, Schema, Scope, Stream } from "effect"
import type { ConfigError } from "effect/Config"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { ClusterSchema, Entity, EntityAddress, Sharding } from "effect/unstable/cluster"
import { AlreadyProcessingMessage, EntityNotAssignedToRunner, MailboxFull, PersistenceError } from "effect/unstable/cluster/ClusterError"
import { Workflow as EffectWorkflow, WorkflowEngine } from "effect/unstable/workflow"
import type { Tool, Toolkit } from "effect/unstable/ai"
import type { Headers } from "effect/unstable/http/Headers"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

// ---------------------------------------------------------------------------------------------------
// Identity: tenant, ref, principal, caller
// ---------------------------------------------------------------------------------------------------

/** @category identity */
export const TenantId = Schema.String.pipe(Schema.brand("TenantId"))
export type TenantId = typeof TenantId.Type
/** One per deployment sharing a database (decision 147); set in `Actor.layer({ deployment })`. @category identity */
export const DeploymentId = Schema.String.pipe(Schema.brand("DeploymentId"))
export type DeploymentId = typeof DeploymentId.Type
export const Deployment = Context.Reference<DeploymentId>("durable-actors/Deployment", { defaultValue: () => DeploymentId.make("default") })

/**
 * Where an actor lives, in user terms. Serializable (rides in headers, events and errors), printable,
 * usable as a map key via `ActorRef.key`. Cluster's `EntityAddress` stays internal (decision 100).
 * @category identity
 */
export class ActorRef extends Schema.Class<ActorRef>("durable-actors/ActorRef")({
  actor: Schema.String,
  tenant: TenantId,
  id: Schema.String
}) {
  static readonly key = (ref: ActorRef): string => `${ref.tenant}/${ref.actor}/${ref.id}`
  override toString(): string {
    return `${this.actor}/${this.id}`
  }
}

/**
 * The application's authenticated subject. Empty here, augmented by the app:
 *
 *   declare module "durable-actors" {
 *     interface Principal { readonly userId: UserId }
 *   }
 * @category identity
 */
export interface Principal {}

/** @category identity */
export type SystemSource = "timer" | "cron" | "workflow" | "actor" | "effect" | "run" | "singleton"

/**
 * Who a command / query / stream / connection runs for. `System` covers everything the framework starts
 * itself and remembers the principal it acts for (decision 91): a timer armed by Alice runs as
 * `System("timer", { onBehalfOf: Alice })`.
 * @category identity
 */
export type Caller =
  | { readonly _tag: "User"; readonly principal: Principal }
  | { readonly _tag: "System"; readonly source: SystemSource; readonly ref: Option.Option<ActorRef>; readonly onBehalfOf: Option.Option<Principal> }
  | { readonly _tag: "Anonymous" }

export const Caller = {
  user: (principal: Principal): Caller => ({ _tag: "User", principal }),
  anonymous: { _tag: "Anonymous" } as Caller,
  system: (source: SystemSource, options?: { readonly ref?: ActorRef; readonly onBehalfOf?: Principal }): Caller => ({
    _tag: "System",
    source,
    ref: Option.fromNullishOr(options?.ref),
    onBehalfOf: Option.fromNullishOr(options?.onBehalfOf)
  }),
  /** the user, or the principal a system caller acts for */
  principal: (caller: Caller): Option.Option<Principal> =>
    caller._tag === "User" ? Option.some(caller.principal) : caller._tag === "System" ? caller.onBehalfOf : Option.none()
}

/**
 * No default: a handle cannot exist without a caller (decision 89). `X.get(id)` requires it from the
 * context or takes it as `{ as }`; inside turns, workflows, cron, singletons and executors the framework
 * provides `System`.
 * @category identity
 */
export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("durable-actors/CurrentCaller") {}

/** Ambient values with defaults. Set for a call with `Actor.tenant` / `Actor.commandId`. @category runtime */
export const Tenant = Context.Reference<TenantId>("durable-actors/Tenant", { defaultValue: () => TenantId.make("default") })
/**
 * `undefined` means "the handle mints one when the call runs" (decision 113): a UUID is generated inside
 * `Effect.suspend`, so one run of the Effect keeps the same id across `Delivery.retry` and a re-run mints
 * a new one. `turn()` never generates ids; raw HTTP callers without `x-command-id` get one minted at the edge.
 */
export const CommandId = Context.Reference<string | undefined>("durable-actors/CommandId", { defaultValue: () => undefined })

/** Binds the tenant for the `get` / `Actors.get` / `W.start` inside `self`. A handle keeps the tenant it was resolved with. @category runtime */
export const tenant = (id: TenantId) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, Tenant, id)
/** @category runtime */
export const as = (who: Principal | Caller) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CurrentCaller, toCaller(who))
/** @category runtime */
export const anonymous = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CurrentCaller, Caller.anonymous)
/** @category runtime */
export const commandId = (id: string) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CommandId, id)

const isCaller = (who: Principal | Caller): who is Caller => typeof who === "object" && who !== null && "_tag" in who
const toCaller = (who: Principal | Caller): Caller => isCaller(who) ? who : Caller.user(who)

// ---------------------------------------------------------------------------------------------------
// Errors (decisions 26, 105, 106). Every framework error says what happened and what to do next.
// ---------------------------------------------------------------------------------------------------

/** Same commandId, different payload: the receipt does not match. On every command's `E`. @category errors */
export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  ref: ActorRef,
  command: Schema.String,
  commandId: Schema.String
}, { httpApiStatus: 409 }) {
  readonly retryable = false
  override get message(): string {
    return `${this.ref}: commandId ${this.commandId} was already used for ${this.command} with a different input. Reuse the same input to replay the receipt, or use a new commandId.`
  }
}

/** Cluster could not deliver after `Delivery.retry`. `cause` keeps the original Cluster error. @category errors */
export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  ref: ActorRef,
  command: Schema.String,
  reason: Schema.Literals(["mailbox_full", "already_processing", "persistence", "not_assigned"]),
  retryAfter: Schema.Option(Schema.Duration),
  cause: Schema.Union([MailboxFull, AlreadyProcessingMessage, PersistenceError, EntityNotAssignedToRunner])
}, { httpApiStatus: 503 }) {
  readonly retryable = true
  override get message(): string {
    const after = Option.match(this.retryAfter, { onNone: () => "shortly", onSome: (d) => `after ${Duration.format(d)}` })
    return `${this.ref}: ${this.command} was not delivered (${this.reason}). Retry ${after} with the same commandId.`
  }
}

/** The request carried no usable credentials: `Actor.auth` rejected the headers. @category errors */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  reason: Schema.Literals(["missing_credentials", "invalid_credentials", "expired"])
}, { httpApiStatus: 401 }) {
  readonly retryable = false
  override get message(): string {
    return `Unauthorized: ${this.reason.replace("_", " ")}. Send a valid credential in the Authorization header.`
  }
}

/** The actor declares `Lifecycle.createdBy(Command)` and no creating command has run for this id. @category errors */
export class NotCreated extends Schema.TaggedError<NotCreated>()("NotCreated", {
  ref: ActorRef,
  createdBy: Schema.String
}, { httpApiStatus: 404 }) {
  readonly retryable = false
  override get message(): string {
    return `${this.ref} does not exist yet: call ${this.createdBy} first.`
  }
}

/**
 * Boundary only (decision 106): thrown by the Promise client and served over HTTP when the body fails
 * the input schema. Never on an Effect handle's `E`: its inputs are typed.
 * @category errors
 */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  command: Schema.String,
  issues: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.String), message: Schema.String }))
}, { httpApiStatus: 400 }) {
  readonly retryable = false
  override get message(): string {
    return `${this.command}: invalid input — ${this.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
  }
}

/** Boundary only: network failures and non-actor responses seen by the Promise client. `requestId` = commandId (107). @category errors */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  status: Schema.Option(Schema.Number),
  requestId: Schema.Option(Schema.String),
  body: Schema.Option(Schema.String)
}) {
  readonly retryable = true
  override get message(): string {
    return `transport error${Option.match(this.status, { onNone: () => "", onSome: (s) => ` (HTTP ${s})` })}${Option.match(this.requestId, { onNone: () => "", onSome: (r) => `, request ${r}` })}`
  }
}

/**
 * Declared errors are yieldable tagged errors (decision 97): `errors: [Schema.String]` does not compile.
 * A declared error without `httpApiStatus` maps to 422 on HTTP.
 * @category errors
 */
export type AnyError = Schema.Top & { readonly Type: { readonly _tag: string } & Cause.YieldableError }

// ---------------------------------------------------------------------------------------------------
// Database, tables, rows (decisions 9, 10, 32, 64, 103, 104, 118)
// ---------------------------------------------------------------------------------------------------

/** Placeholder for `EffectPgDatabase` from drizzle-orm/effect-postgres (same PgClient, joins Effect transactions). */
export interface Drizzle {
  readonly _: "drizzle-orm/effect-postgres EffectPgDatabase"
}

/** Column kinds the sketch understands; real code uses drizzle column builders. @category members */
export type ColumnKind = "text" | "integer" | "bigint" | "numeric" | "boolean" | "timestamptz" | "jsonb" | "bytea"
export type ColumnType<K extends ColumnKind> =
  K extends "text" ? string
  : K extends "integer" | "numeric" ? number
  : K extends "bigint" ? bigint
  : K extends "boolean" ? boolean
  : K extends "timestamptz" ? DateTime.Utc
  : K extends "jsonb" ? unknown
  : K extends "bytea" ? Uint8Array
  : never

/** Placeholder for a drizzle table declared with `tenant_id` + `actor_id` columns (the Neki shard key). @category members */
export interface OwnedTable<Name extends string, Cols extends Record<string, ColumnKind>> {
  readonly _kind: "table"
  readonly name: Name
  readonly columns: Cols
}
export type AnyTable = OwnedTable<string, Record<string, ColumnKind>>
/** The row type of an `Actor.table`, without the framework's `tenant_id` / `actor_id`. */
export type Row<T extends AnyTable> = { readonly [K in keyof T["columns"]]: ColumnType<T["columns"][K]> }

export interface ReadOptions<T extends AnyTable> {
  readonly where?: Partial<Row<T>>
  readonly orderBy?: keyof Row<T> | { readonly column: keyof Row<T>; readonly direction: "asc" | "desc" }
  readonly limit?: number
}
/**
 * The read half of `ctx.rows(table)`: what query, stream, connection and wake contexts get (decision
 * 103). A write from a query fails to compile rather than running outside the fence.
 * @category contexts
 */
export interface ScopedRead<T extends AnyTable> {
  readonly table: T
  readonly one: (options?: { readonly where?: Partial<Row<T>> }) => Effect.Effect<Option.Option<Row<T>>>
  readonly all: (options?: ReadOptions<T>) => Effect.Effect<ReadonlyArray<Row<T>>>
  readonly count: (options?: { readonly where?: Partial<Row<T>> }) => Effect.Effect<number>
}
/** `ctx.rows(table)` inside a command: pre-filtered by (tenant_id, actor_id), joined to the turn transaction. @category contexts */
export interface Scoped<T extends AnyTable> extends ScopedRead<T> {
  readonly insert: (row: Row<T>) => Effect.Effect<void>
  readonly update: (patch: Partial<Row<T>>, options?: { readonly where?: Partial<Row<T>> }) => Effect.Effect<void>
  /** conflict target defaults to (tenant_id, actor_id): the one-row-per-actor case */
  readonly upsert: (row: Partial<Row<T>>, options?: { readonly on?: ReadonlyArray<keyof Row<T>> }) => Effect.Effect<void>
  readonly delete: (options?: { readonly where?: Partial<Row<T>> }) => Effect.Effect<void>
}
/** Adds `tenant_id`, `actor_id` and the composite index to a drizzle `pgTable`. @category members */
export const table = <const Name extends string, const Cols extends Record<string, ColumnKind>>(name: Name, columns: Cols): OwnedTable<Name, Cols> =>
  ({ _kind: "table", name, columns })

/** Nominal service: `PgClient` structurally extends `SqlClient`, so we never key on either directly. @category runtime */
export class Database extends Context.Service<Database, {
  readonly sql: SqlClient
  readonly drizzle: Drizzle
}>()("durable-actors/Database") {
  /** `migrate: "auto"` runs the framework migrations at layer construction; `"manual"` defers to `Database.migrate`. */
  static readonly layer: (options: {
    readonly url: Redacted.Redacted<string>
    readonly neki?: boolean
    readonly migrate?: "auto" | "manual"
  }) => Layer.Layer<Database, ConfigError | SqlError> = undefined as never
  /** `DATABASE_URL` (redacted), `DATABASE_NEKI`, `DATABASE_MIGRATE` — Effect `Config`, prefix overridable. */
  static readonly layerConfig: (options?: { readonly prefix?: string }) => Layer.Layer<Database, ConfigError | SqlError> = undefined as never
  /** The `"manual"` path: run the framework migrations explicitly (deploy job, test setup). */
  static readonly migrate: Effect.Effect<void, never, Database> = undefined as never
}

// ---------------------------------------------------------------------------------------------------
// Members: command, query, stream, connection, blob (decisions 2, 19, 95–97, 117, 126, 131)
// ---------------------------------------------------------------------------------------------------

/** @category members */
export interface Command<Tag extends string, In extends Schema.Top | undefined, Out extends Schema.Top, Errors extends ReadonlyArray<AnyError>, Desc extends string | undefined = string | undefined> {
  readonly _kind: "command"
  readonly tag: Tag
  readonly input: In
  readonly output: Out
  readonly errors: Errors
  readonly description: Desc
  readonly deprecated: boolean
}
/** @category members */
export interface QueryDef<Tag extends string, In extends Schema.Top | undefined, Out extends Schema.Top, Errors extends ReadonlyArray<AnyError>, Desc extends string | undefined = string | undefined> {
  readonly _kind: "query"
  readonly tag: Tag
  readonly input: In
  readonly output: Out
  readonly errors: Errors
  readonly description: Desc
  readonly deprecated: boolean
}
/** @category members */
export interface StreamDef<Tag extends string, In extends Schema.Top | undefined, Out extends Schema.Top, Errors extends ReadonlyArray<AnyError>, Desc extends string | undefined = string | undefined> {
  readonly _kind: "stream"
  readonly tag: Tag
  readonly input: In
  readonly output: Out
  readonly errors: Errors
  readonly description: Desc
  readonly deprecated: boolean
}
/**
 * A typed bidirectional session on the activation (decision 126): `server` frames go actor → client,
 * `client` frames go client → actor (ephemeral signals; durable changes are commands). `state` is
 * per-connection, in memory.
 * @category members
 */
export interface ConnectionDef<
  Tag extends string,
  Params extends Schema.Top | undefined,
  Server extends Schema.Top,
  Client extends Schema.Top,
  State extends Schema.Struct.Fields,
  Errors extends ReadonlyArray<AnyError>,
  Desc extends string | undefined = string | undefined
> {
  readonly _kind: "connection"
  readonly tag: Tag
  readonly params: Params
  readonly server: Server
  readonly client: Client
  readonly state: State
  readonly errors: Errors
  readonly description: Desc
  readonly deprecated: boolean
}
/** A large per-actor binary outside the state cap (decision 131): rows in `actor_blobs(tenant_id, actor_id, key, seq, data)`. @category members */
export interface BlobDef<Key extends string> {
  readonly _kind: "blob"
  readonly key: Key
}
export type AnyCommand = Command<string, any, any, any, any>
export type AnyQuery = QueryDef<string, any, any, any, any>
export type AnyStream = StreamDef<string, any, any, any, any>
export type AnyConnection = ConnectionDef<string, any, any, any, any, any, any>
export type AnyBlob = BlobDef<string>
/** Events and effects are `Schema.TaggedClass` values. */
export type AnyTagged = Schema.Top & { readonly Type: { readonly _tag: string } }

/** `input` may be a schema (positional arg), struct fields (object arg), or omitted (no arg). */
type NormalizeInput<In> = In extends Schema.Top ? In : In extends Schema.Struct.Fields ? Schema.Struct<In> : undefined
const normalizeInput = (input: unknown): Schema.Top | undefined =>
  input === undefined ? undefined : Schema.isSchema(input) ? input : Schema.Struct(input as Schema.Struct.Fields)

interface Definition<In, Out, Errors, Desc> {
  /** one or two sentences for humans, OpenAPI, tools and llms.txt; `Actor.toolkit` requires it (decision 96) */
  readonly description?: Desc
  readonly input?: In
  readonly output?: Out
  readonly errors?: Errors
  /** `OpenApi.Deprecated`, tool description prefix, llms.txt section (decision 117) */
  readonly deprecated?: boolean
}

const define = (kind: "command" | "query" | "stream", tag: string, def: Definition<unknown, Schema.Top, ReadonlyArray<AnyError>, string | undefined> | undefined) => ({
  _kind: kind,
  tag,
  input: normalizeInput(def?.input),
  output: def?.output ?? Schema.Void,
  errors: def?.errors ?? [],
  description: def?.description,
  deprecated: def?.deprecated ?? false
})

/** @category members */
export const command = <
  const Tag extends string,
  In extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<AnyError> = [],
  const Desc extends string | undefined = undefined
>(tag: Tag, def?: Definition<In, Out, Errors, Desc>): Command<Tag, NormalizeInput<In>, Out, Errors, Desc> => define("command", tag, def) as any

/** @category members */
export const query = <
  const Tag extends string,
  In extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<AnyError> = [],
  const Desc extends string | undefined = undefined
>(tag: Tag, def?: Definition<In, Out, Errors, Desc>): QueryDef<Tag, NormalizeInput<In>, Out, Errors, Desc> => define("query", tag, def) as any

/** @category members */
export const stream = <
  const Tag extends string,
  In extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<AnyError> = [],
  const Desc extends string | undefined = undefined
>(tag: Tag, def?: Definition<In, Out, Errors, Desc>): StreamDef<Tag, NormalizeInput<In>, Out, Errors, Desc> => define("stream", tag, def) as any

/** @category members */
export const connection = <
  const Tag extends string,
  Params extends Schema.Top | Schema.Struct.Fields | undefined = undefined,
  Server extends Schema.Top = typeof Schema.Never,
  Client extends Schema.Top = typeof Schema.Never,
  const State extends Schema.Struct.Fields = {},
  const Errors extends ReadonlyArray<AnyError> = [],
  const Desc extends string | undefined = undefined
>(tag: Tag, def: {
  readonly description?: Desc
  readonly params?: Params
  readonly server?: Server
  readonly client?: Client
  readonly state?: State
  readonly errors?: Errors
  readonly deprecated?: boolean
}): ConnectionDef<Tag, NormalizeInput<Params>, Server, Client, State, Errors, Desc> => ({
  _kind: "connection",
  tag,
  params: normalizeInput(def.params),
  server: def.server ?? Schema.Never,
  client: def.client ?? Schema.Never,
  state: def.state ?? {},
  errors: def.errors ?? [],
  description: def.description,
  deprecated: def.deprecated ?? false
}) as any

/** @category members */
export const blob = <const Key extends string>(key: Key): BlobDef<Key> => ({ _kind: "blob", key })

// ---------------------------------------------------------------------------------------------------
// Policies (decisions 21–23, 27, 52, 98, 101, 125, 133): contract-side, serializable, `Policy<C>` names this actor's commands
// ---------------------------------------------------------------------------------------------------

export interface HibernatePolicy { readonly _tag: "Hibernate"; readonly after: Duration.Input } // Entity.toLayer maxIdleTime
export interface MailboxPolicy { readonly _tag: "MailboxCapacity"; readonly size: number | "unbounded" } // Entity.toLayer mailboxCapacity
export interface DefectsPolicy { readonly _tag: "DefectRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // Entity.toLayer defectRetryPolicy
export interface DeliveryPolicy { readonly _tag: "DeliveryRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // client-side retry before ActorUnavailable
export interface EffectsPolicy { readonly _tag: "EffectsRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // outbox executor retry before dead-letter
export interface CommandTimeoutPolicy { readonly _tag: "CommandTimeout"; readonly after: Duration.Input } // turn(): handler timeout → defect → redelivery
export interface LockWaitPolicy { readonly _tag: "LockWait"; readonly after: Duration.Input } // turn(): SET LOCAL lock_timeout on the generation fence
export interface ReceiptsPolicy { readonly _tag: "ReceiptsRetention"; readonly keep: Duration.Input } // actor_receipts purge (never before cluster_messages)
export interface EventsPolicy { readonly _tag: "EventsRetention"; readonly keep: Duration.Input | "forever" } // actor_events purge
export interface StatePolicy { readonly _tag: "StateMaxBytes"; readonly bytes: number | `${number} KiB` | `${number} MiB` } // exceeding is a defect: "move `x` to a table"
/** Per-actor timer re-armed after each run. Only zero-input commands: cron cannot supply a payload. */
export interface CronPolicy<C extends AnyCommand> { readonly _tag: "Cron"; readonly expression: string; readonly command: C }
/** Explicit creation: every other command fails with `NotCreated` until this one has run. */
export interface CreatedBy<C extends AnyCommand> { readonly _tag: "CreatedBy"; readonly command: C }

/**
 * Contract-side lifecycle. `C` is the actor's own command union, so `Cron.every(expr, Foreign)` and
 * `Lifecycle.createdBy(Foreign)` fail to compile on the wrong actor (decision 98).
 * @category policies
 */
export type Policy<C extends AnyCommand = AnyCommand> =
  | HibernatePolicy
  | MailboxPolicy
  | DefectsPolicy
  | DeliveryPolicy
  | EffectsPolicy
  | CommandTimeoutPolicy
  | LockWaitPolicy
  | ReceiptsPolicy
  | EventsPolicy
  | StatePolicy
  | CronPolicy<C>
  | CreatedBy<C>
/** What an ephemeral actor may declare: no receipts, events, effects, state or creation to govern (decision 133). @category policies */
export type EphemeralPolicy<C extends AnyCommand = AnyCommand> = Extract<Policy<C>, { readonly _tag: "Hibernate" | "MailboxCapacity" | "DefectRetry" | "DeliveryRetry" | "CommandTimeout" | "Cron" }>

/** @category policies */
export const Hibernate = {
  after: (after: Duration.Input): HibernatePolicy => ({ _tag: "Hibernate", after })
}
/** @category policies */
export const Mailbox = {
  capacity: (size: number | "unbounded"): MailboxPolicy => ({ _tag: "MailboxCapacity", size })
}
/** @category policies */
export const Defects = {
  retry: (schedule: Schedule.Schedule<any, unknown>): DefectsPolicy => ({ _tag: "DefectRetry", schedule })
}
/** @category policies */
export const Delivery = {
  retry: (schedule: Schedule.Schedule<any, unknown>): DeliveryPolicy => ({ _tag: "DeliveryRetry", schedule })
}
/** @category policies */
export const Effects = {
  retry: (schedule: Schedule.Schedule<any, unknown>): EffectsPolicy => ({ _tag: "EffectsRetry", schedule })
}
/** @category policies */
export const Commands = {
  timeout: (after: Duration.Input): CommandTimeoutPolicy => ({ _tag: "CommandTimeout", after }),
  lockWait: (after: Duration.Input): LockWaitPolicy => ({ _tag: "LockWait", after })
}
/** @category policies */
export const Receipts = {
  keep: (keep: Duration.Input): ReceiptsPolicy => ({ _tag: "ReceiptsRetention", keep })
}
/** @category policies */
export const Events = {
  keep: (keep: Duration.Input | "forever"): EventsPolicy => ({ _tag: "EventsRetention", keep })
}
/** Keyed state size cap; default `"64 KiB"`. @category policies */
export const State = {
  maxBytes: (bytes: StatePolicy["bytes"]): StatePolicy => ({ _tag: "StateMaxBytes", bytes })
}
/** @category policies */
export const Cron = {
  every: <C extends Command<string, undefined, any, any, any>>(expression: string, command: C): CronPolicy<C> => ({ _tag: "Cron", expression, command })
}
/** @category policies */
export const Lifecycle = {
  /** Opt-in to explicit creation. The creating command itself never fails with `NotCreated`. */
  createdBy: <C extends AnyCommand>(command: C): CreatedBy<C> => ({ _tag: "CreatedBy", command })
}
/** One place to find every policy when typing `Policy.` (decision 101); the individual exports stay. @category policies */
export const Policy = { Hibernate, Mailbox, Defects, Delivery, Effects, Commands, Receipts, Events, State, Cron, Lifecycle }

// ---------------------------------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------------------------------

type Args<C> = C extends { readonly input: infer I } ? (I extends Schema.Top ? [input: I["Type"]] : []) : []
type ParamsArgs<N> = N extends { readonly params: infer P } ? (P extends Schema.Top ? [params: P["Type"]] : []) : []
type OutOf<C> = C extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never
type ErrOf<C> = C extends { readonly errors: infer Er extends ReadonlyArray<Schema.Top> } ? Er[number]["Type"] : never
type ServerOf<N> = N extends { readonly server: infer S extends Schema.Top } ? S["Type"] : never
type ClientOf<N> = N extends { readonly client: infer S extends Schema.Top } ? S["Type"] : never
type ConnStateOf<N> = N extends { readonly state: infer S extends Schema.Struct.Fields } ? S : {}
type ErrorSchemaOf<Er extends ReadonlyArray<Schema.Top>> = Er extends readonly [] ? typeof Schema.Never : Schema.Union<Er>

/** `NotCreated` is added to every command except the one named by `Lifecycle.createdBy`. */
type CreatingTag<Ps extends ReadonlyArray<Policy<any>>> = Extract<Ps[number], { readonly _tag: "CreatedBy" }>["command"]["tag"]
type CreationError<Ps extends ReadonlyArray<Policy<any>>, C extends AnyCommand> = [Extract<Ps[number], { readonly _tag: "CreatedBy" }>] extends [never] ? never
  : C["tag"] extends CreatingTag<Ps> ? never
  : NotCreated
/** Outside handles, HTTP, the Promise client and toolkits see only non-internal commands (decision 95). */
type Public<Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>> = Exclude<Cs[number], Is[number]>

/** Keyed state (decision 125): synchronous reads, `set` writes only the dirty keys at commit. */
export type StateValues<S extends Schema.Struct.Fields> = Schema.Struct.Type<S>
export type StateHandle<S extends Schema.Struct.Fields> = Readonly<StateValues<S>> & {
  readonly set: (patch: Partial<StateValues<S>>) => Effect.Effect<void>
}
/** Ephemeral memory (decision 133) and per-connection state: in the activation closure, typed by the declared fields. */
export type MemoryHandle<M extends Schema.Struct.Fields> = Readonly<StateValues<M>> & {
  readonly set: (patch: Partial<StateValues<M>>) => Effect.Effect<void>
  readonly update: (f: (current: StateValues<M>) => StateValues<M>) => Effect.Effect<void>
}

/**
 * @category contexts
 * Writable only inside a turn (decision 136): every write rides the turn transaction. `onWake`, `onSleep`
 * and `run` see `BlobRead`; compaction is a command (usually `internal`) the actor sends itself.
 */
export interface BlobHandle {
  readonly get: Effect.Effect<Option.Option<Uint8Array>>
  readonly set: (data: Uint8Array) => Effect.Effect<void>
  /** appends one update to the blob's log (update-log CRDTs); `compact` folds the log inside a later turn */
  readonly append: (update: Uint8Array) => Effect.Effect<void>
  readonly compact: (merge: (parts: ReadonlyArray<Uint8Array>) => Uint8Array) => Effect.Effect<void>
}
export interface BlobRead {
  readonly get: Effect.Effect<Option.Option<Uint8Array>>
}

/**
 * Request/reply inside a turn is a readable type error (decision 110). A handler whose Effect needs
 * `Actors` or `CurrentCaller` called an outside handle; the fix is named in the key.
 */
export type InsideTurn<R> = [Extract<R, Actors | CurrentCaller>] extends [never] ? unknown
  : { readonly "Request/reply inside a turn is not allowed: use ctx.actors.get(Other, id).Command.send(...) or ctx.self.Command.send(...)": never }

/**
 * Runtime twin of `InsideTurn` (decision 146). The type check only sees requirements, and a handle bound before the
 * turn has `R = never`, so `turn()` also sets this reference around the handler and every outside operation
 * (`X.get`, handle methods, `Actors.get`, `W.start`) dies when it finds it `true`. Not a user customization point.
 * @internal
 */
export const InActorTurn = Context.Reference<boolean>("durable-actors/InActorTurn", { defaultValue: () => false })
/** @internal wraps every outside operation */
export const outsideTurn = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(InActorTurn, (inside) =>
    inside
      ? Effect.die(new Error("Request/reply inside a turn is not allowed: use ctx.actors.get(Other, id).Command.send(...) or ctx.self.Command.send(...)"))
      : self)

// ---------------------------------------------------------------------------------------------------
// Handles (decisions 7, 17, 19, 20, 89, 95, 99, 100, 114, 119, 126)
// ---------------------------------------------------------------------------------------------------

/** @category clients */
export interface GetOptions {
  /** explicit tenant; otherwise `Actor.layer({ tenant })` derives it from the principal, else the ambient `Tenant` reference */
  readonly tenant?: TenantId
  /** bind the caller here instead of taking it from the context */
  readonly as?: Principal | Caller
}
export interface IntentOptions {
  /** same key replaces the pending intent; cancel with ctx.timers.cancel(key) */
  readonly key?: string
}

/** One row of `actor_events`: the cursor (`sequence`) is what makes replay-then-live possible. @category clients */
export interface ActorEvent<E> {
  readonly sequence: number
  readonly at: DateTime.Utc
  readonly commandId: string
  readonly event: E
}
export interface EventsOptions {
  /** replay `actor_events` after this sequence (sequences start at 1; `after: 0` is "from the beginning") and then join the live feed */
  readonly after?: number
}
/**
 * Fan-out goes through the actor's runner: after the turn commits, the activation publishes into its
 * PubSub and subscribers receive the events over a non-persisted Cluster stream. rc.116 streams own
 * their scope, so `R = never` (decision 99).
 */
export interface EventsMethod<Ev extends AnyTagged> {
  (options?: EventsOptions): Stream.Stream<ActorEvent<Ev["Type"]>>
  <E extends Ev>(event: E, options?: EventsOptions): Stream.Stream<ActorEvent<E["Type"]>>
}

export const ConnectionId = Schema.String.pipe(Schema.brand("ConnectionId"))
export type ConnectionId = typeof ConnectionId.Type
/** An open session from the Effect side: frames in, `send` out, closed with the scope. @category clients */
export interface Connection<Server, Client> {
  readonly id: ConnectionId
  readonly frames: Stream.Stream<Server>
  readonly send: (frame: Client) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
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

/** The outside handle: caller bound at `get`, so every method has `R = never` (decision 89). @category clients */
export type Handle<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Is extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>,
  Ev extends AnyTagged,
  Ps extends ReadonlyArray<Policy<any>>
> =
  & { readonly id: Id["Type"]; readonly ref: ActorRef }
  & { readonly [C in Public<Cs, Is> as C["tag"]]: (...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C> | CommandConflict | ActorUnavailable | CreationError<Ps, C>> }
  /** queries run on the caller's node against committed rows: no Cluster hop, no ActorUnavailable */
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>> }
  /** streams run on the actor's node but are forked past the mailbox, and are live only (not persisted) */
  & { readonly [S in Ss[number] as S["tag"]]: (...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S> | ActorUnavailable> }
  /** connections are scoped: closing the scope closes the socket */
  & { readonly [N in Cn[number] as N["tag"]]: (...args: ParamsArgs<N>) => Effect.Effect<Connection<ServerOf<N>, ClientOf<N>>, ErrOf<N> | ActorUnavailable, Scope.Scope> }
  & { readonly events: EventsMethod<Ev> }

/** Inside a workflow the caller is `System("workflow", { onBehalfOf })`, internal commands are reachable, and delivery failures are the engine's problem. */
export type WorkflowHandle<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Ev extends AnyTagged,
  Ps extends ReadonlyArray<Policy<any>>
> =
  & { readonly id: Id["Type"]; readonly ref: ActorRef }
  & { readonly [C in Cs[number] as C["tag"]]: (...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C> | CreationError<Ps, C>> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>> }
  & { readonly [S in Ss[number] as S["tag"]]: (...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S>> }
  & { readonly events: EventsMethod<Ev> }

/** Ephemeral handles: no receipts, so no `CommandConflict`; no creation, so no `NotCreated`; queries go to the activation (memory lives there). */
export type EphemeralHandle<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Is extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>
> =
  & { readonly id: Id["Type"]; readonly ref: ActorRef }
  & { readonly [C in Public<Cs, Is> as C["tag"]]: (...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C> | ActorUnavailable> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q> | ActorUnavailable> }
  & { readonly [S in Ss[number] as S["tag"]]: (...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S> | ActorUnavailable> }
  & { readonly [N in Cn[number] as N["tag"]]: (...args: ParamsArgs<N>) => Effect.Effect<Connection<ServerOf<N>, ClientOf<N>>, ErrOf<N> | ActorUnavailable, Scope.Scope> }

/** Trailing options on every Promise-client call (decision 114). @category clients */
export interface CallOptions {
  /** idempotency key; minted by the client and reused on retry when omitted */
  readonly commandId?: string
  readonly signal?: AbortSignal
}
export interface StreamOptions {
  readonly signal?: AbortSignal
}
export interface PromiseConnection<Server, Client> extends AsyncIterable<Server> {
  readonly id: ConnectionId
  readonly send: (frame: Client) => Promise<void>
  readonly close: () => void
}
/** Derived, Promise-based client for non-Effect callers (browsers, coding agents). Same error classes, thrown, plus `InvalidInput | Unauthorized | TransportError`. @category clients */
export type PromiseHandle<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Is extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>,
  Ev extends AnyTagged
> =
  & { readonly id: Id["Type"] }
  & { readonly [C in Public<Cs, Is> as C["tag"]]: (...args: [...Args<C>, options?: CallOptions]) => Promise<OutOf<C>> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (...args: [...Args<Q>, options?: StreamOptions]) => Promise<OutOf<Q>> }
  & { readonly [S in Ss[number] as S["tag"]]: (...args: [...Args<S>, options?: StreamOptions]) => AsyncIterable<OutOf<S>> }
  & { readonly [N in Cn[number] as N["tag"]]: (...args: [...ParamsArgs<N>, options?: StreamOptions]) => PromiseConnection<ServerOf<N>, ClientOf<N>> }
  & {
    readonly events: {
      (options?: EventsOptions & StreamOptions): AsyncIterable<ActorEvent<Ev["Type"]>>
      <E extends Ev>(event: E, options?: EventsOptions & StreamOptions): AsyncIterable<ActorEvent<E["Type"]>>
    }
  }
/** @category clients */
export interface ClientOptions {
  readonly baseUrl: string
  readonly headers?: Record<string, string>
  readonly fetch?: typeof fetch
  readonly timeoutInMs?: number
}
export interface PromiseClient<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Is extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>,
  Ev extends AnyTagged
> {
  readonly get: (id: Id["Type"], options?: { readonly tenant?: TenantId }) => PromiseHandle<Id, Cs, Is, Qs, Ss, Cn, Ev>
}

// ---------------------------------------------------------------------------------------------------
// Contexts (decisions 9–13, 21–24, 91, 100, 103, 104, 108, 125–127, 131)
// ---------------------------------------------------------------------------------------------------

export interface ConnectionInfo {
  readonly id: ConnectionId
  readonly caller: Caller
  readonly openedAt: DateTime.Utc
}
/** Broadcast is queued inside a command and flushed after COMMIT (like `emit`, not persisted); immediate elsewhere. */
export interface Connections<Cn extends ReadonlyArray<AnyConnection>> {
  readonly broadcast: (frame: ServerOf<Cn[number]>, options?: { readonly except?: ConnectionId }) => Effect.Effect<void>
  readonly list: Effect.Effect<ReadonlyArray<ConnectionInfo>>
}

interface Identity<Id extends Schema.Top> {
  readonly ref: ActorRef
  readonly id: Id["Type"]
  readonly tenantId: TenantId
  readonly now: DateTime.Utc
}
interface Attributed {
  readonly caller: Caller
  /** the user, or the principal a system caller acts for (decision 91) */
  readonly principal: Option.Option<Principal>
}

/** One transaction; the fence has been taken; `rows`, `state`, `blob` write into it. @category contexts */
export interface CommandContext<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Ev extends AnyTagged,
  Ef extends AnyTagged,
  S extends Schema.Struct.Fields,
  Bs extends ReadonlyArray<AnyBlob>,
  Cn extends ReadonlyArray<AnyConnection>
> extends Identity<Id>, Attributed {
  /** minted by the caller (or the edge); receipts key on it; stable across retries (decision 113) */
  readonly commandId: string
  /** joined to the turn transaction: joins and anything `rows` cannot say */
  readonly db: Drizzle
  /** declared `tables`, pre-scoped to this actor */
  readonly rows: <T extends AnyTable>(table: T) => Scoped<T>
  /** declared `state` keys, loaded after the fence; `ctx.state.count` reads, `yield* ctx.state.set({...})` writes */
  readonly state: StateHandle<S>
  readonly blob: <B extends Bs[number]>(blob: B) => BlobHandle
  /** durable intents to self; no request/reply inside a turn */
  readonly self: IntentHandle<Cs>
  /** durable intents to other actors */
  readonly actors: ActorIntents
  readonly workflows: {
    readonly start: <W extends AnyWorkflow>(workflow: W, input: WorkflowInput<W>) => Effect.Effect<void>
    /** intent: the engine interrupts the run after COMMIT */
    readonly cancel: <W extends AnyWorkflow>(workflow: W, idempotencyKey: string) => Effect.Effect<void>
  }
  readonly timers: {
    readonly cancel: (key: string) => Effect.Effect<void>
  }
  /** typed to the actor's declared `events`; delivered after commit */
  readonly emit: (event: Ev["Type"]) => Effect.Effect<void>
  /** typed to the actor's declared `effects`; executed after commit, at least once, by the executor in the server file */
  readonly perform: (effect: Ef["Type"]) => Effect.Effect<void>
  readonly connections: Connections<Cn>
  /** tombstones this generation, deletes the declared `tables` rows and purges timers; later commands recreate the actor (or fail `NotCreated`) */
  readonly terminate: Effect.Effect<void>
}
/** Ambient access to the current turn from deep inside handler code. Present only inside a command handler. @category contexts */
export class Turn extends Context.Service<Turn, CommandContext<any, any, any, any, any, any, any>>()("durable-actors/Turn") {}

/** Runs on the caller's node. No fence, no receipt, no transaction; reads are structurally read-only (decision 103). @category contexts */
export interface QueryContext<Id extends Schema.Top, S extends Schema.Struct.Fields, Bs extends ReadonlyArray<AnyBlob>> extends Identity<Id>, Attributed {
  readonly db: Drizzle
  readonly rows: <T extends AnyTable>(table: T) => ScopedRead<T>
  /** committed snapshot */
  readonly state: Readonly<StateValues<S>>
  readonly blob: <B extends Bs[number]>(blob: B) => BlobRead
}
export class Query extends Context.Service<Query, QueryContext<any, any, any>>()("durable-actors/Query") {}

/**
 * Runs on the actor's node, forked past `concurrency: 1` (Rpc.fork), so a long stream never blocks
 * commands. Live only: the rpc is annotated `Persisted: false`, a reconnect starts a fresh stream.
 * @category contexts
 */
export interface StreamContext<Id extends Schema.Top, S extends Schema.Struct.Fields, Bs extends ReadonlyArray<AnyBlob>, Ev extends AnyTagged, Cn extends ReadonlyArray<AnyConnection>>
  extends QueryContext<Id, S, Bs> {
  readonly events: EventsMethod<Ev>
  readonly connections: Connections<Cn>
}
/** A connection handler runs on the activation for the life of the socket. @category contexts */
export interface ConnectionContext<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  S extends Schema.Struct.Fields,
  Bs extends ReadonlyArray<AnyBlob>,
  Ev extends AnyTagged,
  Cn extends ReadonlyArray<AnyConnection>,
  N extends AnyConnection
> extends StreamContext<Id, S, Bs, Ev, Cn> {
  readonly conn: {
    readonly id: ConnectionId
    readonly caller: Caller
    readonly state: MemoryHandle<ConnStateOf<N>>
  }
  /** durable intents from a connection handler (a durable change is still a command); typed to this actor's commands */
  readonly self: IntentHandle<Cs>
}

/**
 * OnWake / OnSleep: no transaction, no caller, so nothing here writes (decision 136): rows, state and blobs
 * are the committed snapshot. Maintenance that writes (compaction, backfills) is an `internal` command the
 * hook schedules with `ctx.self`.
 * @category contexts
 */
export interface WakeContext<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, S extends Schema.Struct.Fields, Bs extends ReadonlyArray<AnyBlob>> extends Identity<Id> {
  readonly db: Drizzle
  readonly rows: <T extends AnyTable>(table: T) => ScopedRead<T>
  readonly state: Readonly<StateValues<S>>
  readonly blob: <B extends Bs[number]>(blob: B) => BlobRead
  readonly self: IntentHandle<Cs>
}
/**
 * `run` (decision 127): a long-lived loop on the activation, started on wake, interrupted on sleep. No
 * transaction, no `rows` writes: durable changes are intents; `state` is the committed snapshot,
 * refreshed after each turn. A `run` fiber does not keep the actor awake.
 * @category contexts
 */
export interface RunContext<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  S extends Schema.Struct.Fields,
  Bs extends ReadonlyArray<AnyBlob>,
  Ev extends AnyTagged,
  Cn extends ReadonlyArray<AnyConnection>
> extends WakeContext<Id, Cs, S, Bs> {
  readonly events: EventsMethod<Ev>
  readonly actors: ActorIntents
  readonly connections: Connections<Cn>
}

/** Outbox executor context. There is no `db`: results come back to the actor as intents on `ctx.self`. @category contexts */
export interface EffectContext<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>> extends Identity<Id> {
  readonly commandId: string
  readonly attempt: number
  readonly principal: Option.Option<Principal>
  readonly self: IntentHandle<Cs>
}

/** Ephemeral command context: memory instead of rows, in-memory intents to self, no emit/perform/db. @category contexts */
export interface MemoryContext<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  M extends Schema.Struct.Fields,
  Cn extends ReadonlyArray<AnyConnection>
> extends Identity<Id>, Attributed {
  readonly commandId: string
  readonly memory: MemoryHandle<M>
  /** in-memory intents (lost with the activation) */
  readonly self: IntentHandle<Cs>
  readonly actors: ActorIntents
  readonly connections: Connections<Cn>
}
export interface MemoryReadContext<Id extends Schema.Top, M extends Schema.Struct.Fields, Cn extends ReadonlyArray<AnyConnection>> extends Identity<Id>, Attributed {
  readonly memory: Readonly<StateValues<M>>
  readonly connections: Connections<Cn>
}
export interface MemoryConnectionContext<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, M extends Schema.Struct.Fields, Cn extends ReadonlyArray<AnyConnection>, N extends AnyConnection>
  extends MemoryReadContext<Id, M, Cn> {
  readonly conn: {
    readonly id: ConnectionId
    readonly caller: Caller
    readonly state: MemoryHandle<ConnStateOf<N>>
  }
  readonly self: IntentHandle<Cs>
}

// ---------------------------------------------------------------------------------------------------
// Server-side: handlers, hooks, executors, run (decisions 11, 23, 108, 109, 127)
// ---------------------------------------------------------------------------------------------------

export interface Hook<R> {
  readonly _tag: "OnCreate" | "OnWake" | "OnSleep" | "OnEffectFailed"
  readonly run: (...args: ReadonlyArray<any>) => Effect.Effect<void, never, R>
}

export type HandlersFor<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>,
  Ev extends AnyTagged,
  Ef extends AnyTagged,
  S extends Schema.Struct.Fields,
  Bs extends ReadonlyArray<AnyBlob>,
  R
> =
  & { readonly [C in Cs[number] as C["tag"]]: (ctx: CommandContext<Id, Cs, Ev, Ef, S, Bs, Cn>, ...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C>, R> }
  & { readonly [St in Ss[number] as St["tag"]]: (ctx: StreamContext<Id, S, Bs, Ev, Cn>, ...args: Args<St>) => Stream.Stream<OutOf<St>, ErrOf<St>, R> }
  & { readonly [N in Cn[number] as N["tag"]]: (ctx: ConnectionContext<Id, Cs, S, Bs, Ev, Cn, N>, ...args: [...ParamsArgs<N>, inbound: Stream.Stream<ClientOf<N>>]) => Stream.Stream<ServerOf<N>, ErrOf<N>, R> }

export type QueryHandlersFor<Id extends Schema.Top, Qs extends ReadonlyArray<AnyQuery>, S extends Schema.Struct.Fields, Bs extends ReadonlyArray<AnyBlob>, R> = {
  readonly [Q in Qs[number] as Q["tag"]]: (ctx: QueryContext<Id, S, Bs>, ...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>, R>
}

/** `(ctx, effect)`: the same argument order as every other handler (decision 108). */
export type EffectExecutors<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Ef extends AnyTagged, R> = {
  readonly [E in Ef as E["Type"]["_tag"]]: (ctx: EffectContext<Id, Cs>, effect: E["Type"]) => Effect.Effect<void, unknown, R>
}

/** Server-side: hooks and executors carry code, so they live with `toLayer` / `X.of` under `hooks:` (decision 109). */
export interface ServeOptions<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Ef extends AnyTagged,
  Ev extends AnyTagged,
  S extends Schema.Struct.Fields,
  Bs extends ReadonlyArray<AnyBlob>,
  Cn extends ReadonlyArray<AnyConnection>,
  RX
> {
  readonly hooks?: ReadonlyArray<Hook<RX>>
  readonly effects?: EffectExecutors<Id, Cs, Ef, RX>
  readonly run?: (ctx: RunContext<Id, Cs, S, Bs, Ev, Cn>) => Effect.Effect<void, never, RX>
}

export const ServeTypeId = "~durable-actors/Serve" as const
export type ServeTypeId = typeof ServeTypeId

/** What `X.of(handlers, options)` returns: the handlers plus the closure the activation captured. */
export interface Serve<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>,
  Ev extends AnyTagged,
  Ef extends AnyTagged,
  S extends Schema.Struct.Fields,
  Bs extends ReadonlyArray<AnyBlob>,
  R,
  RX
> {
  readonly [ServeTypeId]: ServeTypeId
  readonly handlers: HandlersFor<Id, Cs, Ss, Cn, Ev, Ef, S, Bs, R>
  readonly hooks?: ReadonlyArray<Hook<RX>>
  readonly effects?: EffectExecutors<Id, Cs, Ef, RX>
  readonly run?: (ctx: RunContext<Id, Cs, S, Bs, Ev, Cn>) => Effect.Effect<void, never, RX>
}

type RpcOfDef<D> = D extends Command<infer T, infer I, infer O, infer Er, any>
  ? Rpc.Rpc<T, I extends Schema.Top ? I : typeof Schema.Void, O, ErrorSchemaOf<Er>>
  : D extends QueryDef<infer T, infer I, infer O, infer Er, any>
    ? Rpc.Rpc<T, I extends Schema.Top ? I : typeof Schema.Void, O, ErrorSchemaOf<Er>>
    : D extends StreamDef<infer T, infer I, infer O, infer Er, any>
      ? Rpc.Rpc<T, I extends Schema.Top ? I : typeof Schema.Void, RpcSchema.Stream<O, ErrorSchemaOf<Er>>, typeof Schema.Never>
      : never
export type RpcsOf<Ds extends ReadonlyArray<AnyCommand | AnyQuery | AnyStream>> = Extract<RpcOfDef<Ds[number]>, Rpc.Any>

// ---------------------------------------------------------------------------------------------------
// Kinds: Actor.make (decisions 1–13, 89–134)
// ---------------------------------------------------------------------------------------------------

/** @category kinds */
export interface ActorDefinition<
  Name extends string,
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Is extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>,
  Ev extends AnyTagged,
  Ef extends AnyTagged,
  S extends Schema.Struct.Fields,
  Bs extends ReadonlyArray<AnyBlob>,
  Ps extends ReadonlyArray<Policy<any>>,
  Desc extends string | undefined
> {
  readonly _kind: "actor"
  readonly name: Name
  readonly description: Desc
  readonly id: Id
  readonly commands: Cs
  readonly internal: Is
  readonly queries: Qs
  readonly streams: Ss
  readonly connections: Cn
  readonly events: ReadonlyArray<Ev>
  readonly effects: ReadonlyArray<Ef>
  readonly tables: ReadonlyArray<AnyTable>
  readonly state: S
  readonly blobs: Bs
  readonly lifecycle: Ps
  /**
   * `const counter = yield* Counter.get(id)` — resolves the runtime and binds the caller once; methods
   * are then plain Effects with `R = never`. `{ as }` binds the caller explicitly; otherwise it comes
   * from the context (`Actor.as` on the program, the HTTP middleware, `ActorTest.layer({ as })`).
   */
  readonly get: {
    (id: Id["Type"], options: GetOptions & { readonly as: Principal | Caller }): Effect.Effect<Handle<Id, Cs, Is, Qs, Ss, Cn, Ev, Ps>, never, Actors>
    (id: Id["Type"], options?: GetOptions): Effect.Effect<Handle<Id, Cs, Is, Qs, Ss, Cn, Ev, Ps>, never, Actors | CurrentCaller>
  }
  /** Promise client derived from `rpcs` over HTTP/WebSocket; mints `x-command-id` per call and reuses it on retry. */
  readonly client: (options: ClientOptions) => PromiseClient<Id, Cs, Is, Qs, Ss, Cn, Ev>
  /** Lives in the server file. Handlers may be an object or an Effect returning `X.of(...)` (one closure per activation). */
  readonly toLayer: {
    <R, RX = never>(
      handlers: HandlersFor<Id, Cs, Ss, Cn, Ev, Ef, S, Bs, R> & InsideTurn<R>,
      options?: ServeOptions<Id, Cs, Ef, Ev, S, Bs, Cn, RX>
    ): Layer.Layer<never, never, Exclude<R | RX, Turn | Query> | Actors>
    <R, RX, RB>(
      build: Effect.Effect<Serve<Id, Cs, Ss, Cn, Ev, Ef, S, Bs, R, RX>, never, RB>
    ): Layer.Layer<never, never, Exclude<R | RB | RX, Scope.Scope | Turn | Query> | Actors>
  }
  /** Queries never touch the entity: they read committed rows on the caller's node (decisions 4, 102). */
  readonly toQueryLayer: {
    <R>(handlers: QueryHandlersFor<Id, Qs, S, Bs, R>): Layer.Layer<never, never, Exclude<R, Query> | Database>
    <R, RB>(build: Effect.Effect<QueryHandlersFor<Id, Qs, S, Bs, R>, never, RB>): Layer.Layer<never, never, Exclude<R | RB, Query | Scope.Scope> | Database>
  }
  /** packages the handlers with the activation closure's hooks, executors and run loop */
  readonly of: <R, RX = never>(
    handlers: HandlersFor<Id, Cs, Ss, Cn, Ev, Ef, S, Bs, R> & InsideTurn<R>,
    options?: ServeOptions<Id, Cs, Ef, Ev, S, Bs, Cn, RX>
  ) => Serve<Id, Cs, Ss, Cn, Ev, Ef, S, Bs, R, RX>
  /** identity with contextual typing, for query handlers returned from an Effect */
  readonly ofQueries: <R>(handlers: QueryHandlersFor<Id, Qs, S, Bs, R>) => QueryHandlersFor<Id, Qs, S, Bs, R>
  /** first turn ever for this id; runs inside that turn's transaction before the command handler */
  readonly onCreate: <R>(run: (ctx: CommandContext<Id, Cs, Ev, Ef, S, Bs, Cn>) => Effect.Effect<void, never, R>) => Hook<R>
  readonly onWake: <R>(run: (ctx: WakeContext<Id, Cs, S, Bs>) => Effect.Effect<void, never, R>) => Hook<R>
  readonly onSleep: <R>(run: (ctx: WakeContext<Id, Cs, S, Bs>) => Effect.Effect<void, never, R>) => Hook<R>
  /** runs inside a turn: the dead-lettered effect is delivered to the actor as a framework command after `Effects.retry` is exhausted */
  readonly onEffectFailed: <R>(
    run: (ctx: CommandContext<Id, Cs, Ev, Ef, S, Bs, Cn>, effect: Ef["Type"], cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R>
  ) => Hook<R>
  /** escape hatches: the Effect primitives underneath */
  readonly rpcs: RpcGroup.RpcGroup<RpcsOf<[...Cs, ...Qs, ...Ss]>>
  readonly entity: Entity.Entity<Name, RpcsOf<[...Cs, ...Ss]>>
}

/** Structural minimum shared by every actor kind, for APIs that only need identity (decision 134: members are not servable). */
export interface AnyActor {
  readonly _kind: "actor" | "ephemeral"
  readonly name: string
  readonly description: string | undefined
  readonly id: Schema.Top
}
export type HandleOf<A extends { readonly get: (...args: any) => Effect.Effect<any, any, any> }> = Effect.Success<ReturnType<A["get"]>>
/**
 * Structural, not `infer` on `ActorDefinition`: a concrete definition is not assignable to
 * `ActorDefinition<any, …>`, because the `any` tuples collapse `Handle`'s mapped types into string
 * index signatures. The same reason `HandleOf` reads `get` instead of destructuring the definition.
 */
export type EventsOf<A> = A extends { readonly events: ReadonlyArray<infer Ev extends AnyTagged> } ? Ev : never
export type StateOf<A> = A extends { readonly state: infer S extends Schema.Struct.Fields } ? StateValues<S> : never
export type MemoryOf<A> = A extends { readonly memory: infer M extends Schema.Struct.Fields } ? StateValues<M> : never

export interface ActorIntents {
  readonly get: {
    <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, Ev extends AnyTagged, Ef extends AnyTagged, S extends Schema.Struct.Fields, Bs extends ReadonlyArray<AnyBlob>, Ps extends ReadonlyArray<Policy<any>>, Desc extends string | undefined>(
      actor: ActorDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, Ev, Ef, S, Bs, Ps, Desc>,
      id: Id["Type"],
      options?: { readonly tenant?: TenantId }
    ): IntentHandle<Cs>
    <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, M extends Schema.Struct.Fields, Ps extends ReadonlyArray<EphemeralPolicy<any>>, Desc extends string | undefined>(
      actor: EphemeralDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, M, Ps, Desc>,
      id: Id["Type"],
      options?: { readonly tenant?: TenantId }
    ): IntentHandle<Cs>
  }
}

/** @category kinds */
export const make = <
  const Name extends string,
  Id extends Schema.Top,
  const Cs extends ReadonlyArray<AnyCommand>,
  const Is extends ReadonlyArray<Cs[number]> = [],
  const Qs extends ReadonlyArray<AnyQuery> = [],
  const Ss extends ReadonlyArray<AnyStream> = [],
  const Cn extends ReadonlyArray<AnyConnection> = [],
  const Ev extends AnyTagged = never,
  const Ef extends AnyTagged = never,
  const S extends Schema.Struct.Fields = {},
  const Bs extends ReadonlyArray<AnyBlob> = [],
  const Ps extends ReadonlyArray<Policy<Cs[number]>> = [],
  const Desc extends string | undefined = undefined
>(
  name: Name,
  def: {
    readonly description?: Desc
    /** required (decision 94): branded ids are the default, `Schema.String` is a choice you write down */
    readonly id: Id
    readonly commands: Cs
    /** reachable from `ctx.self`, `ctx.actors`, workflows and executors; absent from handles, HTTP and tools (decision 95) */
    readonly internal?: Is
    readonly queries?: Qs
    readonly streams?: Ss
    readonly connections?: Cn
    readonly events?: ReadonlyArray<Ev>
    readonly effects?: ReadonlyArray<Ef>
    readonly tables?: ReadonlyArray<AnyTable>
    /**
     * keyed state in `actor_state`, loaded after the fence (decision 125). A missing row decodes `{}`, so every
     * key needs `Schema.withDecodingDefault(...)` or `Schema.optionalKey(...)`: a bare `Schema.Number` key makes
     * the first turn die with a defect naming the key.
     */
    readonly state?: S
    readonly blobs?: Bs
    readonly lifecycle?: Ps
    /** passed through to `Entity.toLayer`; the framework already sets actor/id/tenant/command/commandId (decision 112) */
    readonly spanAttributes?: Record<string, string>
  }
): ActorDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, Ev, Ef, S, Bs, Ps, Desc> => {
  const commands = def.commands
  const queries = (def.queries ?? []) as unknown as Qs
  const streams = (def.streams ?? []) as unknown as Ss
  const connections = (def.connections ?? []) as unknown as Cn
  const lifecycle = (def.lifecycle ?? []) as unknown as Ps
  assertUniqueTags(name, [...commands, ...queries, ...streams, ...connections])
  const policy = <T extends Policy["_tag"]>(tag: T) =>
    (lifecycle as ReadonlyArray<Policy>).find((p): p is Extract<Policy, { _tag: T }> => p._tag === tag)
  const toRpc = (d: AnyCommand | AnyQuery | AnyStream) =>
    Rpc.make(d.tag, {
      payload: d.input ?? Schema.Void,
      success: d.output,
      error: d.errors.length === 0 ? Schema.Never : Schema.Union(d.errors),
      stream: d._kind === "stream"
    })
  // commands and queries are persisted (receipts, redelivery); streams and connections are live only
  const group = (ds: ReadonlyArray<AnyCommand | AnyQuery | AnyStream>, persisted: boolean) =>
    RpcGroup.make(...ds.map(toRpc)).annotateRpcs(ClusterSchema.Persisted, persisted) as any

  const rpcs = group([...commands, ...queries], true).merge(group(streams, false)) as any
  const entity = Entity.fromRpcGroup(name, group(commands, true).merge(group(streams, false))) as any

  const self: ActorDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, Ev, Ef, S, Bs, Ps, Desc> = {
    _kind: "actor",
    name,
    description: def.description as Desc,
    id: def.id,
    commands,
    internal: (def.internal ?? []) as unknown as Is,
    queries,
    streams,
    connections,
    events: def.events ?? [],
    effects: def.effects ?? [],
    tables: def.tables ?? [],
    state: (def.state ?? {}) as S,
    blobs: (def.blobs ?? []) as unknown as Bs,
    lifecycle,
    get: ((id: Id["Type"], options?: GetOptions) =>
      Effect.gen(function*() {
        const actors = yield* Actors
        const caller = options?.as !== undefined ? toCaller(options.as) : yield* CurrentCaller
        return actors.get(self, id, { tenant: options?.tenant, as: caller })
      })) as any,
    client: (options) => makePromiseClient(self, options),
    toLayer: ((build: unknown, options?: ServeOptions<Id, Cs, Ef, Ev, S, Bs, Cn, any>) =>
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
            defectRetryPolicy: policy("DefectRetry")?.schedule,
            spanAttributes: def.spanAttributes
          }
        )
        .pipe(Layer.provide(Layer.effect(Sharding.Sharding, Effect.map(ActorRuntime, (a) => a.sharding))))) as any,
    toQueryLayer: ((build: unknown) =>
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

// ---------------------------------------------------------------------------------------------------
// Kinds: Actor.ephemeral (decision 133)
// ---------------------------------------------------------------------------------------------------

export type EphemeralHandlersFor<
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>,
  M extends Schema.Struct.Fields,
  R
> =
  & { readonly [C in Cs[number] as C["tag"]]: (ctx: MemoryContext<Id, Cs, M, Cn>, ...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C>, R> }
  & { readonly [Q in Qs[number] as Q["tag"]]: (ctx: MemoryReadContext<Id, M, Cn>, ...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>, R> }
  & { readonly [St in Ss[number] as St["tag"]]: (ctx: MemoryReadContext<Id, M, Cn>, ...args: Args<St>) => Stream.Stream<OutOf<St>, ErrOf<St>, R> }
  & { readonly [N in Cn[number] as N["tag"]]: (ctx: MemoryConnectionContext<Id, Cs, M, Cn, N>, ...args: [...ParamsArgs<N>, inbound: Stream.Stream<ClientOf<N>>]) => Stream.Stream<ServerOf<N>, ErrOf<N>, R> }

export interface EphemeralServeOptions<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, M extends Schema.Struct.Fields, Cn extends ReadonlyArray<AnyConnection>, RX> {
  readonly hooks?: ReadonlyArray<Hook<RX>>
  readonly run?: (ctx: MemoryContext<Id, Cs, M, Cn>) => Effect.Effect<void, never, RX>
}

/**
 * The same members and handle shape as `Actor.make`, none of the durability: no transaction, receipts,
 * tables, state, events or effects. `memory` is the only state and `Hibernate.after` drops it. The
 * Rivet / Durable Object model, opt-in per actor.
 * @category kinds
 */
export interface EphemeralDefinition<
  Name extends string,
  Id extends Schema.Top,
  Cs extends ReadonlyArray<AnyCommand>,
  Is extends ReadonlyArray<AnyCommand>,
  Qs extends ReadonlyArray<AnyQuery>,
  Ss extends ReadonlyArray<AnyStream>,
  Cn extends ReadonlyArray<AnyConnection>,
  M extends Schema.Struct.Fields,
  Ps extends ReadonlyArray<EphemeralPolicy<any>>,
  Desc extends string | undefined
> {
  readonly _kind: "ephemeral"
  readonly name: Name
  readonly description: Desc
  readonly id: Id
  readonly commands: Cs
  readonly internal: Is
  readonly queries: Qs
  readonly streams: Ss
  readonly connections: Cn
  readonly memory: M
  readonly lifecycle: Ps
  readonly get: {
    (id: Id["Type"], options: GetOptions & { readonly as: Principal | Caller }): Effect.Effect<EphemeralHandle<Id, Cs, Is, Qs, Ss, Cn>, never, Actors>
    (id: Id["Type"], options?: GetOptions): Effect.Effect<EphemeralHandle<Id, Cs, Is, Qs, Ss, Cn>, never, Actors | CurrentCaller>
  }
  readonly client: (options: ClientOptions) => PromiseClient<Id, Cs, Is, Qs, Ss, Cn, never>
  readonly toLayer: {
    <R, RX = never>(handlers: EphemeralHandlersFor<Id, Cs, Qs, Ss, Cn, M, R> & InsideTurn<R>, options?: EphemeralServeOptions<Id, Cs, M, Cn, RX>): Layer.Layer<never, never, Exclude<R | RX, Turn | Query> | Actors>
    <R, RX, RB>(build: Effect.Effect<EphemeralServe<Id, Cs, Qs, Ss, Cn, M, R, RX>, never, RB>): Layer.Layer<never, never, Exclude<R | RB | RX, Scope.Scope | Turn | Query> | Actors>
  }
  readonly of: <R, RX = never>(handlers: EphemeralHandlersFor<Id, Cs, Qs, Ss, Cn, M, R> & InsideTurn<R>, options?: EphemeralServeOptions<Id, Cs, M, Cn, RX>) => EphemeralServe<Id, Cs, Qs, Ss, Cn, M, R, RX>
  readonly onWake: <R>(run: (ctx: MemoryContext<Id, Cs, M, Cn>) => Effect.Effect<void, never, R>) => Hook<R>
  readonly onSleep: <R>(run: (ctx: MemoryContext<Id, Cs, M, Cn>) => Effect.Effect<void, never, R>) => Hook<R>
  readonly rpcs: RpcGroup.RpcGroup<RpcsOf<[...Cs, ...Qs, ...Ss]>>
  readonly entity: Entity.Entity<Name, RpcsOf<[...Cs, ...Qs, ...Ss]>>
}
export interface EphemeralServe<Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, M extends Schema.Struct.Fields, R, RX> {
  readonly [ServeTypeId]: ServeTypeId
  readonly handlers: EphemeralHandlersFor<Id, Cs, Qs, Ss, Cn, M, R>
  readonly hooks?: ReadonlyArray<Hook<RX>>
  readonly run?: (ctx: MemoryContext<Id, Cs, M, Cn>) => Effect.Effect<void, never, RX>
}

/** @category kinds */
export const ephemeral = <
  const Name extends string,
  Id extends Schema.Top,
  const Cs extends ReadonlyArray<AnyCommand>,
  const Is extends ReadonlyArray<Cs[number]> = [],
  const Qs extends ReadonlyArray<AnyQuery> = [],
  const Ss extends ReadonlyArray<AnyStream> = [],
  const Cn extends ReadonlyArray<AnyConnection> = [],
  const M extends Schema.Struct.Fields = {},
  const Ps extends ReadonlyArray<EphemeralPolicy<Cs[number]>> = [],
  const Desc extends string | undefined = undefined
>(
  name: Name,
  def: {
    readonly description?: Desc
    readonly id: Id
    readonly commands: Cs
    readonly internal?: Is
    readonly queries?: Qs
    readonly streams?: Ss
    readonly connections?: Cn
    /** typed in-memory state; initial value from the schema defaults */
    readonly memory?: M
    /** `Events.keep`, `Receipts.keep`, `Effects.retry`, `Lifecycle.createdBy`, `State.maxBytes` are rejected here */
    readonly lifecycle?: Ps
  }
): EphemeralDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, M, Ps, Desc> => makeEphemeral(name, def) as any

// ---------------------------------------------------------------------------------------------------
// Kinds: Actor.workflow (decisions 24, 119)
// ---------------------------------------------------------------------------------------------------

export const ExecutionId = Schema.String.pipe(Schema.brand("ExecutionId"))
export type ExecutionId = typeof ExecutionId.Type

export class WorkflowInterrupted extends Schema.TaggedError<WorkflowInterrupted>()("WorkflowInterrupted", {
  executionId: ExecutionId
}) {
  override get message(): string {
    return `workflow execution ${this.executionId} was interrupted`
  }
}

/** A running (or finished) execution: `WorkflowEngine.poll / interrupt / resume` behind a handle (decision 119). @category clients */
export interface WorkflowRun<Out, Err> {
  readonly id: ExecutionId
  /** waits for completion */
  readonly result: Effect.Effect<Out, Err | WorkflowInterrupted>
  readonly poll: Effect.Effect<Option.Option<Exit.Exit<Out, Err>>>
  readonly interrupt: Effect.Effect<void>
}

export interface WorkflowActors {
  readonly get: <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, Ev extends AnyTagged, Ef extends AnyTagged, S extends Schema.Struct.Fields, Bs extends ReadonlyArray<AnyBlob>, Ps extends ReadonlyArray<Policy<any>>, Desc extends string | undefined>(
    actor: ActorDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, Ev, Ef, S, Bs, Ps, Desc>,
    id: Id["Type"],
    options?: { readonly tenant?: TenantId }
  ) => WorkflowHandle<Id, Cs, Qs, Ss, Ev, Ps>
}

export interface WorkflowContext {
  readonly executionId: ExecutionId
  /** `System("workflow", { onBehalfOf })`: who started it */
  readonly principal: Option.Option<Principal>
  /**
   * Activity.make: the result is persisted, so output/errors need schemas. The framework pipes
   * `Actor.commandId(`${executionId}:${name}`)` around `run`, so command calls inside an activity
   * are idempotent across retries. `retry` is `Activity.retry`; declared errors are not retried.
   */
  readonly activity: <Out extends Schema.Top, const Errors extends ReadonlyArray<AnyError> = [], R = never>(
    name: string,
    options: {
      readonly output: Out
      readonly errors?: Errors
      readonly run: Effect.Effect<Out["Type"], Errors[number]["Type"], R>
      readonly retry?: Schedule.Schedule<any, unknown>
    }
  ) => Effect.Effect<Out["Type"], Errors[number]["Type"], R>
  /** DurableClock.sleep */
  readonly sleep: (duration: Duration.Input) => Effect.Effect<void>
  /** full handles: request/reply is fine inside a workflow (there is no turn to hold open) */
  readonly actors: WorkflowActors
  /**
   * DurableDeferred + a framework intent that resolves it when the actor emits `event`; `None` on
   * timeout. `event` is constrained to `EventsOf<typeof actor>`.
   */
  readonly waitFor: <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, Ev extends AnyTagged, Ef extends AnyTagged, S extends Schema.Struct.Fields, Bs extends ReadonlyArray<AnyBlob>, Ps extends ReadonlyArray<Policy<any>>, Desc extends string | undefined, E extends Ev>(
    actor: ActorDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, Ev, Ef, S, Bs, Ps, Desc>,
    id: Id["Type"],
    event: E,
    options?: { readonly timeout?: Duration.Input }
  ) => Effect.Effect<Option.Option<E["Type"]>>
}
/** @category kinds */
export interface WorkflowDefinition<Name extends string, In extends Schema.Struct.Fields, Out extends Schema.Top, Errors extends ReadonlyArray<AnyError>, Desc extends string | undefined> {
  readonly _kind: "workflow"
  readonly name: Name
  readonly description: Desc
  readonly input: Schema.Struct<In>
  readonly output: Out
  readonly errors: Errors
  /** run to completion (durable; resumes after crashes) */
  readonly execute: {
    (input: Schema.Struct.Type<In>, options: { readonly as: Principal | Caller }): Effect.Effect<Out["Type"], Errors[number]["Type"], Actors>
    (input: Schema.Struct.Type<In>): Effect.Effect<Out["Type"], Errors[number]["Type"], Actors | CurrentCaller>
  }
  /** start and return a run handle; a second `start` with the same idempotency key returns the same run */
  readonly start: {
    (input: Schema.Struct.Type<In>, options: { readonly as: Principal | Caller }): Effect.Effect<WorkflowRun<Out["Type"], Errors[number]["Type"]>, never, Actors>
    (input: Schema.Struct.Type<In>): Effect.Effect<WorkflowRun<Out["Type"], Errors[number]["Type"]>, never, Actors | CurrentCaller>
  }
  /** rehydrate a run handle from its id */
  readonly run: (id: ExecutionId) => Effect.Effect<WorkflowRun<Out["Type"], Errors[number]["Type"]>, never, Actors>
  readonly toLayer: <R>(
    run: (ctx: WorkflowContext, input: Schema.Struct.Type<In>) => Effect.Effect<Out["Type"], Errors[number]["Type"], R>
  ) => Layer.Layer<never, never, Exclude<R, Scope.Scope> | Actors>
  readonly workflow: EffectWorkflow.Workflow<Name, Schema.Struct<In>, Out, ErrorSchemaOf<Errors>>
}
export type AnyWorkflow = WorkflowDefinition<string, any, any, any, any>
export type WorkflowInput<W> = W extends WorkflowDefinition<any, infer In, any, any, any> ? Schema.Struct.Type<In> : never

/** @category kinds */
export const workflow = <
  const Name extends string,
  const In extends Schema.Struct.Fields,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<AnyError> = [],
  const Desc extends string | undefined = undefined
>(
  name: Name,
  def: {
    readonly description?: Desc
    readonly input: In
    readonly output?: Out
    readonly errors?: Errors
    readonly idempotencyKey: (input: Schema.Struct.Type<In>) => string
  }
): WorkflowDefinition<Name, In, Out, Errors, Desc> => {
  const output = (def.output ?? Schema.Void) as Out
  const errors = (def.errors ?? []) as Errors
  // The persisted payload is the app input plus an envelope (decision 144): the tenant and the caller the run acts
  // for. Effect derives the execution id from (name, key) only, so the key is namespaced by deployment and tenant;
  // a resumed run rebuilds its context from this envelope, never from the runner's ambient defaults.
  const wf = EffectWorkflow.make(name, {
    payload: { ...def.input, __tenant: TenantId, __deployment: DeploymentId, __onBehalfOf: Schema.Option(Schema.Unknown) },
    idempotencyKey: (p: any) => JSON.stringify([p.__deployment, p.__tenant, def.idempotencyKey(p)]),
    success: output,
    error: errors.length === 0 ? Schema.Never : Schema.Union(errors)
  }) as any
  return {
    _kind: "workflow",
    name,
    description: def.description as Desc,
    input: Schema.Struct(def.input),
    output,
    errors,
    execute: ((input: Schema.Struct.Type<In>, options?: { readonly as: Principal | Caller }) =>
      withCaller(options, Effect.flatMap(ActorRuntime, (rt) => Effect.provideService(wf.execute(input), WorkflowEngine.WorkflowEngine, rt.engine)))) as any,
    start: ((input: Schema.Struct.Type<In>, options?: { readonly as: Principal | Caller }) =>
      withCaller(options, Effect.flatMap(ActorRuntime, (rt) => startWorkflow(wf, rt, input)))) as any,
    run: ((id: ExecutionId) => Effect.map(ActorRuntime, (rt) => workflowRun(wf, rt, id))) as any,
    toLayer: ((run: (ctx: WorkflowContext, input: any) => Effect.Effect<any, any, any>) =>
      wf.toLayer((payload: any, executionId: string) => Effect.flatMap(ActorRuntime, (rt) => run(makeWorkflowContext(ExecutionId.make(executionId), rt), payload)))
        .pipe(Layer.provide(Layer.effect(WorkflowEngine.WorkflowEngine, Effect.map(ActorRuntime, (a) => a.engine))))) as any,
    workflow: wf
  }
}

// ---------------------------------------------------------------------------------------------------
// Kinds: Actor.cron, Actor.singleton (decisions 22, 132)
// ---------------------------------------------------------------------------------------------------

/** A cluster-wide cron job (one run per schedule, not one per actor). The framework's caller is `System("cron")`. @category kinds */
export interface CronDefinition<Name extends string, Desc extends string | undefined> {
  readonly _kind: "cron"
  readonly name: Name
  readonly description: Desc
  readonly cron: EffectCron.Cron
  readonly toLayer: <R>(run: Effect.Effect<void, never, R>) => Layer.Layer<never, never, Exclude<R, Scope.Scope | CurrentCaller> | Actors>
}
/** `ClusterCron.make({ name, cron, execute, shardGroup })`: the schedule is owned by the cluster, not by each runner. @category kinds */
export const cron = <const Name extends string, const Desc extends string | undefined = undefined>(
  name: Name,
  options: { readonly description?: Desc; readonly cron: string; readonly shardGroup?: string }
): CronDefinition<Name, Desc> => {
  const parsed = EffectCron.parse(options.cron) as unknown as EffectCron.Cron
  return {
    _kind: "cron",
    name,
    description: options.description as Desc,
    cron: parsed,
    toLayer: ((run: Effect.Effect<void, never, any>) => clusterCronLayer(name, parsed, run, options.shardGroup)) as any
  }
}

/** One long-lived `run` that exists exactly once cluster-wide: a leader, poller or reaper (decision 132). @category kinds */
export interface SingletonDefinition<Name extends string, Desc extends string | undefined> {
  readonly _kind: "singleton"
  readonly name: Name
  readonly description: Desc
  readonly shardGroup: string
  readonly toLayer: <R>(run: Effect.Effect<void, never, R>) => Layer.Layer<never, never, Exclude<R, Scope.Scope | CurrentCaller> | Actors>
}
/** `Singleton.make(name, run, { shardGroup })`. The caller inside is `System("singleton")`. @category kinds */
export const singleton = <const Name extends string, const Desc extends string | undefined = undefined>(
  name: Name,
  options?: { readonly description?: Desc; readonly shardGroup?: string }
): SingletonDefinition<Name, Desc> => ({
  _kind: "singleton",
  name,
  description: options?.description as Desc,
  shardGroup: options?.shardGroup ?? "default",
  toLayer: ((run: Effect.Effect<void, never, any>) => singletonLayer(name, run, options?.shardGroup ?? "default")) as any
})

// ---------------------------------------------------------------------------------------------------
// Runtime: Actors, ActorRuntime, layer, topology, auth, serve, toolkit, mcp (decisions 90, 92, 111, 115, 116, 118, 128, 129)
// ---------------------------------------------------------------------------------------------------

export interface DeadLetter {
  readonly id: string
  readonly ref: ActorRef
  readonly effect: { readonly _tag: string }
  readonly attempts: number
  readonly cause: Cause.Cause<unknown>
  readonly commandId: string
  readonly at: DateTime.Utc
}

/** The public runtime (decision 111): `actors.get(Counter, id)` is the non-sugared form of `Counter.get(id)`. @category runtime */
export class Actors extends Context.Service<Actors, {
  readonly get: {
    <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, Ev extends AnyTagged, Ef extends AnyTagged, S extends Schema.Struct.Fields, Bs extends ReadonlyArray<AnyBlob>, Ps extends ReadonlyArray<Policy<any>>, Desc extends string | undefined>(
      actor: ActorDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, Ev, Ef, S, Bs, Ps, Desc>,
      id: Id["Type"],
      options: { readonly tenant?: TenantId; readonly as: Caller }
    ): Handle<Id, Cs, Is, Qs, Ss, Cn, Ev, Ps>
    <Name extends string, Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, M extends Schema.Struct.Fields, Ps extends ReadonlyArray<EphemeralPolicy<any>>, Desc extends string | undefined>(
      actor: EphemeralDefinition<Name, Id, Cs, Is, Qs, Ss, Cn, M, Ps, Desc>,
      id: Id["Type"],
      options: { readonly tenant?: TenantId; readonly as: Caller }
    ): EphemeralHandle<Id, Cs, Is, Qs, Ss, Cn>
  }
  readonly deadLetters: {
    readonly list: (options?: { readonly ref?: ActorRef; readonly limit?: number }) => Effect.Effect<ReadonlyArray<DeadLetter>>
    /** puts the effect back in the outbox with `attempt = 0` */
    readonly retry: (id: string) => Effect.Effect<void>
    readonly discard: (id: string) => Effect.Effect<void>
  }
}>()("durable-actors/Actors") {}

/** Cluster internals for `Actor.serve`, workflows and the test harness. Not on the public entry. */
export class ActorRuntime extends Context.Service<ActorRuntime, {
  readonly sharding: Sharding.Sharding["Service"]
  readonly database: Database["Service"]
  readonly engine: WorkflowEngine.WorkflowEngine["Service"]
}>()("durable-actors/ActorRuntime") {}

/** Where the runners live. One tagged value instead of a bag of optional host/port settings. @category runtime */
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
  k8s: (): Topology => ({ _tag: "K8s" }),
  /** `ACTORS_TOPOLOGY=single|http|k8s`, `ACTORS_LISTEN_HOST/PORT`, `ACTORS_ADVERTISE_HOST/PORT` (decision 118) */
  fromConfig: (options?: { readonly prefix?: string }): Config.Config<Topology> => topologyConfig(options?.prefix ?? "ACTORS")
}

/**
 * Runtime layer: one per process. It builds the runner from `topology` and provides `Sharding` and
 * `WorkflowEngine` internally, so actor layers only ever require `Actors`.
 * @category runtime
 */
export declare const layer: (options: {
  /**
   * Stable identity of this deployment (decision 147). Namespaces workflow execution keys and singleton/cron names
   * so two deployments sharing a database never collide; never a code version. Default `"default"`.
   */
  readonly deployment?: DeploymentId
  readonly principal: Schema.Top & { readonly Type: Principal }
  /** derive the tenant from the principal once (decision 90); `get(id, { tenant })` still overrides */
  readonly tenant?: (principal: Principal) => TenantId
  readonly topology: Topology | Config.Config<Topology>
  /** compute placement (decision 128): `ClusterSchema.ShardGroup` for every entity; runners opt in with `ACTORS_SHARD_GROUPS` */
  readonly shardGroup?: (tenant: TenantId) => string
  /** `entityMessagePollInterval`; default `"1 second"` (decision 129), plus sleep-then-poll for self-armed timers and `LISTEN actor_wake` on Postgres */
  readonly pollInterval?: Duration.Input
}) => Layer.Layer<Actors | ActorRuntime, ConfigError, Database>

/** Turns request headers into a caller; used by `Actor.serve` and by the Rpc middleware for `CurrentCaller`. @category runtime */
export interface Auth<R> {
  readonly handler: (headers: Headers) => Effect.Effect<Caller, Unauthorized, R>
}
/** `auth` is required on `serve` (decision 92); anonymous is spelled out. @category runtime */
export const auth = {
  make: <R>(handler: (headers: Headers) => Effect.Effect<Principal, Unauthorized, R>): Auth<R> => ({ handler: (h) => Effect.map(handler(h), Caller.user) }),
  none: { handler: () => Effect.succeed(Caller.anonymous) } as Auth<never>,
  bearer: <R>(verify: (token: string) => Effect.Effect<Principal, Unauthorized, R>): Auth<R> => ({
    handler: (headers) => {
      const value = headers["authorization"]
      if (value === undefined || !value.startsWith("Bearer ")) return Effect.fail(new Unauthorized({ reason: "missing_credentials" }))
      return Effect.map(verify(value.slice("Bearer ".length)), Caller.user)
    }
  }),
  header: <R>(name: string, decode: (value: string) => Effect.Effect<Principal, Unauthorized, R>): Auth<R> => ({
    handler: (headers) => {
      const value = headers[name.toLowerCase()]
      return value === undefined ? Effect.fail(new Unauthorized({ reason: "missing_credentials" })) : Effect.map(decode(value), Caller.user)
    }
  })
}

/**
 * HTTP entrypoint: `/actors/{name}/{id}/{Command}` for every public command, query, stream (SSE) and
 * connection (WebSocket) of the given actors, `/actors/{name}/{id}/events` as SSE, `/workflows/{name}`
 * for `start`/`run`, and — on by default (decision 116) — `/llms.txt`, `/openapi.json`, `/actors/{name}.md`.
 * Echoes the commandId as `x-request-id` (decision 107).
 * @category runtime
 */
export declare const serve: <R = never>(options: {
  readonly actors: ReadonlyArray<AnyActor>
  readonly workflows?: ReadonlyArray<AnyWorkflow>
  readonly auth: Auth<R>
  readonly docs?: boolean
  readonly path?: string
}) => Layer.Layer<never, never, Actors | Exclude<R, Scope.Scope>>

type PublicCommandsOf<A> = A extends { readonly commands: infer Cs extends ReadonlyArray<AnyCommand>; readonly internal: infer Is extends ReadonlyArray<AnyCommand> } ? Exclude<Cs[number], Is[number]> : never
type QueriesOf<A> = A extends { readonly queries: infer Qs extends ReadonlyArray<AnyQuery> } ? Qs[number] : never
type Undescribed<A> = A extends { readonly name: infer N extends string; readonly description: infer D }
  ? (
    | (D extends string ? never : `Actor.toolkit: ${N} has no description`)
    | { [C in PublicCommandsOf<A> | QueriesOf<A> as C["tag"]]: C["description"] extends string ? never : `Actor.toolkit: ${N}.${C["tag"]} has no description` }[(PublicCommandsOf<A> | QueriesOf<A>)["tag"]]
  )
  : never
/** Every actor and every public command/query must carry a description (decision 96): the element becomes the message otherwise. */
export type ToolkitReady<As extends ReadonlyArray<AnyActor>> = { readonly [K in keyof As]: [Undescribed<As[K]>] extends [never] ? As[K] : Undescribed<As[K]> }
export type ToolNames<A> = A extends { readonly name: infer N extends string } ? `${N}_${(PublicCommandsOf<A> | QueriesOf<A>)["tag"]}` : never

/**
 * An Effect `Toolkit` for the given actors: `Chat_SendMessage`, `Chat_Recent`, …; `failureMode: "return"`; internal
 * commands and streams excluded (decision 115). The caller is a per-call dependency, not a layer input (decision 145):
 * each tool is `Tool.make(name, { dependencies: [Actors, CurrentCaller] })`, so `Actors | CurrentCaller` surfaces where
 * the tool is *called* (the agent loop, which already has a request/turn caller), and `layer` builds with nothing.
 * @category runtime
 */
export interface ActorToolkit<As extends ReadonlyArray<AnyActor>> {
  readonly toolkit: Toolkit.Toolkit<{ readonly [N in ToolNames<As[number]>]: Tool.Any }>
  /** handlers: every tool call becomes `actor.get(id)` under the caller of the calling fiber + the command */
  readonly layer: Layer.Layer<never, never, Actors>
  readonly names: ReadonlyArray<ToolNames<As[number]>>
}
/** @category runtime */
export declare const toolkit: <const As extends ReadonlyArray<AnyActor>>(
  actors: As & ToolkitReady<As>,
  options?: { readonly maxOutputBytes?: number }
) => ActorToolkit<As>
/**
 * `McpServer.toolkit` over `Actor.toolkit`. The caller is established per invocation, never at layer level (decision
 * 145): over HTTP the same `Auth` as `Actor.serve` runs on the `/mcp` request and the adapter provides `CurrentCaller`
 * to the tool handler for that invocation (gated: `McpRequestContext` carries no headers, so the bridge is ours);
 * on stdio there is no request, so the process names who it acts as. Caller-supplied MCP metadata is never a principal.
 * @category runtime
 */
export declare const mcp: <const As extends ReadonlyArray<AnyActor>, R = never>(options: {
  readonly actors: As & ToolkitReady<As>
  readonly name: string
  readonly version: string
  readonly transport:
    | { readonly _tag: "http"; readonly path: string; readonly auth: Auth<R> }
    | { readonly _tag: "stdio"; readonly as: Principal | Caller }
}) => Layer.Layer<never, never, Actors | Exclude<R, Scope.Scope>>

// ---------------------------------------------------------------------------------------------------
// The one seam for tests (decisions 71, 88): not on the public entry
// ---------------------------------------------------------------------------------------------------

/** What a turn did, as `turn()` reports it to `TurnHooks` before and after COMMIT. */
export interface TurnReport {
  readonly ref: ActorRef
  readonly tenantId: TenantId
  readonly command: string
  readonly commandId: string
  readonly caller: Caller
  readonly generation: number
  /**
   * why this turn ran: an outside call, a durable intent, a due timer, a per-actor cron tick, a dead-lettered effect, or
   * redelivery — the same requestId seen again, either rewritten by the EntityManager after a defect restart (in memory,
   * same runner) or re-read from storage after the shard moved. Cluster does not label this; `turn()` tracks requestIds.
   */
  readonly trigger: "call" | "intent" | "timer" | "cron" | "effect-failed" | "redelivery"
  /** receipt hit: the handler did not run, the stored Exit was replayed */
  readonly replayed: boolean
  readonly exit: Exit.Exit<unknown, unknown>
  readonly emitted: ReadonlyArray<{ readonly _tag: string }>
  readonly performed: ReadonlyArray<{ readonly _tag: string }>
  readonly intents: ReadonlyArray<{ readonly to: ActorRef; readonly command: string; readonly input: unknown; readonly key?: string; readonly deliverAt?: DateTime.Utc }>
  readonly cancelledTimers: ReadonlyArray<string>
  readonly workflowsStarted: ReadonlyArray<{ readonly name: string; readonly input: unknown }>
  readonly stateWritten: ReadonlyArray<string>
  readonly terminated: boolean
}
export interface TurnHooksShape {
  readonly beforeHandler: (turn: Pick<TurnReport, "ref" | "tenantId" | "command" | "commandId" | "caller" | "generation" | "trigger">) => Effect.Effect<void>
  readonly beforeCommit: (turn: TurnReport) => Effect.Effect<void>
  readonly afterCommit: (turn: TurnReport) => Effect.Effect<void>
}
export const TurnHooks = Context.Reference<TurnHooksShape>("durable-actors/TurnHooks", {
  defaultValue: () => ({ beforeHandler: () => Effect.void, beforeCommit: () => Effect.void, afterCommit: () => Effect.void })
})

// ---------------------------------------------------------------------------------------------------
// Internals (declared)
// ---------------------------------------------------------------------------------------------------

/**
 * One transaction per command. Not implemented here; see README "Turn".
 * BEGIN → SELECT actor_generations … FOR UPDATE → receipt lookup → load actor_state → (OnCreate on first turn) → handler
 *       → actor_state (dirty keys) / actor_events / actor_outbox / cluster_messages / receipt → TurnHooks.beforeCommit → COMMIT
 *       → TurnHooks.afterCommit → flush connection broadcasts → NOTIFY actor_wake.
 * Wrapped in `Effect.withSpan("durable-actors/turn", { actor, id, tenant, command, commandId, caller, trigger, replayed })`
 * and `Effect.annotateLogs({ actor, id, commandId })` (decision 112).
 * Retryable conditions (stale generation, lock timeout, commit-unknown, CommandTimeout) are defects.
 */
declare const turn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  envelope: unknown,
  lifecycle: ReadonlyArray<Policy>,
  serve: { readonly hooks?: ReadonlyArray<Hook<any>>; readonly effects?: unknown; readonly run?: unknown } | undefined,
  body: (ctx: CommandContext<any, any, any, any, any, any, any>) => Effect.Effect<A, E, R>
) => Effect.Effect<A, E | CommandConflict, Exclude<R, Turn> | ActorRuntime>
declare const streamTurn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  body: (ctx: StreamContext<any, any, any, any, any>) => Stream.Stream<A, E, R>
) => Stream.Stream<A, E, Exclude<R, Query> | ActorRuntime>
declare const makeEphemeral: (name: string, def: unknown) => unknown
/** Query handlers are registered in-process by the query layer; `handle.Query()` runs them here, against Database. */
declare const registerQueries: (actor: AnyActor, handlers: Record<string, unknown>) => Effect.Effect<void, never, Database>
declare const clusterCronLayer: (name: string, cron: EffectCron.Cron, run: Effect.Effect<void, never, any>, shardGroup: string | undefined) => Layer.Layer<never, never, Actors>
declare const singletonLayer: (name: string, run: Effect.Effect<void, never, any>, shardGroup: string) => Layer.Layer<never, never, Actors>
declare const makePromiseClient: <Id extends Schema.Top, Cs extends ReadonlyArray<AnyCommand>, Is extends ReadonlyArray<AnyCommand>, Qs extends ReadonlyArray<AnyQuery>, Ss extends ReadonlyArray<AnyStream>, Cn extends ReadonlyArray<AnyConnection>, Ev extends AnyTagged>(
  actor: ActorDefinition<any, Id, Cs, Is, Qs, Ss, Cn, Ev, any, any, any, any, any>,
  options: ClientOptions
) => PromiseClient<Id, Cs, Is, Qs, Ss, Cn, Ev>
declare const makeWorkflowContext: (executionId: ExecutionId, runtime: ActorRuntime["Service"]) => WorkflowContext
declare const startWorkflow: (wf: unknown, runtime: ActorRuntime["Service"], input: unknown) => Effect.Effect<WorkflowRun<any, any>, never, CurrentCaller>
declare const workflowRun: (wf: unknown, runtime: ActorRuntime["Service"], id: ExecutionId) => WorkflowRun<any, any>
declare const topologyConfig: (prefix: string) => Config.Config<Topology>
declare const assertUniqueTags: (actor: string, members: ReadonlyArray<{ readonly tag: string }>) => void
const withCaller = <A, E, R>(options: { readonly as: Principal | Caller } | undefined, self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  options === undefined ? self : Effect.provideService(self, CurrentCaller, toCaller(options.as)) as Effect.Effect<A, E, R>

/**
 * The namespace an agent types `Actor.` into. Levels (decision 134): kinds `make | ephemeral | workflow |
 * cron | singleton`; members `command | query | stream | connection | table | blob`; runtime
 * `layer | serve | auth | toolkit | mcp`; ambient `as | anonymous | tenant | commandId`.
 */
export const Actor = {
  make, ephemeral, workflow, cron, singleton,
  command, query, stream, connection, table, blob,
  layer, serve, auth, toolkit, mcp,
  as, anonymous, tenant, commandId
}

/**
 * The second primitive by its own name (decision 135): a workflow is a durable execution, not an actor,
 * even though `ClusterWorkflowEngine` runs it on an Entity. `Actor.workflow` stays as the settled spelling;
 * new docs and the skill use `Workflow.make`. Same definition object, same `toLayer`, same `ctx.workflows.start`.
 * @category kinds
 */
export const Workflow = { make: workflow }

/**
 * Runtime facilities that are neither actors nor workflows (decision 135): cluster-wide schedules and
 * leaders, plus the ambient binders. `Actor.cron` / `Actor.singleton` remain aliases.
 * @category runtime
 */
export const Durable = { cron, singleton, as, anonymous, tenant, commandId }
