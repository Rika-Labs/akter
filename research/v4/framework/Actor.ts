/**
 * Durable Actors — proposed public surface (typecheck-only sketch, Effect 4.0.0-rc.116).
 * Embodies DECISIONS.md 1–170. One primitive, `Actor.make`; everything else is a member of an actor,
 * a policy on it, or runtime wiring. Everything compiles down to Effect primitives:
 *
 *   kind      Actor.make                                    →  RpcGroup.make + Entity.fromRpcGroup, Persisted: true, one transaction per command ("turn");
 *                                                              `singleton: true` adds Sharding.registerSingleton for the boot activation
 *   members   Actor.command / query / stream / connection   →  Rpc.make (stream: true for streams and connections)
 *             Actor.workflow                                →  Workflow.make({ name: "Owner/Member" }) + Activity.make + DurableClock + DurableDeferred
 *             Actor.table / blob                            →  drizzle pgTable with (tenant_id, actor_id); actor_blobs
 *             Actor.migration                               →  upcast of the stored state row on load, inside the turn transaction
 *   policies  Hibernate, Mailbox, Defects, Delivery, Effects, Commands, Receipts, Events, State, Cron, Lifecycle, Connections
 *   runtime   Actor.layer / serve / auth                    →  Sharding + WorkflowEngine; HttpRouter + RpcServer (serve is optional: decision 155)
 *   ambient   Actor.as / anonymous / tenant / commandId     →  Effect.provideService on CurrentCaller / Tenant / CommandId
 *   errors    ActorError { reason }                         →  the Effect 4 `HttpClientError` shape; `Effect.catchReasons("ActorError", …)`
 *
 * The wrapping adds the contracts the framework promises: a generation fence, receipts keyed by a
 * client-minted commandId, typed channels everywhere, intents/events/effects committed with the turn,
 * "retryable = defect", and a caller on every handle.
 *
 * Every context, handle and handler type is parameterised by a `Members` bag, so `CommandContext<typeof Chat>`
 * and `Handle<typeof Chat>` are the spellings an app uses (the definition object *is* the bag).
 *
 * `Drizzle`, `OwnedTable`, `Scoped` are placeholders for drizzle-orm/effect-postgres types so this file
 * typechecks from the repo root, where only `effect` is hoisted. Runtime internals are `declare`d.
 *
 * @since 0.1.0
 */
import { Cause, Config, Context, DateTime, Duration, Effect, Exit, Layer, Option, Redacted, Schedule, Schema, Scope, Stream } from "effect"
import type { ConfigError } from "effect/Config"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { ClusterSchema, Entity, EntityAddress, Sharding } from "effect/unstable/cluster"
import * as ClusterError from "effect/unstable/cluster/ClusterError"
import { Workflow as EffectWorkflow, WorkflowEngine } from "effect/unstable/workflow"
import type { Headers } from "effect/unstable/http/Headers"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

// ---------------------------------------------------------------------------------------------------
// Identity: tenant, ref, principal, caller (decisions 8, 35, 89–91, 154, 156)
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

/** Who the framework acts as when it starts work itself (decision 157: no `singleton` / `run` — those are the actor). @category identity */
export type SystemSource = "timer" | "cron" | "workflow" | "actor" | "effect"

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
    caller._tag === "User" ? Option.some(caller.principal) : caller._tag === "System" ? caller.onBehalfOf : Option.none(),
  /** the caller for a whole layer graph: a worker process, a test file, a CLI (decision 154) */
  layer: (who: Principal | Caller): Layer.Layer<never> => Layer.succeed(CurrentCaller, toCaller(who))
}

/**
 * The ambient caller (decision 154). A `Context.Reference`, so it always has a value: `Anonymous` unless the HTTP
 * middleware, `Actor.as`, `Caller.layer`, `get(id, { as })` or the framework (inside turns, workflows, executors:
 * `System`) set it. Handles therefore never require `CurrentCaller`; authorization is the actor's decision, made
 * against `ctx.caller`, never a missing service.
 * @category identity
 */
export const CurrentCaller = Context.Reference<Caller>("durable-actors/CurrentCaller", { defaultValue: () => Caller.anonymous })

/** Ambient values with defaults. Set for a call with `Actor.tenant` / `Actor.commandId`. @category runtime */
export const Tenant = Context.Reference<TenantId>("durable-actors/Tenant", { defaultValue: () => TenantId.make("default") })
/**
 * `undefined` means "the handle mints one when the call runs" (decision 113): a UUID is generated inside
 * `Effect.suspend`, so one run of the Effect keeps the same id across `Delivery.retry` and a re-run mints
 * a new one. `turn()` never generates ids; raw HTTP callers without `x-command-id` get one minted at the edge.
 */
export const CommandId = Context.Reference<string | undefined>("durable-actors/CommandId", { defaultValue: () => undefined })

/** Binds the tenant for the `get` / `Actors.get` inside `self`. A handle keeps the tenant it was resolved with. @category runtime */
export const tenant = (id: TenantId) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, Tenant, id)
/** Sets the ambient caller for `self`: a whole program, a request, one call. @category runtime */
export const as = (who: Principal | Caller) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CurrentCaller, toCaller(who))
/** @category runtime */
export const anonymous = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CurrentCaller, Caller.anonymous)
/** @category runtime */
export const commandId = (id: string) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.provideService(self, CommandId, id)

const isCaller = (who: Principal | Caller): who is Caller => typeof who === "object" && who !== null && "_tag" in who
const toCaller = (who: Principal | Caller): Caller => isCaller(who) ? who : Caller.user(who)

// ---------------------------------------------------------------------------------------------------
// Errors (decisions 26, 105, 106, 167): one `ActorError`, a `reason` per situation, every message says what to do next
// ---------------------------------------------------------------------------------------------------

/** Cluster could not deliver after `Delivery.retry`. `cause` keeps the original Cluster error. @category errors */
export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  ref: ActorRef,
  command: Schema.String,
  code: Schema.Literals(["not_assigned", "already_processing", "persistence"]),
  retryAfter: Schema.Option(Schema.Duration),
  cause: Schema.Union([ClusterError.AlreadyProcessingMessage, ClusterError.PersistenceError, ClusterError.EntityNotAssignedToRunner])
}, { httpApiStatus: 503 }) {
  readonly retryable = true
  override get message(): string {
    return `${this.ref}: ${this.command} was not delivered (${this.code}). Retry ${formatAfter(this.retryAfter)} with the same commandId.`
  }
}

/** The mailbox is at `Mailbox.capacity`: back-pressure, not loss. @category errors */
export class MailboxFull extends Schema.TaggedError<MailboxFull>()("MailboxFull", {
  ref: ActorRef,
  command: Schema.String,
  capacity: Schema.Number,
  retryAfter: Schema.Option(Schema.Duration)
}, { httpApiStatus: 503 }) {
  readonly retryable = true
  override get message(): string {
    return `${this.ref}: mailbox full (${this.capacity}). Retry ${formatAfter(this.retryAfter)} with the same commandId.`
  }
}

/**
 * The caller stopped waiting (`Delivery.timeout`); the turn may still commit. Retrying with the same commandId
 * replays the receipt instead of running the handler twice.
 * @category errors
 */
export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", {
  ref: ActorRef,
  command: Schema.String,
  commandId: Schema.String,
  after: Schema.Duration
}, { httpApiStatus: 504 }) {
  readonly retryable = true
  override get message(): string {
    return `${this.ref}: no reply to ${this.command} within ${Duration.format(this.after)}. Retry with commandId ${this.commandId} to get the receipt.`
  }
}

/** Same commandId, different payload: the receipt does not match. @category errors */
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

/** The request carried no usable credentials: `Actor.auth` rejected the headers. @category errors */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  code: Schema.Literals(["missing_credentials", "invalid_credentials", "expired"])
}, { httpApiStatus: 401 }) {
  readonly retryable = false
  override get message(): string {
    return `Unauthorized: ${this.code.replace("_", " ")}. Send a valid credential in the Authorization header.`
  }
}

/**
 * Boundary only (decision 106): the Promise client and HTTP when the body fails the input schema. Never on an
 * Effect handle: its inputs are typed.
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

const formatAfter = (after: Option.Option<Duration.Duration>) => Option.match(after, { onNone: () => "shortly", onSome: (d) => `after ${Duration.format(d)}` })

/** Every way the framework itself can fail a call. Declared (application) errors are never inside an `ActorError`. @category errors */
export type ActorErrorReason = ActorUnavailable | MailboxFull | Timeout | CommandConflict | NotCreated | Unauthorized | InvalidInput | TransportError

/**
 * The one framework error (decision 167), shaped like Effect 4's `HttpClientError`: `_tag: "ActorError"`, the situation
 * in `reason`. Handles type it as `ActorError.Of<…>` narrowed to the reasons that method can produce, so
 * `Effect.catchReasons("ActorError", { MailboxFull: …, CommandConflict: … })` is exhaustive per call site and a query
 * cannot be caught for a delivery failure it cannot have. `isRetryable` / `retryAfter` are what a retry policy needs;
 * the HTTP status comes from the reason's `httpApiStatus`.
 * @category errors
 */
export class ActorError extends Schema.TaggedError<ActorError>()("ActorError", {
  reason: Schema.Union([ActorUnavailable, MailboxFull, Timeout, CommandConflict, NotCreated, Unauthorized, InvalidInput, TransportError])
}) {
  static readonly of = <R extends ActorErrorReason>(reason: R): ActorError.Of<R> => new ActorError({ reason }) as ActorError.Of<R>
  get isRetryable(): boolean {
    return this.reason.retryable
  }
  get retryAfter(): Option.Option<Duration.Duration> {
    return "retryAfter" in this.reason ? this.reason.retryAfter : Option.none()
  }
  override get message(): string {
    return this.reason.message
  }
}
export declare namespace ActorError {
  /**
   * `ActorError` whose `reason` is known to be one of `R`; what every handle method is typed with. Collapses to
   * `never` when `R` is `never`, so a method that cannot fail the framework way (a workflow's owner call on an actor
   * without `Lifecycle.createdBy`) has exactly its declared errors in `E`.
   */
  export type Of<R extends ActorErrorReason> = [R] extends [never] ? never : ActorError & { readonly reason: R }
}

/**
 * Declared errors are yieldable tagged errors (decision 97): `errors: [Schema.String]` does not compile.
 * A declared error without `httpApiStatus` maps to 422 on HTTP.
 * @category errors
 */
export type AnyError = Schema.Top & { readonly Type: { readonly _tag: string } & Cause.YieldableError }

// ---------------------------------------------------------------------------------------------------
// Database, tables, rows (decisions 9, 10, 32, 64, 103, 104, 118, 156)
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

/**
 * Nominal service: `PgClient` structurally extends `SqlClient`, so we never key on either directly. One database per
 * deployment; tenants are rows (decision 156): every framework table carries `tenant_id`, Postgres enforces it with
 * row-level security (`set_config('actor.tenant_id', …, true)` inside the turn transaction), Neki shards on it.
 * @category runtime
 */
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
// Members: command, query, stream, connection, workflow, blob, migration (decisions 2, 19, 95–97, 117, 126, 131, 158, 162)
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
 * `client` frames go client → actor (live signals; durable changes are commands). `state` is per-connection
 * and survives hibernation at the edge (decision 163: ≤ 16 KiB, serialised with the parked socket).
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
/**
 * A durable execution owned by an actor (decision 158): started from the owner's handle, from `ctx.self` inside a
 * turn, or from another workflow. Compiles to `Workflow.make({ name: "Owner/Tag" })`; the execution key is
 * `[deployment, tenant, ownerId, key]`, so one live run per owner per `key`.
 * @category members
 */
export interface WorkflowDef<Tag extends string, In extends Schema.Struct.Fields, Out extends Schema.Top, Errors extends ReadonlyArray<AnyError>, Desc extends string | undefined = string | undefined> {
  readonly _kind: "workflow"
  readonly tag: Tag
  readonly input: Schema.Struct<In>
  readonly output: Out
  readonly errors: Errors
  readonly description: Desc
  readonly deprecated: boolean
}
/** A large per-actor binary outside the state cap (decision 131): rows in `actor_blobs(tenant_id, actor_id, key, seq, data)`. @category members */
export interface BlobDef<Key extends string> {
  readonly _kind: "blob"
  readonly key: Key
}
/**
 * One step of the state's history (decision 162). `actor_state` rows carry the version they were written with;
 * a turn that loads an older row runs the chain `from → to` up to the declared `state`, inside its transaction,
 * and writes the current version back with the turn. Old code never reads new rows: the runner manifest rejects it.
 * @category members
 */
export interface Migration<From extends Schema.Top, To extends Schema.Top> {
  readonly _kind: "migration"
  readonly from: From
  readonly to: To
  readonly upcast: (old: From["Type"]) => To["Type"]
}
export type AnyCommand = Command<string, any, any, any, any>
export type AnyQuery = QueryDef<string, any, any, any, any>
export type AnyStream = StreamDef<string, any, any, any, any>
export type AnyConnection = ConnectionDef<string, any, any, any, any, any, any>
export type AnyWorkflow = WorkflowDef<string, any, any, any, any>
export type AnyBlob = BlobDef<string>
export type AnyMigration = Migration<any, any>
/** Events and effects are `Schema.TaggedClass` values. */
export type AnyTagged = Schema.Top & { readonly Type: { readonly _tag: string } }

/** `input` may be a schema (positional arg), struct fields (object arg), or omitted (no arg). */
type NormalizeInput<In> = In extends Schema.Top ? In : In extends Schema.Struct.Fields ? Schema.Struct<In> : undefined
const normalizeInput = (input: unknown): Schema.Top | undefined =>
  input === undefined ? undefined : Schema.isSchema(input) ? input : Schema.Struct(input as Schema.Struct.Fields)

interface Definition<In, Out, Errors, Desc> {
  /** one or two sentences for humans and OpenAPI */
  readonly description?: Desc
  readonly input?: In
  readonly output?: Out
  readonly errors?: Errors
  /** `OpenApi.Deprecated` (decision 117) */
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

/** Input is struct fields: the persisted payload is the input plus the framework's envelope (decision 144). @category members */
export const workflow = <
  const Tag extends string,
  const In extends Schema.Struct.Fields,
  Out extends Schema.Top = typeof Schema.Void,
  const Errors extends ReadonlyArray<AnyError> = [],
  const Desc extends string | undefined = undefined
>(tag: Tag, def: {
  readonly description?: Desc
  readonly input: In
  readonly output?: Out
  readonly errors?: Errors
  readonly deprecated?: boolean
}): WorkflowDef<Tag, In, Out, Errors, Desc> => ({
  _kind: "workflow",
  tag,
  input: Schema.Struct(def.input),
  output: def.output ?? Schema.Void,
  errors: def.errors ?? [],
  description: def.description,
  deprecated: def.deprecated ?? false
}) as any

/** @category members */
export const blob = <const Key extends string>(key: Key): BlobDef<Key> => ({ _kind: "blob", key })

/** `Actor.migration(StateV1, StateV2, (old) => ({ ...old, tags: [] }))`; the last `to` in `migrations` must be the declared `state`. @category members */
export const migration = <From extends Schema.Top, To extends Schema.Top>(from: From, to: To, upcast: (old: From["Type"]) => To["Type"]): Migration<From, To> =>
  ({ _kind: "migration", from, to, upcast })

// ---------------------------------------------------------------------------------------------------
// Policies (decisions 21–23, 27, 52, 98, 101, 125, 163, 170): contract-side, serializable, `Policy<C>` names this actor's commands
// ---------------------------------------------------------------------------------------------------

export interface HibernatePolicy { readonly _tag: "Hibernate"; readonly after: Duration.Input } // Entity.toLayer maxIdleTime
export interface MailboxPolicy { readonly _tag: "MailboxCapacity"; readonly size: number | "unbounded" } // Entity.toLayer mailboxCapacity
export interface DefectsPolicy { readonly _tag: "DefectRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // Entity.toLayer defectRetryPolicy
export interface DeliveryPolicy { readonly _tag: "DeliveryRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // client-side retry before ActorUnavailable
export interface DeliveryTimeoutPolicy { readonly _tag: "DeliveryTimeout"; readonly after: Duration.Input } // caller stops waiting → ActorError(Timeout)
export interface EffectsPolicy { readonly _tag: "EffectsRetry"; readonly schedule: Schedule.Schedule<any, unknown> } // outbox executor retry before dead-letter
export interface CommandTimeoutPolicy { readonly _tag: "CommandTimeout"; readonly after: Duration.Input } // turn(): handler timeout → defect → redelivery
export interface LockWaitPolicy { readonly _tag: "LockWait"; readonly after: Duration.Input } // turn(): SET LOCAL lock_timeout on the generation fence
export interface ReceiptsPolicy { readonly _tag: "ReceiptsRetention"; readonly keep: Duration.Input } // actor_receipts purge (never before cluster_messages)
export interface EventsPolicy { readonly _tag: "EventsRetention"; readonly keep: Duration.Input | "forever" } // actor_events purge
export interface StatePolicy { readonly _tag: "StateMaxBytes"; readonly bytes: number | `${number} KiB` | `${number} MiB` } // exceeding is a defect: "move `x` to a table"
/**
 * Per-actor timer re-armed after each run; a singleton's cron is the cluster-wide schedule (decision 170). Only zero-input
 * commands: cron cannot supply a payload. `skipIfOlderThan` drops ticks the actor slept through instead of replaying them.
 */
export interface CronPolicy<C extends AnyCommand> { readonly _tag: "Cron"; readonly expression: string; readonly command: C; readonly skipIfOlderThan: Option.Option<Duration.Input> }
/** Explicit creation: every other command fails with `NotCreated` until this one has run. */
export interface CreatedBy<C extends AnyCommand> { readonly _tag: "CreatedBy"; readonly command: C }
/**
 * What open connections do to hibernation (decision 163, Durable Object semantics). `park` (default): the activation
 * sleeps on `Hibernate.after` with sockets open; the edge keeps `conn.state` (≤ 16 KiB) and the next inbound frame,
 * broadcast or `NOTIFY actor_wake` re-runs the handler with `ctx.conn.resumed = true`. `keepAwake`: an open connection
 * counts as activity.
 */
export interface ConnectionsPolicy { readonly _tag: "Connections"; readonly mode: "park" | "keepAwake" }

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
  | DeliveryTimeoutPolicy
  | EffectsPolicy
  | CommandTimeoutPolicy
  | LockWaitPolicy
  | ReceiptsPolicy
  | EventsPolicy
  | StatePolicy
  | CronPolicy<C>
  | CreatedBy<C>
  | ConnectionsPolicy

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
  retry: (schedule: Schedule.Schedule<any, unknown>): DeliveryPolicy => ({ _tag: "DeliveryRetry", schedule }),
  /** how long a caller waits for a reply before `ActorError(Timeout)`; default `"30 seconds"` */
  timeout: (after: Duration.Input): DeliveryTimeoutPolicy => ({ _tag: "DeliveryTimeout", after })
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
  every: <C extends Command<string, undefined, any, any, any>>(expression: string, command: C, options?: { readonly skipIfOlderThan?: Duration.Input }): CronPolicy<C> =>
    ({ _tag: "Cron", expression, command, skipIfOlderThan: Option.fromNullishOr(options?.skipIfOlderThan) })
}
/** @category policies */
export const Lifecycle = {
  /** Opt-in to explicit creation. The creating command itself never fails with `NotCreated`. */
  createdBy: <C extends AnyCommand>(command: C): CreatedBy<C> => ({ _tag: "CreatedBy", command })
}
/** @category policies */
export const Connections = {
  park: { _tag: "Connections", mode: "park" } as ConnectionsPolicy,
  keepAwake: { _tag: "Connections", mode: "keepAwake" } as ConnectionsPolicy
}
/** One place to find every policy when typing `Policy.` (decision 101); the individual exports stay. @category policies */
export const Policy = { Hibernate, Mailbox, Defects, Delivery, Effects, Commands, Receipts, Events, State, Cron, Lifecycle, Connections }

// ---------------------------------------------------------------------------------------------------
// The Members bag: one type parameter for every context, handle and handler type
// ---------------------------------------------------------------------------------------------------

/**
 * What `Actor.make` was given, as types. A definition object satisfies this structurally, so
 * `CommandContext<typeof Chat>`, `Handle<typeof Chat>`, `EventsOf<typeof Chat>` are the app-side spellings.
 * @category kinds
 */
export interface Members {
  readonly id: Schema.Top
  readonly commands: ReadonlyArray<AnyCommand>
  readonly internal: ReadonlyArray<AnyCommand>
  readonly queries: ReadonlyArray<AnyQuery>
  readonly streams: ReadonlyArray<AnyStream>
  readonly connections: ReadonlyArray<AnyConnection>
  readonly workflows: ReadonlyArray<AnyWorkflow>
  readonly events: ReadonlyArray<AnyTagged>
  readonly effects: ReadonlyArray<AnyTagged>
  readonly tables: ReadonlyArray<AnyTable>
  readonly state: Schema.Struct.Fields
  readonly vars: Schema.Struct.Fields
  readonly blobs: ReadonlyArray<AnyBlob>
  readonly migrations: ReadonlyArray<AnyMigration>
  readonly lifecycle: ReadonlyArray<Policy<any>>
}
/** How ids come to be (decision 164). @category kinds */
export type IdMode = "minted" | "named" | "singleton"
/** Structural minimum shared by everything that takes "an actor": identity and id mode. @category kinds */
export interface AnyActor extends Members {
  readonly _kind: "actor"
  readonly name: string
  readonly description: string | undefined
  readonly mode: IdMode
}

type Cmds<M extends Members> = M["commands"][number]
type Wfs<M extends Members> = M["workflows"][number]
type Evs<M extends Members> = M["events"][number]
type Efs<M extends Members> = M["effects"][number]
/** Outside handles, HTTP and the Promise client see only non-internal commands (decision 95). */
type Public<M extends Members> = Exclude<Cmds<M>, M["internal"][number]>
type Args<C> = C extends { readonly input: infer I } ? (I extends Schema.Top ? [input: I["Type"]] : []) : []
type ParamsArgs<N> = N extends { readonly params: infer P } ? (P extends Schema.Top ? [params: P["Type"]] : []) : []
type OutOf<C> = C extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never
type ErrOf<C> = C extends { readonly errors: infer Er extends ReadonlyArray<Schema.Top> } ? Er[number]["Type"] : never
type InputOf<W> = W extends { readonly input: infer I extends Schema.Top } ? I["Type"] : never
type ServerOf<N> = N extends { readonly server: infer S extends Schema.Top } ? S["Type"] : never
type ClientOf<N> = N extends { readonly client: infer S extends Schema.Top } ? S["Type"] : never
type ConnStateOf<N> = N extends { readonly state: infer S extends Schema.Struct.Fields } ? S : {}
type ErrorSchemaOf<Er extends ReadonlyArray<Schema.Top>> = Er extends readonly [] ? typeof Schema.Never : Schema.Union<Er>
/** `get(id)` for named and minted ids, `get()` for a singleton. */
export type IdArgs<A> = A extends { readonly mode: "singleton" } ? [] : A extends { readonly id: infer Id extends Schema.Top } ? [id: Id["Type"]] : never
export type IdOf<A> = A extends { readonly id: infer Id extends Schema.Top } ? Id["Type"] : never
export type EventsOf<A extends Members> = Evs<A>
export type StateOf<A extends Members> = StateValues<A["state"]>
export type VarsOf<A extends Members> = StateValues<A["vars"]>
export type HandleOf<A extends Members> = Handle<A>

/** `NotCreated` is a possible reason on every command except the one named by `Lifecycle.createdBy`. */
type CreatingTag<M extends Members> = Extract<M["lifecycle"][number], { readonly _tag: "CreatedBy" }>["command"]["tag"]
type CreationReason<M extends Members, C extends { readonly tag: string }> = [Extract<M["lifecycle"][number], { readonly _tag: "CreatedBy" }>] extends [never] ? never
  : C["tag"] extends CreatingTag<M> ? never
  : NotCreated
/** What a Cluster hop can do to a call; queries never take one (decision 4). */
type DeliveryReason = ActorUnavailable | MailboxFull | Timeout
type CommandFailure<M extends Members, C extends AnyCommand> = ActorError.Of<DeliveryReason | CommandConflict | CreationReason<M, C>>
type WorkflowStartFailure<M extends Members, W extends AnyWorkflow> = ActorError.Of<DeliveryReason | CreationReason<M, W>>

// ---------------------------------------------------------------------------------------------------
// State, vars, blobs (decisions 125, 131, 136, 160, 165)
// ---------------------------------------------------------------------------------------------------

/** Keyed state (decision 125): synchronous reads, `set` writes only the dirty keys at commit. */
export type StateValues<S extends Schema.Struct.Fields> = Schema.Struct.Type<S>
export type StateHandle<S extends Schema.Struct.Fields> = Readonly<StateValues<S>> & {
  readonly set: (patch: Partial<StateValues<S>>) => Effect.Effect<void>
}
/** The committed snapshot outside a turn, plus `changes`: one element per committed turn that wrote state (decision 165). */
export type StateSnapshot<S extends Schema.Struct.Fields> = Readonly<StateValues<S>> & {
  readonly changes: Stream.Stream<StateValues<S>>
}
/**
 * Per-activation, typed, in memory (decision 160): caches, cursors, clients. Initial values come from the schema
 * defaults; `Hibernate.after` drops them. Not agent memory: nothing here survives sleep. Non-serialisable things
 * (an SDK client, a socket) are closure variables in the Effect form of `toLayer`, not `vars`.
 */
export type VarsHandle<V extends Schema.Struct.Fields> = Readonly<StateValues<V>> & {
  readonly set: (patch: Partial<StateValues<V>>) => Effect.Effect<void>
  readonly update: (f: (current: StateValues<V>) => StateValues<V>) => Effect.Effect<void>
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
 * `Actors` called an outside handle; the fix is named in the key.
 */
export type InsideTurn<R> = [Extract<R, Actors>] extends [never] ? unknown
  : { readonly "Request/reply inside a turn is not allowed: use ctx.actors.get(Other, id).Command.send(...) or ctx.self.Command.send(...)": never }

/**
 * Runtime twin of `InsideTurn` (decision 146). The type check only sees requirements, and a handle bound before the
 * turn has `R = never`, so `turn()` also sets this reference around the handler and every outside operation
 * (`X.get`, handle methods, `Actors.get`) dies when it finds it `true`. Not a user customization point.
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
// Handles (decisions 7, 17, 19, 20, 89, 95, 99, 100, 114, 119, 126, 154, 158, 167)
// ---------------------------------------------------------------------------------------------------

/** @category clients */
export interface GetOptions {
  /** explicit tenant; otherwise `Actor.layer({ tenant })` derives it from the principal, else the ambient `Tenant` reference */
  readonly tenant?: TenantId
  /** bind the caller here instead of taking it from `CurrentCaller` */
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

export const ExecutionId = Schema.String.pipe(Schema.brand("ExecutionId"))
export type ExecutionId = typeof ExecutionId.Type
export class WorkflowInterrupted extends Schema.TaggedError<WorkflowInterrupted>()("WorkflowInterrupted", {
  executionId: ExecutionId
}) {
  override get message(): string {
    return `workflow execution ${this.executionId} was interrupted`
  }
}
/** A running (or finished) execution: `WorkflowEngine.poll / interrupt` behind a handle (decision 119). @category clients */
export interface WorkflowRun<Out, Err> {
  readonly id: ExecutionId
  /** the owner-scoped key the run was started under (`"default"` when none was given) */
  readonly key: string
  /** waits for completion */
  readonly result: Effect.Effect<Out, Err | WorkflowInterrupted>
  readonly poll: Effect.Effect<Option.Option<Exit.Exit<Out, Err>>>
  readonly interrupt: Effect.Effect<void>
}
/** `x.Review.start(input)` / `x.Review.run(key)` on an outside handle (decision 158). */
export interface WorkflowMethod<M extends Members, W extends AnyWorkflow> {
  /** starts a run keyed by `key` (default `"default"`); a live run under the same key is joined, not duplicated */
  readonly start: (input: InputOf<W>, options?: { readonly key?: string }) => Effect.Effect<WorkflowRun<OutOf<W>, ErrOf<W>>, WorkflowStartFailure<M, W>>
  /** rehydrates the run under `key`; `None` when none was ever started */
  readonly run: (key?: string) => Effect.Effect<Option.Option<WorkflowRun<OutOf<W>, ErrOf<W>>>>
}

/** Inside a turn, other actors (and self) are reachable only as durable intents. */
export interface IntentMethod<C> {
  readonly send: (...args: [...Args<C>, options?: IntentOptions]) => Effect.Effect<void>
  readonly after: (delay: Duration.Input, ...args: [...Args<C>, options?: IntentOptions]) => Effect.Effect<void>
  readonly at: (when: DateTime.Utc, ...args: [...Args<C>, options?: IntentOptions]) => Effect.Effect<void>
}
/** Workflow intents commit with the turn: the engine starts (or interrupts) the run after COMMIT. */
export interface WorkflowIntent<W> {
  readonly start: (input: InputOf<W>, options?: { readonly key?: string }) => Effect.Effect<void>
  readonly cancel: (key?: string) => Effect.Effect<void>
}
export type IntentHandle<M extends Members> =
  & { readonly [C in Cmds<M> as C["tag"]]: IntentMethod<C> }
  & { readonly [W in Wfs<M> as W["tag"]]: WorkflowIntent<W> }

/** The outside handle: caller bound at `get`, so every method has `R = never` (decision 89). @category clients */
export type Handle<M extends Members> =
  & { readonly id: IdOf<M>; readonly ref: ActorRef }
  & { readonly [C in Public<M> as C["tag"]]: (...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C> | CommandFailure<M, C>> }
  /** queries run on the caller's node against committed rows: no Cluster hop, so no ActorError */
  & { readonly [Q in M["queries"][number] as Q["tag"]]: (...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>> }
  /** streams run on the actor's node but are forked past the mailbox, and are live only (not persisted) */
  & { readonly [S in M["streams"][number] as S["tag"]]: (...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S> | ActorError.Of<DeliveryReason>> }
  /** connections are scoped: closing the scope closes the socket */
  & { readonly [N in M["connections"][number] as N["tag"]]: (...args: ParamsArgs<N>) => Effect.Effect<Connection<ServerOf<N>, ClientOf<N>>, ErrOf<N> | ActorError.Of<DeliveryReason>, Scope.Scope> }
  & { readonly [W in Wfs<M> as W["tag"]]: WorkflowMethod<M, W> }
  & { readonly events: EventsMethod<Evs<M>> }

/** Inside a workflow the caller is `System("workflow", { onBehalfOf })`, internal commands are reachable, and delivery failures are the engine's problem. */
export type WorkflowHandle<M extends Members> =
  & { readonly id: IdOf<M>; readonly ref: ActorRef }
  & { readonly [C in Cmds<M> as C["tag"]]: (...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C> | ActorError.Of<CreationReason<M, C>>> }
  & { readonly [Q in M["queries"][number] as Q["tag"]]: (...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>> }
  & { readonly [S in M["streams"][number] as S["tag"]]: (...args: Args<S>) => Stream.Stream<OutOf<S>, ErrOf<S>> }
  & { readonly [W in Wfs<M> as W["tag"]]: WorkflowMethod<M, W> }
  & { readonly events: EventsMethod<Evs<M>> }

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
/** Derived, Promise-based client for non-Effect callers (browsers, scripts). Throws `ActorError` (reasons include `InvalidInput | Unauthorized | TransportError`) and the declared errors. @category clients */
export type PromiseHandle<M extends Members> =
  & { readonly id: IdOf<M> }
  & { readonly [C in Public<M> as C["tag"]]: (...args: [...Args<C>, options?: CallOptions]) => Promise<OutOf<C>> }
  & { readonly [Q in M["queries"][number] as Q["tag"]]: (...args: [...Args<Q>, options?: StreamOptions]) => Promise<OutOf<Q>> }
  & { readonly [S in M["streams"][number] as S["tag"]]: (...args: [...Args<S>, options?: StreamOptions]) => AsyncIterable<OutOf<S>> }
  & { readonly [N in M["connections"][number] as N["tag"]]: (...args: [...ParamsArgs<N>, options?: StreamOptions]) => PromiseConnection<ServerOf<N>, ClientOf<N>> }
  & {
    readonly [W in Wfs<M> as W["tag"]]: {
      readonly start: (input: InputOf<W>, options?: { readonly key?: string } & StreamOptions) => Promise<{ readonly id: ExecutionId; readonly key: string }>
      readonly result: (key?: string, options?: StreamOptions) => Promise<OutOf<W>>
    }
  }
  & {
    readonly events: {
      (options?: EventsOptions & StreamOptions): AsyncIterable<ActorEvent<Evs<M>["Type"]>>
      <E extends Evs<M>>(event: E, options?: EventsOptions & StreamOptions): AsyncIterable<ActorEvent<E["Type"]>>
    }
  }
/** @category clients */
export interface ClientOptions {
  readonly baseUrl: string
  readonly headers?: Record<string, string>
  readonly fetch?: typeof fetch
  readonly timeoutInMs?: number
}
export interface PromiseClient<A extends AnyActor> {
  readonly get: (...args: [...IdArgs<A>, options?: { readonly tenant?: TenantId }]) => PromiseHandle<A>
  readonly create: A extends { readonly mode: "minted" } ? (options?: { readonly tenant?: TenantId }) => PromiseHandle<A> : never
}

// ---------------------------------------------------------------------------------------------------
// Contexts (decisions 9–13, 21–24, 91, 100, 103, 104, 108, 125–127, 131, 136, 158, 160, 163, 165)
// ---------------------------------------------------------------------------------------------------

export interface ConnectionInfo {
  readonly id: ConnectionId
  readonly caller: Caller
  readonly openedAt: DateTime.Utc
}
/** Broadcast is queued inside a command and flushed after COMMIT (like `emit`, not persisted); immediate elsewhere. Parked connections are woken by it. */
export interface ConnectionsHandle<M extends Members> {
  readonly broadcast: (frame: ServerOf<M["connections"][number]>, options?: { readonly except?: ConnectionId }) => Effect.Effect<void>
  readonly list: Effect.Effect<ReadonlyArray<ConnectionInfo>>
}

interface Identity<M extends Members> {
  readonly ref: ActorRef
  readonly id: IdOf<M>
  readonly tenantId: TenantId
  readonly now: DateTime.Utc
}
interface Attributed {
  readonly caller: Caller
  /** the user, or the principal a system caller acts for (decision 91) */
  readonly principal: Option.Option<Principal>
}
/** What every context on the activation reads without a transaction: committed rows, the state snapshot, blobs, vars. */
interface ActivationRead<M extends Members> extends Identity<M> {
  readonly db: Drizzle
  readonly rows: <T extends M["tables"][number]>(table: T) => ScopedRead<T>
  readonly state: StateSnapshot<M["state"]>
  readonly blob: <B extends M["blobs"][number]>(blob: B) => BlobRead
  readonly vars: VarsHandle<M["vars"]>
}

/** One transaction; the fence has been taken; `rows`, `state`, `blob` write into it. @category contexts */
export interface CommandContext<M extends Members> extends Identity<M>, Attributed {
  /** minted by the caller (or the edge); receipts key on it; stable across retries (decision 113) */
  readonly commandId: string
  /** joined to the turn transaction: joins and anything `rows` cannot say */
  readonly db: Drizzle
  /** declared `tables`, pre-scoped to this actor */
  readonly rows: <T extends M["tables"][number]>(table: T) => Scoped<T>
  /** declared `state` keys, loaded after the fence; `ctx.state.count` reads, `yield* ctx.state.set({...})` writes */
  readonly state: StateHandle<M["state"]>
  /** declared `vars`: per-activation memory, not part of the transaction */
  readonly vars: VarsHandle<M["vars"]>
  readonly blob: <B extends M["blobs"][number]>(blob: B) => BlobHandle
  /** durable intents to self — commands, timers and this actor's workflows; no request/reply inside a turn */
  readonly self: IntentHandle<M>
  /** durable intents to other actors */
  readonly actors: ActorIntents
  readonly timers: {
    readonly cancel: (key: string) => Effect.Effect<void>
  }
  /** typed to the actor's declared `events`; delivered after commit */
  readonly emit: (event: Evs<M>["Type"]) => Effect.Effect<void>
  /** typed to the actor's declared `effects`; executed after commit, at least once, by the executor in the server file */
  readonly perform: (effect: Efs<M>["Type"]) => Effect.Effect<void>
  readonly connections: ConnectionsHandle<M>
  /** tombstones this generation, deletes the declared `tables` rows and purges timers; later commands recreate the actor (or fail `NotCreated`) */
  readonly terminate: Effect.Effect<void>
}
/** Ambient access to the current turn from deep inside handler code. Present only inside a command handler. @category contexts */
export class Turn extends Context.Service<Turn, CommandContext<any>>()("durable-actors/Turn") {}

/** Runs on the caller's node. No fence, no receipt, no transaction, no activation (so no `vars`); reads are structurally read-only (decision 103). @category contexts */
export interface QueryContext<M extends Members> extends Identity<M>, Attributed {
  readonly db: Drizzle
  readonly rows: <T extends M["tables"][number]>(table: T) => ScopedRead<T>
  /** committed snapshot */
  readonly state: Readonly<StateValues<M["state"]>>
  readonly blob: <B extends M["blobs"][number]>(blob: B) => BlobRead
}
export class Query extends Context.Service<Query, QueryContext<any>>()("durable-actors/Query") {}

/**
 * Runs on the actor's node, forked past `concurrency: 1` (Rpc.fork), so a long stream never blocks
 * commands. Live only: the rpc is annotated `Persisted: false`, a reconnect starts a fresh stream.
 * @category contexts
 */
export interface StreamContext<M extends Members> extends ActivationRead<M>, Attributed {
  readonly events: EventsMethod<Evs<M>>
  readonly connections: ConnectionsHandle<M>
}
/**
 * A connection handler runs on the activation for the life of the socket. Under `Connections.park` (default) the
 * activation may sleep with the socket open; the handler is re-run on wake with `conn.resumed = true` and the same
 * `conn.state`, and `inbound` continues from the frame that woke it.
 * @category contexts
 */
export interface ConnectionContext<M extends Members, N extends AnyConnection> extends StreamContext<M> {
  readonly conn: {
    readonly id: ConnectionId
    readonly caller: Caller
    /** per-connection, ≤ 16 KiB, kept by the edge across hibernation (decision 163) */
    readonly state: VarsHandle<ConnStateOf<N>>
    /** `true` when this handler run continues a parked socket rather than opening a new one */
    readonly resumed: boolean
  }
  /** durable intents from a connection handler (a durable change is still a command); typed to this actor's commands and workflows */
  readonly self: IntentHandle<M>
}

/**
 * OnWake / OnSleep / OnDefect: no transaction, no caller, so nothing here writes (decision 136): rows, state and blobs
 * are the committed snapshot. Maintenance that writes (compaction, backfills) is an `internal` command the
 * hook schedules with `ctx.self`.
 * @category contexts
 */
export interface WakeContext<M extends Members> extends ActivationRead<M> {
  readonly self: IntentHandle<M>
}
/**
 * `run` (decision 127, 169): a long-lived loop on the activation, started on wake, interrupted on sleep — sugar for
 * `Effect.forkScoped` in the Effect form of `toLayer`, whose scope *is* the activation. No transaction, no `rows`
 * writes: durable changes are intents; `state` is the committed snapshot, refreshed after each turn. A `run` fiber
 * does not keep the actor awake.
 * @category contexts
 */
export interface RunContext<M extends Members> extends WakeContext<M> {
  readonly events: EventsMethod<Evs<M>>
  readonly actors: ActorIntents
  readonly connections: ConnectionsHandle<M>
}

/** Outbox executor context. There is no `db`: results come back to the actor as intents on `ctx.self`. @category contexts */
export interface EffectContext<M extends Members> extends Identity<M> {
  readonly commandId: string
  readonly attempt: number
  readonly principal: Option.Option<Principal>
  readonly self: IntentHandle<M>
}

/** What a workflow body sees (decisions 24, 119, 158, 166). @category contexts */
export interface WorkflowContext<M extends Members> {
  readonly executionId: ExecutionId
  /** the owner-scoped key this run was started under */
  readonly key: string
  /** `System("workflow", { onBehalfOf })`: who started it */
  readonly principal: Option.Option<Principal>
  /** the owning actor: full request/reply, internal commands included (there is no turn to hold open) */
  readonly owner: WorkflowHandle<M>
  /** other actors, same rules */
  readonly actors: WorkflowActors
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
  /**
   * DurableDeferred resolved by the owner's next matching event (decision 166); `None` on timeout. The registration is
   * acknowledged by the owner before this returns, so an event emitted meanwhile is not lost (decision 144).
   */
  readonly waitFor: <E extends Evs<M>>(
    event: E,
    options?: { readonly where?: (event: E["Type"]) => boolean; readonly timeout?: Duration.Input }
  ) => Effect.Effect<Option.Option<E["Type"]>>
}

export interface ActorIntents {
  readonly get: <A extends AnyActor>(actor: A, ...args: [...IdArgs<A>, options?: { readonly tenant?: TenantId }]) => IntentHandle<A>
}
export interface WorkflowActors {
  readonly get: <A extends AnyActor>(actor: A, ...args: [...IdArgs<A>, options?: { readonly tenant?: TenantId }]) => WorkflowHandle<A>
}

// ---------------------------------------------------------------------------------------------------
// Server-side: handlers, hooks, executors, run (decisions 11, 23, 108, 109, 127, 159, 161, 169)
// ---------------------------------------------------------------------------------------------------

export interface Hook<R> {
  readonly _tag: "OnCreate" | "OnWake" | "OnSleep" | "OnEffectFailed" | "OnDefect"
  readonly run: (...args: ReadonlyArray<any>) => Effect.Effect<void, never, R>
}

/** Commands, streams, connections and workflow bodies, keyed by tag; `(ctx, input)` everywhere (decision 108). */
export type HandlersFor<M extends Members, R> =
  & { readonly [C in Cmds<M> as C["tag"]]: (ctx: CommandContext<M>, ...args: Args<C>) => Effect.Effect<OutOf<C>, ErrOf<C>, R> }
  & { readonly [St in M["streams"][number] as St["tag"]]: (ctx: StreamContext<M>, ...args: Args<St>) => Stream.Stream<OutOf<St>, ErrOf<St>, R> }
  & { readonly [N in M["connections"][number] as N["tag"]]: (ctx: ConnectionContext<M, N>, ...args: [...ParamsArgs<N>, inbound: Stream.Stream<ClientOf<N>>]) => Stream.Stream<ServerOf<N>, ErrOf<N>, R> }
  & { readonly [W in Wfs<M> as W["tag"]]: (ctx: WorkflowContext<M>, input: InputOf<W>) => Effect.Effect<OutOf<W>, ErrOf<W>, R> }

export type QueryHandlersFor<M extends Members, R> = {
  readonly [Q in M["queries"][number] as Q["tag"]]: (ctx: QueryContext<M>, ...args: Args<Q>) => Effect.Effect<OutOf<Q>, ErrOf<Q>, R>
}

/** `(ctx, effect)`: the same argument order as every other handler (decision 108). */
export type EffectExecutors<M extends Members, R> = {
  readonly [E in Efs<M> as E["Type"]["_tag"]]: (ctx: EffectContext<M>, effect: E["Type"]) => Effect.Effect<void, unknown, R>
}

/** Server-side: hooks and executors carry code, so they live with `toLayer` / `X.of` (decision 109). */
export interface ServeOptions<M extends Members, RX> {
  readonly hooks?: ReadonlyArray<Hook<RX>>
  readonly effects?: EffectExecutors<M, RX>
  readonly run?: (ctx: RunContext<M>) => Effect.Effect<void, never, RX>
  /** placement (decisions 128, 159): `ClusterSchema.ShardGroup` for this actor; overrides `Actor.layer({ shardGroup })` */
  readonly shardGroup?: string | ((ref: ActorRef) => string)
  /** passed through to `Entity.toLayer`; the framework already sets actor/id/tenant/command/commandId (decisions 112, 168) */
  readonly spanAttributes?: Record<string, string>
}

export const ServeTypeId = "~durable-actors/Serve" as const
export type ServeTypeId = typeof ServeTypeId

/** What `X.of(handlers, options)` returns: the handlers plus the closure the activation captured. */
export interface Serve<M extends Members, R, RX> extends ServeOptions<M, RX> {
  readonly [ServeTypeId]: ServeTypeId
  readonly handlers: HandlersFor<M, R>
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
// The kind: Actor.make (decisions 1–13, 89–134, 157, 158, 164)
// ---------------------------------------------------------------------------------------------------

/** Framework-minted ids (decision 164): UUIDv7 branded per actor, `X.id` is the schema. */
export type MintedId<Name extends string> = Schema.brand<Schema.String, `${Name}Id`>
/** A singleton's only id. */
export const SingletonId = Schema.Literal("singleton")
export type SingletonId = typeof SingletonId
type ModeOf<Id, Single> = Single extends true ? "singleton" : Id extends Schema.Top ? "named" : "minted"
type IdSchemaOf<Name extends string, Id, Single> = Single extends true ? SingletonId : Id extends Schema.Top ? Id : MintedId<Name>

/** @category kinds */
export type ActorDefinition<Name extends string, Mode extends IdMode, M extends Members, Desc extends string | undefined> =
  & M
  & {
    readonly _kind: "actor"
    readonly name: Name
    readonly description: Desc
    readonly mode: Mode
    /**
     * `const counter = yield* Counter.get(id)` — resolves the runtime and binds the caller once; methods are then
     * plain Effects with `R = never`. The caller is the ambient `CurrentCaller` unless `{ as }` says otherwise.
     * A singleton takes no id.
     */
    readonly get: (...args: [...IdArgs<{ readonly mode: Mode; readonly id: M["id"] }>, options?: GetOptions]) => Effect.Effect<Handle<M>, never, Actors>
    /** Minted ids only: a fresh UUIDv7 handle. Nothing is written until the first command (decision 164). */
    readonly create: Mode extends "minted" ? (options?: GetOptions) => Effect.Effect<Handle<M>, never, Actors>
      : Mode extends "named" ? `${Name} declares its own ids: mint one and call get(id)`
      : `${Name} is a singleton: call get()`
    /** Promise client derived from `rpcs` over HTTP/WebSocket; mints `x-command-id` per call and reuses it on retry. */
    readonly client: (options: ClientOptions) => PromiseClient<ActorDefinition<Name, Mode, M, Desc>>
    /**
     * Lives in the server file. Handlers may be an object or an Effect returning `X.of(...)`. The Effect form runs once
     * per activation inside the activation's `Scope` (decision 169): `Effect.addFinalizer` runs on sleep,
     * `Effect.forkScoped` fibers are interrupted on sleep. A singleton's layer also registers the boot activation
     * (`Sharding.registerSingleton`), so its crons tick without a caller.
     */
    readonly toLayer: {
      <R, RX = never>(handlers: HandlersFor<M, R> & InsideTurn<R>, options?: ServeOptions<M, RX>): Layer.Layer<never, never, Exclude<R | RX, Turn | Query> | Actors>
      <R, RX, RB>(build: Effect.Effect<Serve<M, R, RX>, never, RB>): Layer.Layer<never, never, Exclude<R | RB | RX, Scope.Scope | Turn | Query> | Actors>
    }
    /** Queries never touch the entity: they read committed rows on the caller's node (decisions 4, 102). */
    readonly toQueryLayer: {
      <R>(handlers: QueryHandlersFor<M, R>): Layer.Layer<never, never, Exclude<R, Query> | Database>
      <R, RB>(build: Effect.Effect<QueryHandlersFor<M, R>, never, RB>): Layer.Layer<never, never, Exclude<R | RB, Query | Scope.Scope> | Database>
    }
    /** packages the handlers with the activation closure's hooks, executors and run loop */
    readonly of: <R, RX = never>(handlers: HandlersFor<M, R> & InsideTurn<R>, options?: ServeOptions<M, RX>) => Serve<M, R, RX>
    /** identity with contextual typing, for query handlers returned from an Effect */
    readonly ofQueries: <R>(handlers: QueryHandlersFor<M, R>) => QueryHandlersFor<M, R>
    /** first turn ever for this id; runs inside that turn's transaction before the command handler */
    readonly onCreate: <R>(run: (ctx: CommandContext<M>) => Effect.Effect<void, never, R>) => Hook<R>
    readonly onWake: <R>(run: (ctx: WakeContext<M>) => Effect.Effect<void, never, R>) => Hook<R>
    readonly onSleep: <R>(run: (ctx: WakeContext<M>) => Effect.Effect<void, never, R>) => Hook<R>
    /** runs inside a turn: the dead-lettered effect is delivered to the actor as a framework command after `Effects.retry` is exhausted */
    readonly onEffectFailed: <R>(run: (ctx: CommandContext<M>, effect: Efs<M>["Type"], cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R>) => Hook<R>
    /**
     * A deterministic defect (decision 161: state over `State.maxBytes`, a decode failure, an internal command from a
     * non-System caller): the turn rolled back, the caller got a `Die`, the actor stays resident. Not the retryable
     * defects of F4, which restart the activation instead.
     */
    readonly onDefect: <R>(run: (ctx: WakeContext<M>, command: string, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R>) => Hook<R>
    /** escape hatches: the Effect primitives underneath */
    readonly rpcs: RpcGroup.RpcGroup<RpcsOf<[...M["commands"], ...M["queries"], ...M["streams"]]>>
    readonly entity: Entity.Entity<Name, RpcsOf<[...M["commands"], ...M["streams"]]>>
  }

/**
 * The one kind (decision 157). Durability is not a flag: an actor that declares no `state`, `tables`, `events` or
 * `effects` never touches those rows, and its commands still run as fenced, receipted turns. Ids: none declared ⇒
 * minted (`X.create()`), `id: Schema` ⇒ named (`X.get(id)`), `singleton: true` ⇒ `X.get()` (decision 164).
 * @category kinds
 */
export const make = <
  const Name extends string,
  Id extends Schema.Top | undefined = undefined,
  Single extends boolean = false,
  const Cs extends ReadonlyArray<AnyCommand> = [],
  const Is extends ReadonlyArray<Cs[number]> = [],
  const Qs extends ReadonlyArray<AnyQuery> = [],
  const Ss extends ReadonlyArray<AnyStream> = [],
  const Cn extends ReadonlyArray<AnyConnection> = [],
  const Ws extends ReadonlyArray<AnyWorkflow> = [],
  const Ev extends AnyTagged = never,
  const Ef extends AnyTagged = never,
  const Ts extends ReadonlyArray<AnyTable> = [],
  const S extends Schema.Struct.Fields = {},
  const V extends Schema.Struct.Fields = {},
  const Bs extends ReadonlyArray<AnyBlob> = [],
  const Ms extends ReadonlyArray<AnyMigration> = [],
  const Ps extends ReadonlyArray<Policy<Cs[number]>> = [],
  const Desc extends string | undefined = undefined
>(
  name: Name,
  def: {
    readonly description?: Desc
    /** omit for framework-minted ids; a branded schema for ids the app owns (decision 164) */
    readonly id?: Id
    /**
     * Exactly one instance cluster-wide; `get()` takes no id. The framework registers a boot activation
     * (`Sharding.registerSingleton`) that keeps it resident on one runner, so `Hibernate.after` is ignored, a
     * `Cron` policy ticks without a caller and `run` starts at boot (decision 170). Everything else is an ordinary
     * actor: fenced turns, receipts, state, events, effects.
     */
    readonly singleton?: Single
    readonly commands?: Cs
    /** reachable from `ctx.self`, `ctx.actors`, workflows and executors; absent from handles and HTTP (decision 95) */
    readonly internal?: Is
    readonly queries?: Qs
    readonly streams?: Ss
    readonly connections?: Cn
    /** durable executions this actor owns (decision 158); bodies live in `toLayer` next to the command handlers */
    readonly workflows?: Ws
    readonly events?: ReadonlyArray<Ev>
    readonly effects?: ReadonlyArray<Ef>
    readonly tables?: Ts
    /**
     * keyed state in `actor_state`, loaded after the fence (decision 125). A missing row decodes `{}`, so every
     * key needs `Schema.withDecodingDefault(...)` or `Schema.optionalKey(...)`: a bare `Schema.Number` key makes
     * the first turn die with a defect naming the key.
     */
    readonly state?: S
    /** typed per-activation memory (decision 160); same default rule as `state` */
    readonly vars?: V
    readonly blobs?: Bs
    /** the state's history, oldest first; the last `to` is the declared `state` (decision 162) */
    readonly migrations?: Ms
    readonly lifecycle?: Ps
  }
): ActorDefinition<Name, ModeOf<Id, Single>, {
  readonly id: IdSchemaOf<Name, Id, Single>
  readonly commands: Cs
  readonly internal: Is
  readonly queries: Qs
  readonly streams: Ss
  readonly connections: Cn
  readonly workflows: Ws
  readonly events: ReadonlyArray<Ev>
  readonly effects: ReadonlyArray<Ef>
  readonly tables: Ts
  readonly state: S
  readonly vars: V
  readonly blobs: Bs
  readonly migrations: Ms
  readonly lifecycle: Ps
}, Desc> => {
  const commands = (def.commands ?? []) as unknown as Cs
  const queries = (def.queries ?? []) as unknown as Qs
  const streams = (def.streams ?? []) as unknown as Ss
  const connections = (def.connections ?? []) as unknown as Cn
  const workflows = (def.workflows ?? []) as unknown as Ws
  const lifecycle = (def.lifecycle ?? []) as unknown as Ps
  const mode: IdMode = def.singleton === true ? "singleton" : def.id !== undefined ? "named" : "minted"
  const id = (def.singleton === true ? SingletonId : def.id ?? Schema.String.pipe(Schema.brand(`${name}Id`))) as any
  assertUniqueTags(name, [...commands, ...queries, ...streams, ...connections, ...workflows])
  assertMigrationChain(name, def.migrations ?? [], def.state ?? {})
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
  // one Effect Workflow per member, namespaced by the owner (decision 158); the payload carries the envelope (decision 144)
  const engineWorkflows = Object.fromEntries(workflows.map((w) => [
    w.tag,
    EffectWorkflow.make(`${name}/${w.tag}`, {
      payload: { ...w.input.fields, __tenant: TenantId, __deployment: DeploymentId, __owner: Schema.String, __key: Schema.String, __onBehalfOf: Schema.Option(Schema.Unknown) },
      idempotencyKey: (p: any) => JSON.stringify([p.__deployment, p.__tenant, p.__owner, p.__key]),
      success: w.output,
      error: w.errors.length === 0 ? Schema.Never : Schema.Union(w.errors)
    })
  ]))

  const get = (...args: ReadonlyArray<any>) =>
    Effect.gen(function*() {
      const [entityId, options]: [unknown, GetOptions | undefined] = mode === "singleton" ? ["singleton", args[0]] : [args[0], args[1]]
      const actors = yield* Actors
      const caller = options?.as !== undefined ? toCaller(options.as) : yield* CurrentCaller
      return (actors.get as any)(self, entityId, { tenant: options?.tenant, as: caller })
    })

  const self = {
    _kind: "actor",
    name,
    description: def.description,
    mode,
    id,
    commands,
    internal: (def.internal ?? []) as unknown as Is,
    queries,
    streams,
    connections,
    workflows,
    events: def.events ?? [],
    effects: def.effects ?? [],
    tables: (def.tables ?? []) as unknown as Ts,
    state: (def.state ?? {}) as S,
    vars: (def.vars ?? {}) as V,
    blobs: (def.blobs ?? []) as unknown as Bs,
    migrations: (def.migrations ?? []) as unknown as Ms,
    lifecycle,
    get,
    create: mode === "minted"
      ? (options?: GetOptions) => Effect.flatMap(Effect.flatMap(Actors, (a) => a.mint(self)), (fresh) => get(fresh, options))
      : mode === "named"
      ? `${name} declares its own ids: mint one and call get(id)`
      : `${name} is a singleton: call get()`,
    client: (options: ClientOptions) => makePromiseClient(self, options),
    toLayer: (build: unknown, options?: ServeOptions<any, any>) =>
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
            yield* registerWorkflows(self, engineWorkflows, handlers)
            return wired
          }),
          {
            concurrency: 1,
            maxIdleTime: policy("Hibernate")?.after ?? Duration.minutes(1),
            mailboxCapacity: policy("MailboxCapacity")?.size,
            defectRetryPolicy: policy("DefectRetry")?.schedule,
            spanAttributes: options?.spanAttributes
          }
        )
        .pipe(
          Layer.provide(Layer.effect(Sharding.Sharding, Effect.map(ActorRuntime, (a) => a.sharding))),
          mode === "singleton" ? Layer.provideMerge(singletonBoot(self, options?.shardGroup)) : (l: Layer.Layer<any, any, any>) => l
        ),
    toQueryLayer: (build: unknown) =>
      Layer.effectDiscard(
        Effect.gen(function*() {
          const handlers = Effect.isEffect(build) ? yield* (build as Effect.Effect<any>) : build
          yield* registerQueries(self, handlers as Record<string, unknown>)
        })
      ),
    of: (handlers: unknown, options?: ServeOptions<any, any>) => ({ [ServeTypeId]: ServeTypeId, handlers, ...options }),
    ofQueries: (handlers: unknown) => handlers,
    onCreate: (run: unknown) => ({ _tag: "OnCreate", run }),
    onWake: (run: unknown) => ({ _tag: "OnWake", run }),
    onSleep: (run: unknown) => ({ _tag: "OnSleep", run }),
    onEffectFailed: (run: unknown) => ({ _tag: "OnEffectFailed", run }),
    onDefect: (run: unknown) => ({ _tag: "OnDefect", run }),
    rpcs,
    entity
  } as any
  return self
}

// ---------------------------------------------------------------------------------------------------
// Runtime: Actors, ActorRuntime, layer, topology, auth, serve (decisions 90, 92, 111, 118, 128, 129, 155, 168)
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
  readonly get: <A extends AnyActor>(actor: A, ...args: [...IdArgs<A>, options: { readonly tenant?: TenantId; readonly as: Caller }]) => Handle<A>
  /** a fresh UUIDv7 in the actor's brand (`Crypto.randomUUIDv7`); `X.create()` is `mint` + `get` */
  readonly mint: <A extends AnyActor & { readonly mode: "minted" }>(actor: A) => Effect.Effect<IdOf<A>>
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

export const Topology = {
  single: (): Topology => ({ _tag: "Single" }),
  http: (options: {
    readonly listen: { readonly host: string; readonly port: number }
    readonly advertise: { readonly host: string; readonly port: number }
  }): Topology => ({ _tag: "Http", ...options }),
  /** `ACTORS_TOPOLOGY=single|http`, `ACTORS_LISTEN_HOST/PORT`, `ACTORS_ADVERTISE_HOST/PORT` (decision 118) */
  fromConfig: (options?: { readonly prefix?: string }): Config.Config<Topology> => topologyConfig(options?.prefix ?? "ACTORS")
}

/**
 * Runtime layer: one per process. It builds the runner from `topology` and provides `Sharding` and
 * `WorkflowEngine` internally, so actor layers only ever require `Actors`. Three ways to run it (decision 155):
 * embedded (this layer inside the app's own process), served (`Actor.serve` in a separate process), hosted
 * (the same layer, our runners, Neki). Cluster RPC spans are named `durable-actors.<Actor>/<Command>` with
 * `rpc.system.name`, `rpc.service`, `rpc.method` and the turn attributes; trace context rides the envelope
 * (decision 168, provided by Effect RPC).
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
  /** default placement (decision 128) for every actor; `X.toLayer(…, { shardGroup })` overrides per actor (159) */
  readonly shardGroup?: (tenant: TenantId) => string
  /** `entityMessagePollInterval`; default `"1 second"` (decision 129), plus sleep-then-poll for self-armed timers and `LISTEN actor_wake` on Postgres */
  readonly pollInterval?: Duration.Input
}) => Layer.Layer<Actors | ActorRuntime, ConfigError, Database>

/** Turns request headers into a caller; used by `Actor.serve` and by the Rpc middleware for `CurrentCaller`. @category runtime */
export interface Auth<R> {
  readonly handler: (headers: Headers) => Effect.Effect<Caller, Unauthorized, R>
}
/** `auth` is required on `serve` (decision 92); anonymous is spelled out. Handlers fail with the `Unauthorized` reason; the edge wraps it. @category runtime */
export const auth = {
  make: <R>(handler: (headers: Headers) => Effect.Effect<Principal, Unauthorized, R>): Auth<R> => ({ handler: (h) => Effect.map(handler(h), Caller.user) }),
  none: { handler: () => Effect.succeed(Caller.anonymous) } as Auth<never>,
  bearer: <R>(verify: (token: string) => Effect.Effect<Principal, Unauthorized, R>): Auth<R> => ({
    handler: (headers) => {
      const value = headers["authorization"]
      if (value === undefined || !value.startsWith("Bearer ")) return Effect.fail(new Unauthorized({ code: "missing_credentials" }))
      return Effect.map(verify(value.slice("Bearer ".length)), Caller.user)
    }
  }),
  header: <R>(name: string, decode: (value: string) => Effect.Effect<Principal, Unauthorized, R>): Auth<R> => ({
    handler: (headers) => {
      const value = headers[name.toLowerCase()]
      return value === undefined ? Effect.fail(new Unauthorized({ code: "missing_credentials" })) : Effect.map(decode(value), Caller.user)
    }
  })
}

/**
 * Optional HTTP entrypoint (decision 155): `/actors/{name}/{id}/{Command}` for every public command, query, stream (SSE)
 * and connection (WebSocket), `/actors/{name}/{id}/events` (SSE), `/actors/{name}/{id}/{Workflow}/start|result`,
 * `/actors/{name}` (POST: create, minted ids). `/openapi.json` unless `openapi: false`. Echoes the commandId as
 * `x-request-id` (decision 107). Nothing AI-specific (decision 153): OpenAPI is what tools and agents consume.
 * @category runtime
 */
export declare const serve: <R = never>(options: {
  readonly actors: ReadonlyArray<AnyActor>
  readonly auth: Auth<R>
  readonly openapi?: boolean
  readonly path?: string
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
   * why this turn ran: an outside call, a durable intent, a due timer, a cron tick, a dead-lettered effect, a workflow
   * start/cancel, or redelivery — the same requestId seen again, either rewritten by the EntityManager after a defect
   * restart (in memory, same runner) or re-read from storage after the shard moved. Cluster does not label this;
   * `turn()` tracks requestIds.
   */
  readonly trigger: "call" | "intent" | "timer" | "cron" | "effect-failed" | "workflow" | "redelivery"
  /** receipt hit: the handler did not run, the stored Exit was replayed */
  readonly replayed: boolean
  readonly exit: Exit.Exit<unknown, unknown>
  readonly emitted: ReadonlyArray<{ readonly _tag: string }>
  readonly performed: ReadonlyArray<{ readonly _tag: string }>
  readonly intents: ReadonlyArray<{ readonly to: ActorRef; readonly command: string; readonly input: unknown; readonly key?: string; readonly deliverAt?: DateTime.Utc }>
  readonly cancelledTimers: ReadonlyArray<string>
  readonly workflowsStarted: ReadonlyArray<{ readonly workflow: string; readonly key: string; readonly input: unknown }>
  readonly stateWritten: ReadonlyArray<string>
  /** a migration chain ran on load: `from → to` versions */
  readonly migrated: Option.Option<{ readonly from: number; readonly to: number }>
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
 * BEGIN → set_config('actor.tenant_id') → SELECT actor_generations … FOR UPDATE → receipt lookup → load actor_state (+ migrations)
 *       → (OnCreate on first turn) → handler → actor_state (dirty keys) / actor_events / actor_outbox / cluster_messages / receipt
 *       → TurnHooks.beforeCommit → COMMIT → TurnHooks.afterCommit → flush connection broadcasts → NOTIFY actor_wake.
 * Wrapped in `Effect.withSpan("durable-actors/turn", { actor, id, tenant, command, commandId, caller, trigger, replayed })`
 * and `Effect.annotateLogs({ actor, id, commandId })` (decision 112).
 * Retryable conditions (stale generation, lock timeout, commit-unknown, CommandTimeout) are defects that restart the
 * activation (F4); deterministic defects roll back, ack with Die and keep the actor resident (decision 161).
 * On Neki the intents go to `actor_outbox` in the tenant shard and are relayed to `cluster_messages` after COMMIT (decision 156).
 */
declare const turn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  envelope: unknown,
  lifecycle: ReadonlyArray<Policy>,
  serve: ServeOptions<any, any> | undefined,
  body: (ctx: CommandContext<any>) => Effect.Effect<A, E, R>
) => Effect.Effect<A, E | ActorError, Exclude<R, Turn> | ActorRuntime>
declare const streamTurn: <A, E, R>(
  address: EntityAddress.EntityAddress,
  body: (ctx: StreamContext<any>) => Stream.Stream<A, E, R>
) => Stream.Stream<A, E, Exclude<R, Query> | ActorRuntime>
/** Query handlers are registered in-process by the query layer; `handle.Query()` runs them here, against Database. */
declare const registerQueries: (actor: AnyActor, handlers: Record<string, unknown>) => Effect.Effect<void, never, Database>
/** `wf.toLayer` per member, bodies wrapped with the owner handle and `waitFor`; provided `WorkflowEngine` from `ActorRuntime`. */
declare const registerWorkflows: (actor: AnyActor, workflows: Record<string, unknown>, handlers: Record<string, unknown>) => Effect.Effect<void, never, ActorRuntime>
/** `Sharding.registerSingleton(name, wake)`: the boot activation that lets a singleton's crons and `run` start without a caller. */
declare const singletonBoot: (actor: AnyActor, shardGroup: string | ((ref: ActorRef) => string) | undefined) => Layer.Layer<never, never, Actors>
declare const makePromiseClient: <A extends AnyActor>(actor: A, options: ClientOptions) => PromiseClient<A>
declare const topologyConfig: (prefix: string) => Config.Config<Topology>
declare const assertUniqueTags: (actor: string, members: ReadonlyArray<{ readonly tag: string }>) => void
/** each `to` is the next `from`; the last `to` is the declared state */
declare const assertMigrationChain: (actor: string, migrations: ReadonlyArray<AnyMigration>, state: Schema.Struct.Fields) => void

/**
 * The namespace an agent types `Actor.` into. Levels (decisions 134, 157): the kind `make`; members `command | query |
 * stream | connection | workflow | table | blob | migration`; runtime `layer | serve | auth`; ambient `as | anonymous |
 * tenant | commandId`.
 */
export const Actor = {
  make,
  command, query, stream, connection, workflow, table, blob, migration,
  layer, serve, auth,
  as, anonymous, tenant, commandId
}
