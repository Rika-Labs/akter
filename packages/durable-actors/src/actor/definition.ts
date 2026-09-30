import type { Unify } from "effect"
import type { NodeInspectSymbol } from "effect/Inspectable"
import type { WorkflowEngine } from "effect/unstable/workflow"
import { Context, type Effect, type Layer, type Schema, type Scope, type Stream } from "effect"
import type { CommandContext, InStream, Mintable, QueryContext } from "../contexts/command.ts"
import type { EnqueueContext, ExecutorContext } from "../contexts/job.ts"
import type { BroadcastContext, ConnectionContext } from "../contexts/connection.ts"
import type { WorkflowContext } from "../contexts/workflow.ts"
import type { ActorError, SessionEnded } from "../errors/actor.ts"
import type { InvalidExecutionId, InvalidExecutionKey } from "../errors/workflow.ts"
import type { Actors } from "../handles/actors.ts"
import type { InTurn } from "../handles/intents.ts"
import type { WorkflowRun } from "../handles/run.ts"
import type { ActorRef } from "../identity/caller.ts"
import type { AnyBlob } from "../members/blob.ts"
import type {
  AnyCommand,
  AnyMember,
  CommandRecord,
  MemberKind,
  MemberRecord,
  ValueSchema,
} from "../members/command.ts"
import type { AnyConnection } from "../members/connection.ts"
import type { EventClass } from "../members/event.ts"
import type { AnyJob, AnyJobBinding, JobBinding } from "../members/job.ts"
import type { AnyStream } from "../members/stream.ts"
import type { AnySubscription, SubscribeContext } from "../members/subscription.ts"
import type { AnyWorkflow } from "../members/workflow.ts"
import type { Access } from "../policies/access.ts"
import type { Policy } from "../policies/command.ts"
import type { ScheduleTarget } from "../policies/schedules.ts"
import type { InternalActors } from "../runtime/actors.ts"
import type { NoDatabase } from "../runtime/effects/isolation.ts"
import type { ActorState } from "../state/migration.ts"
import type { AnyOwnedTable } from "../tables/owned.ts"
import { type ActorClient, type ClientOptions, clientOf } from "../client/make.ts"
import {
  compile,
  type Declaration,
  type KeySchema,
  publish,
  singleton,
  type SingletonKey,
} from "./descriptor.ts"
import { createOf, handleOf, intentsOf, runOfId } from "./handles.ts"
import { type Build, handlerLayer, jobLayer, type PhaseServices, queryLayer } from "./layers.ts"

type StateFields = Readonly<Record<string, ValueSchema>>

type StateOf<Fields extends StateFields> = Schema.Struct<Fields>["Type"]

type Key = KeySchema | SingletonKey | undefined

/** Type-only key of `Placed`; no value exists at runtime. */
export declare const PlacedType: unique symbol

/** Type-level record of how a definition is placed and what its ids are. */
export interface Placed<Kind extends "tenant" | "actor" | "parent", Id> {
  readonly [PlacedType]?: { readonly kind: Kind; readonly id: Id }
}

/** A definition children may be placed on: placed by `"actor"` or on a parent of its own. */
interface ParentDefinition extends Placed<"actor" | "parent", string> {
  readonly name: string
}

/**
 * Which rows share a shard: the tenant's, each actor's own, or the parent
 * actor's, whose id every child id carries.
 */
type PlacementOption = "tenant" | "actor" | { readonly parent: ParentDefinition }

type PlacementKind<Pl> = Pl extends "tenant" | "actor" ? Pl : "parent"

/** Type-only key of `DefinitionWithInternal`; no value exists at runtime. */
export declare const InternalHandleType: unique symbol

/**
 * Type-level record of a definition's internal handle, which reaches `internal`
 * commands as well as `api` members; `ActorTest` reads it to type its calls.
 */
export interface DefinitionWithInternal<H> {
  readonly [InternalHandleType]?: H
}

type HandleReason =
  | "ActorUnavailable"
  | "CommandConflict"
  | "CommandExpired"
  | "InvalidCommandId"
  | "Unauthorized"
  | "Timeout"
  | "RunnerAtCapacity"

type Values<Record extends MemberRecord> = Record[keyof Record]

type CommandsOf<Members extends MemberRecord> = Extract<
  Values<Members>,
  { readonly kind: "command" }
>

/** The keys of the members of `kind`. */
type KeysOf<Members extends MemberRecord, Kind extends MemberKind> = {
  [K in keyof Members]: Members[K]["kind"] extends Kind ? K : never
}[keyof Members]

type CommandKeys<Members extends MemberRecord> = KeysOf<Members, "command">

type QueryKeys<Members extends MemberRecord> = KeysOf<Members, "query">

type ConnectionKeys<Members extends MemberRecord> = KeysOf<Members, "connection">

type StreamKeys<Members extends MemberRecord> = KeysOf<Members, "stream">

type ConnectionsOf<Members extends MemberRecord> = Extract<
  Values<Members>,
  { readonly kind: "connection" }
> &
  AnyConnection

/** A connection member's entry in `X.toLayer`: short handlers, not one long-lived stream. */
export type ConnectionHandlers<C extends AnyConnection, R> = {
  /** Runs when a client opens the connection; a declared failure refuses it. */
  readonly open: (payload: C["payload"]["Type"]) => Effect.Effect<void, C["error"]["Type"], R>
  /** Runs once per client frame, in frame order, at least once per frame. */
  readonly frame: (frame: C["client"]["Type"]) => Effect.Effect<void, never, R>
  /** Runs when the connection ends, with the reason it ended. */
  readonly close?: (reason: SessionEnded["cause"]) => Effect.Effect<void, never, R>
  /** Replays what the client missed after `after` when its owner died; it cannot change the session. */
  readonly resync?: (input: { readonly after: string | undefined }) => Effect.Effect<void, never, R>
}

type WorkflowKeys<Members extends MemberRecord> = KeysOf<Members, "workflow">

type ReducerKeys<Members extends MemberRecord> = KeysOf<Members, "reducer">

/** A query reads committed rows: it cannot conflict, expire, or hit a mailbox. */
type QueryReason = "ActorUnavailable" | "Unauthorized" | "Timeout"

/** A subscription ends with its activation, its subscriber's authorization, or a full window. */
type StreamReason = "ActorUnavailable" | "Unauthorized" | "RunnerAtCapacity" | "SessionEnded"

/**
 * A watch ends like a subscription, and also with `NotCreated` for an actor no
 * command has created and `Timeout` for a rerun past `executionTimeout`. A
 * rerun that reads something no commit signal covers is a defect of the
 * handler here; a served watch reports it as `not_watchable`.
 */
type WatchReason = StreamReason | "NotCreated" | "Timeout"

/** A method's arguments: none for a `Schema.Void` payload, otherwise the payload. */
type PayloadArgs<M extends AnyMember> = M["payload"]["Type"] extends void
  ? []
  : [payload: M["payload"]["Type"]]

/**
 * The `watch` method of a query declared `watch: true`: its current result
 * first, then the newest result after each commit that wrote something its
 * last run read. It is a state, not a history: intermediate results are
 * skipped and an unchanged result is not repeated.
 */
type WatchMethod<M extends AnyMember> = M extends { readonly watch: true }
  ? {
      readonly watch: (
        ...args: PayloadArgs<M>
      ) => Stream.Stream<M["success"]["Type"], M["error"]["Type"] | ActorError.Of<WatchReason>>
    }
  : unknown

type Reasons<
  M extends AnyMember,
  Creating extends string,
  BoundedMailbox extends boolean,
> = M["kind"] extends "query"
  ? QueryReason
  :
      | HandleReason
      | (BoundedMailbox extends true ? "MailboxFull" : never)
      | ([Creating] extends [never] ? never : M["tag"] extends Creating ? never : "NotCreated")

/**
 * Durable intents to one actor, staged in the current command turn and
 * delivered after it commits: one method per command of `Members`, and per
 * workflow a method that stages its start. `X.intents` leaves out an `internal`
 * command named as a subscription `handler`, which only deliveries reach.
 */
export type Intents<Members extends MemberRecord> = {
  readonly [K in CommandKeys<Members>]: (
    ...args: PayloadArgs<Members[K]>
  ) => Effect.Effect<void, never, InTurn>
} & {
  /** Stages a workflow start and returns its execution id. */
  readonly [K in WorkflowKeys<Members>]: (
    ...args: PayloadArgs<Members[K]>
  ) => Effect.Effect<string, never, InTurn>
} & { readonly ref: ActorRef }

/**
 * A request/reply handle to one actor, from `X.get`: one method per public
 * command, reducer, query, workflow, and stream. Handles cannot be used inside
 * a turn; use `X.intents` there.
 *
 * Running the Effect a command method returns mints its command id once and
 * reuses it on every rerun, so a retry is deduplicated by the receipt. A query
 * uses no command id and reads a state at least as new as every commit this
 * runtime's commands returned. A workflow method starts the execution and
 * returns its `WorkflowRun`.
 *
 * @example
 * const counter = yield* Counter.get(id)
 * const value = yield* counter.Increment(1)
 */
export type Handle<
  Members extends MemberRecord,
  Creating extends string = never,
  BoundedMailbox extends boolean = false,
> = {
  readonly [K in Exclude<keyof Members, ConnectionKeys<Members> | StreamKeys<Members>>]: ((
    ...args: PayloadArgs<Members[K]>
  ) => Members[K] extends AnyWorkflow
    ? Effect.Effect<
        WorkflowRun<Members[K]>,
        InvalidExecutionKey | ActorError.Of<Reasons<Members[K], Creating, BoundedMailbox>>
      >
    : Effect.Effect<
        Members[K]["success"]["Type"],
        Members[K]["error"]["Type"] | ActorError.Of<Reasons<Members[K], Creating, BoundedMailbox>>
      >) &
    WatchMethod<Members[K]>
} & {
  /** Subscribes to a live feed on the actor's activation; it ends with that activation. */
  readonly [K in StreamKeys<Members>]: (
    ...args: PayloadArgs<Members[K]>
  ) => Stream.Stream<
    Members[K]["success"]["Type"],
    Members[K]["error"]["Type"] | ActorError.Of<StreamReason>
  >
} & { readonly ref: ActorRef }

/**
 * A handler of member `M` as a layer declares it. `R` is `any` so each
 * handler's own requirements are inferred and then collected by `ServicesOf`.
 */
type HandlerOf<M extends AnyMember, R = any> = (
  payload: M["payload"]["Type"],
) => Effect.Effect<M["success"]["Type"], M["error"]["Type"], R>

/** A stream member's entry in `X.toLayer`: its live feed for one subscriber. */
export type StreamHandler<S extends AnyStream, R> = (
  payload: S["payload"]["Type"],
) => Stream.Stream<S["success"]["Type"], S["error"]["Type"], R>

/**
 * The shape of `X.toLayer`'s handlers: one per command in `api` and
 * `internal` and per workflow, one entry per connection and stream; a reducer
 * has no handler. Workflow bodies run outside turns and may use request/reply
 * handles, but only inside a step's `execute`; calls from a step carry the
 * execution's recorded caller and skip the external access and command-id
 * expiry checks, as relay deliveries do, so accepted work continues after the
 * principal that started it loses access.
 */
type HandlerShape<Members extends MemberRecord> = {
  readonly [K in CommandKeys<Members> | WorkflowKeys<Members>]: HandlerOf<Members[K]>
} & {
  readonly [K in ReducerKeys<Members>]?: never
} & {
  readonly [K in ConnectionKeys<Members>]: ConnectionHandlers<Members[K] & AnyConnection, any>
} & {
  readonly [K in StreamKeys<Members>]: StreamHandler<Members[K] & AnyStream, any>
}

/** The services a handler, stream handler, or connection entry requires. */
type ServicesOf<Entry> = Entry extends (
  ...args: never
) => Effect.Effect<infer _A, infer _E, infer R>
  ? R
  : Entry extends (...args: never) => Stream.Stream<infer _A, infer _E, infer R>
    ? R
    : Entry extends object
      ? { readonly [P in keyof Entry]: ServicesOf<NonNullable<Entry[P]>> }[keyof Entry]
      : never

/** The services the entries of `H` at `Keys` require. */
type Needs<H, Keys> = { readonly [K in Keys & keyof H]: ServicesOf<H[K]> }[Keys & keyof H]

/**
 * Rejects a command handler that requires `Actors`: a handle acquired inside a
 * turn could only make a request/reply call, which dies. Intents are the
 * in-turn way to reach another actor.
 */
type RejectRequestReply<H, Keys> = {
  readonly [K in keyof H]: K extends Keys
    ? [Extract<ServicesOf<H[K]>, Actors>] extends [never]
      ? unknown
      : "Request/reply inside a turn: use X.intents(id)"
    : unknown
}

/**
 * One handler per query in `api`. A query declared `watch: true` may require
 * only `W`, the actor's `X.Read`, so a handler the runtime cannot record does
 * not compile.
 */
type QueryShape<Members extends MemberRecord, W> = {
  readonly [K in QueryKeys<Members>]: HandlerOf<
    Members[K],
    Members[K] extends { readonly watch: true } ? W : any
  >
}

/**
 * One executor per bound job, returning the job's `success` type, which is
 * routed to the binding's `onSuccess` command. An attempt is abandoned after
 * the binding's `timeout` (default 30 seconds) and retried up to
 * `retry.times` more times (default 3).
 *
 * Only a typed failure proves the provider did not apply the call; a defect,
 * a timeout, or an interruption leaves the attempt's outcome unknown. A result
 * `onSuccess` cannot accept is dead-lettered rather than executed again, since
 * the provider already applied it, and a cancelled job's result goes to
 * `onCancelled`, as an unknown outcome when that route cannot accept it. A
 * stored payload that no longer decodes never reaches the executor and is
 * still dead-lettered, without its route.
 */
export type Executors<J extends AnyJob, R = any> = {
  readonly [Tag in J["tag"]]: (
    job: Extract<J, { readonly tag: Tag }>["Type"],
  ) => Effect.Effect<Extract<J, { readonly tag: Tag }>["success"]["Type"], unknown, R>
}

/** Rejects an executor that requires a database capability, which executors never have. */
type RejectDatabase<H> = {
  readonly [K in keyof H]: NoDatabase<ServicesOf<H[K]>>
}

/** `api` and `internal` keys must equal their member's tag. */
type TagsMatch<Members extends MemberRecord> = {
  readonly [K in keyof Members]: Members[K] & { readonly tag: K }
}

/** Job bindings, keyed by each job's tag. */
type JobBindings = Readonly<Record<string, AnyJobBinding>>

/** Each binding is keyed by its job's tag and routes to commands of this actor. */
type JobsMatch<Jobs extends JobBindings, Command extends AnyCommand> = {
  readonly [K in keyof Jobs]: JobBinding<Jobs[K]["job"], Command> & {
    readonly job: { readonly tag: K }
  }
}

/** The jobs an actor binds. */
type JobsOf<Jobs extends JobBindings> = Jobs[keyof Jobs]["job"]

/** A reducer transforms the actor's own state, so its declared state must be exactly that state. */
type ReducerStates<Members extends MemberRecord, Fields extends StateFields> = {
  readonly [K in keyof Members]: Members[K] extends {
    readonly kind: "reducer"
    readonly state: ActorState<infer ReducerFields>
  }
    ? [ReducerFields, Fields] extends [Fields, ReducerFields]
      ? Members[K]
      : { readonly state: "A reducer's state must be its actor's state" }
    : Members[K]
}

interface Definition<
  Key,
  Fields extends StateFields,
  Api extends MemberRecord,
  Internal extends CommandRecord,
  Events extends ReadonlyArray<EventClass>,
  Tables extends ReadonlyArray<AnyOwnedTable>,
  Jobs extends JobBindings,
  Blobs extends ReadonlyArray<AnyBlob>,
  Subs extends ReadonlyArray<AnySubscription>,
  Pl extends PlacementOption,
> {
  /**
   * How instances are named: an id schema (`X.get(id)`), `Actor.singleton`
   * (`X.get()`), or omitted for minted ids (`X.create()` or `turn.mint`). A
   * parent-placed actor's key validates only the local part of its id.
   */
  readonly key?: Key
  /**
   * Which rows share a shard: the tenant (default), each actor on its own, or
   * `{ parent: P }`, the shard of the parent actor whose id each child id
   * carries. `P` is placed by `"actor"` or by a parent, at most four levels
   * below an actor-placed root.
   */
  readonly placement?: Pl
  /** `Actor.state` fields and migrations; an actor without it has no state. */
  readonly state?: ActorState<Fields>
  /** Event classes this actor may emit in a turn and replay in a query. */
  readonly events?: Events
  /**
   * The declared events `Actors.serve` serves as event feeds. None are served
   * unless listed, and `access` and `authorize` still decide who reads each.
   */
  readonly feeds?: ReadonlyArray<Events[number]>
  /**
   * `Actor.table` tables whose rows this actor type owns. A table belongs to
   * one actor type, so equal ids of two actor types never share rows.
   */
  readonly tables?: Tables
  /** `Actor.blob` binary storage and `Actor.content` references: turns write them, queries read them. */
  readonly blobs?: Blobs
  /**
   * Public members, each keyed by its tag. Omitted, the actor has none: only
   * intents, schedules, job routes, and subscriptions reach it.
   */
  readonly api?: Api & TagsMatch<Api> & ReducerStates<Api, NoInfer<Fields>>
  /**
   * Commands that `X.get` handles and `Actors.serve` never exposes, reached
   * by intents, schedules, job routes, and subscriptions; each keyed by its tag.
   */
  readonly internal?: Internal & TagsMatch<Internal>
  /**
   * The only command that may create the actor: until it commits, other
   * commands fail `NotCreated`. An unkeyed actor with one mints its ids in a
   * turn with `turn.mint`, and cannot adopt existing tables.
   */
  readonly createdBy?: CommandsOf<Api> | Values<Internal>
  /**
   * Schedules mapped to the command each tick runs with a
   * `System({ source: "cron" })` caller; the command's payload is
   * `Schema.Void`. A key is a five- or six-field cron expression evaluated in
   * UTC, the same prefixed `CRON_TZ=<IANA zone> ` to evaluate it in that zone,
   * or `@every <duration>` (at least 1 second) to fire on every multiple of
   * the duration since the Unix epoch. In a zone, a time a spring-forward gap
   * skips fires once at the first instant after the gap, and a time a
   * fall-back transition repeats fires once, at its first occurrence. A tick
   * fires at most once per scheduled time, never overlaps the previous tick of
   * its entry, and after downtime fires once rather than once per missed
   * time; one later than `policy.maxScheduleLag` is skipped.
   */
  readonly schedules?: Readonly<Record<string, ScheduleTarget<CommandsOf<Api> | Values<Internal>>>>
  /**
   * The `Actor.job` values this actor's turns may `enqueue`, keyed by tag,
   * each with this actor's retry, timeout, concurrency, and result routes.
   * Executors are deployed separately with `X.toJobLayer`.
   */
  readonly jobs?: Jobs & JobsMatch<Jobs, CommandsOf<Api> | Values<Internal>>
  /** Limits, retention, sessions, watches, and subscriber types. */
  readonly policy?: Policy
  /**
   * Who may do what to this actor: asked for every external command, query,
   * connection, stream, feed, live-session recheck, and content operation, and
   * required beside the runtime's global `authorize` when both exist. Without
   * it and without `authorize`, only `System` callers are allowed. Return
   * `false` for a kind you do not know.
   */
  readonly access?: Access | undefined
  /**
   * `Actor.subscription` members: other actors' committed events this actor
   * receives through internal handler commands.
   */
  readonly subscriptions?: Subs
}

/**
 * Validates and compiles a definition, throwing on any invalid declaration
 * before anything is published, and returns the actor type's handles,
 * layers, and client.
 */
const make = <
  const Name extends string,
  const Api extends MemberRecord = {},
  const Fields extends StateFields = {},
  const Internal extends CommandRecord = {},
  const K extends Key = undefined,
  const Events extends ReadonlyArray<EventClass> = readonly [],
  const T extends ReadonlyArray<AnyOwnedTable> = [],
  const Jobs extends JobBindings = {},
  const P extends Policy = {},
  const CB extends AnyCommand = never,
  const B extends ReadonlyArray<AnyBlob> = [],
  const F extends ReadonlyArray<Events[number]> = readonly [],
  const Subs extends ReadonlyArray<AnySubscription> = readonly [],
  const Pl extends PlacementOption = "tenant",
>(
  name: Name,
  definition: Definition<K, Fields, Api, Internal, Events, T, Jobs, B, Subs, Pl> & {
    readonly key?: K
    readonly policy?: P
    readonly feeds?: F
    readonly createdBy?: CB
  },
) => {
  const descriptor = compile(name, definition as Declaration)

  type Creating = [CB] extends [never] ? never : CB["tag"]

  type BoundedMailbox = P extends { readonly mailboxCapacity: number } ? true : false

  type PublicHandle = Handle<Api, Creating, BoundedMailbox>

  type All = Api & Internal

  type State = StateOf<Fields>

  type Event = Events[number]

  type Owned = T[number]

  type Blobs = B[number]

  type Bound = JobsOf<Jobs>

  type Connections = ConnectionsOf<Api>

  type Delivered = Omit<All, Subs[number]["handler"]["tag"]>

  class Turn extends Context.Service<
    Turn,
    CommandContext<State, Event, Owned, Blobs> &
      EnqueueContext<Bound> &
      BroadcastContext<Connections> &
      SubscribeContext<Subs[number]>
  >()(`durable-actors/Turn/${name}`) {}

  class Executor extends Context.Service<Executor, ExecutorContext<Bound>>()(
    `durable-actors/Executor/${name}`,
  ) {}

  class Workflow extends Context.Service<Workflow, WorkflowContext>()(
    `durable-actors/Workflow/${name}`,
  ) {}

  class Read extends Context.Service<Read, QueryContext<State, Event, Owned, Blobs, Bound>>()(
    `durable-actors/Read/${name}`,
  ) {}

  class Connection extends Context.Service<
    Connection,
    ConnectionContext<
      State,
      Event,
      Connections["server"]["Type"],
      Exclude<Connections["session"], undefined>["Type"]
    >
  >()(`durable-actors/Connection/${name}`) {}

  const phases: PhaseServices = { Turn, Read, Connection, Workflow, Executor }

  /** What a handler layer requires: its handlers' services beyond those the phase provides. */
  type HandlerNeeds<H> =
    | Exclude<Needs<H, CommandKeys<All>>, Turn | InTurn>
    | Exclude<Needs<H, ConnectionKeys<All>>, Connection>
    | Exclude<Needs<H, StreamKeys<All>>, Read | InStream>
    | Exclude<Needs<H, WorkflowKeys<All>>, Workflow | WorkflowEngine.WorkflowInstance | Scope.Scope>

  const toLayer = <
    const H extends HandlerShape<All> & RejectRequestReply<H, CommandKeys<All>>,
    E = never,
    RB = never,
  >(
    build: H | Effect.Effect<H, E, RB>,
  ) =>
    handlerLayer(descriptor, phases, build as Build) as Layer.Layer<
      never,
      K extends SingletonKey ? never : E,
      HandlerNeeds<H> | Exclude<RB, Scope.Scope> | InternalActors
    >

  const toQueryLayer = <const H extends QueryShape<Api, Read>, E = never, RB = never>(
    build: H | Effect.Effect<H, E, RB>,
  ) =>
    queryLayer(descriptor, phases, build as Build) as Layer.Layer<
      never,
      E,
      Exclude<Needs<H, QueryKeys<Api>>, Read> | Exclude<RB, Scope.Scope> | InternalActors
    >

  const toJobLayer = <const H extends Executors<Bound> & RejectDatabase<H>, E = never, RB = never>(
    build: (H | Effect.Effect<H, E, RB>) & NoDatabase<RB>,
  ) =>
    jobLayer(descriptor, phases, build as Build) as Layer.Layer<
      never,
      E,
      Exclude<Needs<H, keyof H>, Executor> | Exclude<RB, Scope.Scope> | InternalActors
    >

  type Id = Pl extends { readonly parent: ParentDefinition }
    ? Schema.brand<Schema.String, Name>["Type"]
    : K extends KeySchema
      ? K["Type"]
      : Schema.brand<Schema.String, Name>["Type"]

  type ParentId = Pl extends { readonly parent: infer Parent extends ParentDefinition }
    ? NonNullable<Parent[typeof PlacedType]>["id"]
    : never

  type LocalKey = K extends KeySchema ? K["Type"] : never

  type ServedKey = K extends SingletonKey
    ? "singleton"
    : K extends undefined
      ? PlacementKind<Pl> extends "parent"
        ? "keyed"
        : "minted"
      : "keyed"

  /** Builds a parent-placed actor's full id from its parent's id and its own key. */
  const idOf = (parentId: ParentId, local: LocalKey): Id =>
    descriptor.childId(parentId, local) as Id

  const actor = {
    /** The actor type's name: a letter followed by up to 79 letters or digits. */
    name,
    /** The schema of the actor's decoded state. */
    state: descriptor.state.schema as Schema.Struct<Fields>,
    /** The declared public members. */
    api: (definition.api ?? {}) as Api,
    /** Event classes this actor emits, which subscriptions to it may name. */
    events: (definition.events ?? []) as Events,
    /** The context of a command turn, read with `yield* X.Turn` in `X.toLayer` handlers. */
    Turn,
    /** The read-only context of a query or stream handler, read with `yield* X.Read`. */
    Read,
    /** The context of a connection handler, read with `yield* X.Connection`. */
    Connection,
    /** The context of one executor attempt, read with `yield* X.Executor`. */
    Executor,
    /** The context of a workflow body, read with `yield* X.Workflow`. */
    Workflow,
    /**
     * Reattaches to a workflow execution by id without contacting its owner. An
     * id of another tenant, actor type, or workflow fails `InvalidExecutionId`.
     */
    run: ((member: AnyWorkflow, executionId: string) =>
      runOfId(descriptor, member, executionId)) as <W extends Extract<Values<Api>, AnyWorkflow>>(
      member: W,
      executionId: string,
    ) => Effect.Effect<WorkflowRun<W>, InvalidExecutionId, Actors>,
    /**
     * Implements every `api` and `internal` command, connection, stream, and
     * workflow; reducers have no entry. Pass the handlers directly, or an
     * Effect that builds them from services; each handler's requirements are
     * inferred. Command handlers read their turn with `yield* X.Turn`, and one
     * that acquires a handle with `X.get` does not compile.
     *
     * The builder runs once when the layer is built, and its failure fails the
     * layer. On a singleton it runs once per activation instead, in the
     * activation's scope, so a fiber it forks with `Effect.forkScoped` lives
     * exactly as long as the one cluster-wide activation; its failure fails
     * that activation, not the layer.
     *
     * @example
     * const CounterLive = Counter.toLayer({
     *   Increment: Effect.fn(function* (amount) {
     *     const turn = yield* Counter.Turn
     *     yield* turn.state.set({ count: turn.state.count + amount })
     *     return turn.state.count
     *   }),
     * })
     */
    toLayer,
    /**
     * Implements every query in `api`, directly or from an Effect that builds
     * the handlers. Queries run on the caller's node against committed rows
     * and read their context with `yield* X.Read`.
     */
    toQueryLayer,
    /**
     * Implements every bound job's executor, directly or from an Effect that
     * builds them. Executors run after the turn that enqueued the job commits,
     * read `yield* X.Executor`, and have no database capability; the return
     * value is routed to the binding's `onSuccess`.
     */
    toJobLayer,
    /**
     * A request/reply handle to the actor with `id`, or to the singleton. It
     * never contacts the actor; a call does. An `id` that fails the key schema
     * is a defect, and acquiring a handle inside a turn is a defect.
     */
    get: (descriptor.singleton
      ? () => handleOf(descriptor, "singleton", false)
      : (id: string) => handleOf(descriptor, id, false)) as K extends SingletonKey
      ? () => Effect.Effect<PublicHandle, never, Actors>
      : (id: Id) => Effect.Effect<PublicHandle, never, Actors>,
    /**
     * Mints a new UUIDv7 id and returns its handle. Only an unkeyed actor that
     * is not parent-placed has `create`; calling it inside a turn is a defect.
     */
    create: (() => createOf(descriptor)) as K extends undefined
      ? PlacementKind<Pl> extends "parent"
        ? never
        : () => Effect.Effect<PublicHandle, never, Actors>
      : never,
    /**
     * Builds a parent-placed actor's full id from its parent's id and its own
     * key, as `c1.<byte length of parent>.<parent>.<local>`.
     */
    idOf: idOf as PlacementKind<Pl> extends "parent" ? typeof idOf : never,
    /**
     * Durable intents to this actor; only command turns provide `InTurn`. The
     * id is a plain string so `X.intents(turn.id)` works for every key kind;
     * an id that fails the key schema is a deterministic defect. The target
     * shares the sending turn's tenant. A keyless workflow start is keyed by the
     * turn's command id and its order among the turn's starts, so a retried
     * turn restages the same executions.
     *
     * @example
     * const later = yield* Counter.intents(turn.id)
     * yield* later.Increment(1).pipe(Intent.after("1 minute"))
     */
    intents: (descriptor.singleton
      ? () => intentsOf(descriptor, "singleton")
      : (id: string) => intentsOf(descriptor, id)) as K extends SingletonKey
      ? () => Effect.Effect<Intents<Delivered>, never, InTurn>
      : (id: string) => Effect.Effect<Intents<Delivered>, never, InTurn>,
    /**
     * A Promise client of this actor's public members over `Actors.serve`'s
     * HTTP protocol, for browsers and other code that doesn't run Effect.
     * Workflows are not served; a parent-placed actor is reached by its full
     * id and never created by a client.
     */
    client: (options: ClientOptions) =>
      clientOf<
        ActorClient<Omit<Api, WorkflowKeys<Api>>, ServedKey, Id, StateOf<Fields>, F[number]>
      >(descriptor.served)(options),
  }

  publish(actor, descriptor)

  return actor as typeof actor &
    DefinitionWithInternal<Handle<All, Creating, BoundedMailbox>> &
    Placed<PlacementKind<Pl>, K extends SingletonKey ? "singleton" : Id> &
    (K extends undefined ? ([Creating] extends [never] ? unknown : Mintable<Id>) : unknown)
}

/**
 * `Actor.make`'s type. An interface keeps its name in declaration files, so
 * entries reference it instead of expanding `make`'s inferred type.
 */
export interface Make extends MakeFunction {}

type MakeFunction = typeof make

/** `Actor.make` and `Actor.singleton`, which the package entry re-exports on `Actor`. */
export const Definition = { make: make as Make, singleton }

/**
 * `make`'s local `Context.Service` classes inherit members keyed by these
 * unique symbols, and a declaration file can name a unique symbol only
 * through a module that exports it.
 */
export type { NodeInspectSymbol, Unify }
