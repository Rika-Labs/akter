import type { Unify } from "effect"
import type { NodeInspectSymbol } from "effect/Inspectable"
import type { WorkflowEngine } from "effect/unstable/workflow"
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import {
  type CommandContext,
  type EventEntry,
  InsideTurn,
  type ProgressEntry,
  InStream,
  type Mintable,
  outsideTurn,
  type QueryContext,
} from "../contexts/command.ts"
import type { ExecutorContext, PerformContext, PerformOptions } from "../contexts/effect.ts"
import type {
  BroadcastContext,
  BroadcastOptions,
  ConnectionContext,
  ConnectionInfo,
  FrameOf,
} from "../contexts/connection.ts"
import type { AnyConnection } from "../members/connection.ts"
import type { AnyStream } from "../members/stream.ts"
import type { ReadSet } from "../runtime/connections/reads.ts"
import { ActorError, InvalidInput, SessionEnded } from "../errors/actor.ts"
import { CallPhase, CurrentCallPhase, type WorkflowContext } from "../contexts/workflow.ts"
import { InvalidExecutionId, InvalidExecutionKey } from "../errors/workflow.ts"
import { Actors } from "../handles/actors.ts"
import {
  type BusinessResult,
  type EffectRoute,
  type Broadcast,
  type ConnectionLister,
  type ConnectionResult,
  type RegisteredCommand,
  type RegisteredConnection,
  ConnectionPhase,
  type RegisteredEffect,
  type RegisteredQuery,
  type RegisteredSubscription,
  type RegisteredStream,
  type EventReader,
  type StoredEvent,
  type StreamInput,
  type RegisteredWorkflow,
  type WorkflowStatus,
  type EmittedEvent,
} from "../runtime/members.ts"
import { InternalActors } from "../runtime/actors.ts"
import { Outcome, Request } from "../runtime/request.ts"
import {
  currentStaging,
  Due,
  effectKey,
  emptyOutbox,
  InTurn,
  openOutbox,
  stageIntent,
} from "../handles/intents.ts"

import { ActorRef, Caller, CurrentCaller, Tenant, principal, System } from "../identity/caller.ts"
import type { Access } from "../policies/access.ts"
import { CurrentCommandId } from "../identity/command.ts"
import { CurrentConnectionCommands, connectionCommandId } from "../identity/connection.ts"
import { checkExecutionKey, decodeExecutionId, encodeExecutionId } from "../identity/execution.ts"
import { type AnyWorkflow, isWorkflow } from "../members/workflow.ts"
import { exitCodec } from "../runtime/workflows/steps.ts"
import {
  ExecutionIdOutput,
  INTERRUPT,
  START,
  StartPayload,
  ExecutionTarget,
} from "../handles/workflow.ts"
import { workflowRun, type WorkflowRun } from "../handles/run.ts"
import { isMintedId } from "../identity/mint.ts"
import { childId, parseChildId } from "../identity/child.ts"
import type { Placement } from "../runtime/storage/codec.ts"
import { type AnyBlob, isBlob, isContent } from "../members/blob.ts"
import { DEFAULT_REPLAY_LIMIT, type EventClass, MAX_REPLAY_LIMIT } from "../members/event.ts"
import {
  definitionPayloads,
  type PayloadDeclaration,
  payloadChain,
  payloadCodec,
} from "../members/payload.ts"
import { isCursor } from "../runtime/events/replay.ts"
import { SubscriptionFailure } from "../errors/subscription.ts"
import type {
  AnyCommand,
  AnyMember,
  CommandRecord,
  DeclaredError,
  MemberKind,
  MemberRecord,
  ValueSchema,
} from "../members/command.ts"
import type { AnyReducer } from "../members/reducer.ts"
import type {
  AnySubscription,
  SourceDefinition,
  SubscribeContext,
  SubscribeFrom,
} from "../members/subscription.ts"
import {
  type AnyEffect,
  CancelledOutcome,
  type EffectPolicy,
  type ProgressEffect,
  type ProgressOf,
} from "../members/effect.ts"
import type { NoDatabase } from "../runtime/effects/isolation.ts"
import { MAX_PROGRESS_BYTES } from "../runtime/effects/progress.ts"
import { type Policy, resolvePolicy } from "../policies/command.ts"
import { resolveCron } from "../runtime/cron/schedule.ts"
import { type AnyOwnedTable, ownership, recordDeclaredTables } from "../tables/owned.ts"
import { type ActorClient, type ClientOptions, clientOf } from "../client/make.ts"
import {
  checkDeclaredErrors,
  type ServedDefinition,
  servedConnection,
  servedDefinitions,
  servedMember,
} from "./served.ts"
import {
  type ActorState,
  ActorStates,
  type StateMigration,
  VERSION_KEY,
} from "../state/migration.ts"

type StateFields = Readonly<Record<string, ValueSchema>>

const decodeStoredVersion = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
)

const utf8 = new TextEncoder()

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const decodeCloseReason = Schema.decodeUnknownEffect(SessionEnded.fields.cause)

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const decodeJsonObject = Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))

const valueCodec = (schema: ValueSchema): Schema.Codec<{ readonly value: unknown }, string> =>
  Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: schema })))

/**
 * A member's payload, result, and declared-error codecs. Codecs here and at
 * module level are built once, because building one per call recompiles its
 * schema, which costs more than the value it encodes.
 */
const memberCodecs = (member: AnyMember) => {
  const input = valueCodec(member.input)
  const output = valueCodec(member.output)
  const errorSchema = Schema.Union(member.errors)

  const error: Schema.Codec<DeclaredError["Type"], string> = Schema.fromJsonString(
    Schema.toCodecJson(errorSchema),
  )

  return {
    encodeInput: Schema.encodeEffect(input),
    decodeInput: Schema.decodeEffect(input),
    encodeOutput: Schema.encodeEffect(output),
    decodeOutput: Schema.decodeEffect(output),
    isError: Schema.is(errorSchema),
    encodeError: Schema.encodeEffect(error),
    decodeError: Schema.decodeEffect(error),
  }
}

type MemberCodecs = ReturnType<typeof memberCodecs>

const upcastStep = (step: StateMigration, stored: Schema.Json) =>
  Schema.decodeEffect(Schema.toCodecJson(Schema.Struct(step.from)))(stored).pipe(
    Effect.flatMap((previous) =>
      Schema.encodeUnknownEffect(Schema.toCodecJson(Schema.Struct(step.to)))(step.upcast(previous)),
    ),
    Effect.orDie,
  )

type StateOf<Fields extends StateFields> = Schema.Struct<Fields>["Type"]

const SingletonKeySchema = Schema.TaggedStruct("Singleton", {})

/** Marker for a singleton actor's `key`: one instance per tenant, resolved with `X.get()`. */
const singleton = SingletonKeySchema.make({})

/** The type of `Actor.singleton`, the `key` of a singleton actor. */
type SingletonKey = typeof singleton

type KeySchema = Schema.Codec<string, string>

type Key = KeySchema | SingletonKey | undefined

/**
 * Actors a turn may mint, with the command that alone creates each and, for
 * a parent-placed actor, the parent type whose turns alone mint it.
 */
const mintables = new WeakMap<
  object,
  { readonly name: string; readonly createdBy: string; readonly parent: string | undefined }
>()

/** How many levels below its actor-placed root a parent-placed actor may sit. */
const MAX_PLACEMENT_DEPTH = 4

/** What a parent-placed child needs of each definition it may be placed on. */
const placedDefinitions = new WeakMap<
  object,
  {
    readonly name: string
    readonly placement: Placement
    /** Levels below the actor-placed root; a root is 0. */
    readonly depth: number
    readonly isId: (id: string) => boolean
  }
>()

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

/** What a subscriber needs of each definition it may subscribe to. */
const sources = new WeakMap<
  SourceDefinition,
  {
    readonly singleton: boolean
    readonly subscribers: ReadonlyArray<string> | undefined
    readonly decodeId: (id: string) => Effect.Effect<string, Schema.SchemaError>
  }
>()

const isUUIDv7 = Schema.is(Schema.String.check(Schema.isUUID(7)))

/** Type-only key of `DefinitionWithInternal`; no value exists at runtime. */
export declare const InternalHandleType: unique symbol

/**
 * Type-level record of a definition's internal handle, which reaches `internal`
 * commands as well as `api` members; `ActorTest` reads it to type its calls.
 */
export interface DefinitionWithInternal<H> {
  readonly [InternalHandleType]?: H
}

/** Runtime access to a definition's internal handle, for test harnesses. */
export interface InternalDefinition<H extends { readonly ref: ActorRef }> {
  /**
   * A handle to actor `id` of `tenant` that calls as `caller` and reaches
   * `internal` commands; an `id` that fails the key schema is a defect.
   */
  readonly handle: (
    id: string,
    tenant: string,
    caller: typeof System.Type,
  ) => Effect.Effect<H, never, Actors | InternalActors>
}

interface InternalDefinitionOwner {
  readonly get: unknown
}

/** Each `Actor.make` definition's internal handle, keyed by the definition. */
export const internalDefinitions = new WeakMap<
  InternalDefinitionOwner,
  InternalDefinition<{ readonly ref: ActorRef }>
>()

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
  readonly open: (params: C["input"]["Type"]) => Effect.Effect<void, C["errors"][number]["Type"], R>
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
 * command has created and `Timeout` for a rerun past `commandTimeout`. A
 * rerun that reads something no commit signal covers is a defect of the
 * handler here; a served watch reports it as `not_watchable`.
 */
type WatchReason = StreamReason | "NotCreated" | "Timeout"

/**
 * The `watch` method of a query declared `watch: true`: its current result
 * first, then the newest result after each commit that wrote something its
 * last run read. It is a state, not a history: intermediate results are
 * skipped and an unchanged result is not repeated.
 */
type WatchMethod<M extends AnyMember> = M extends { readonly watch: true }
  ? {
      readonly watch: (
        ...args: M["input"]["Type"] extends void ? [] : [input: M["input"]["Type"]]
      ) => Stream.Stream<
        M["output"]["Type"],
        M["errors"][number]["Type"] | ActorError.Of<WatchReason>
      >
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
    ...args: Members[K]["input"]["Type"] extends void ? [] : [input: Members[K]["input"]["Type"]]
  ) => Effect.Effect<void, never, InTurn>
} & {
  /** Stages a workflow start and returns its execution id. */
  readonly [K in WorkflowKeys<Members>]: (
    ...args: Members[K]["input"]["Type"] extends void ? [] : [input: Members[K]["input"]["Type"]]
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
    ...args: Members[K]["input"]["Type"] extends void ? [] : [input: Members[K]["input"]["Type"]]
  ) => Members[K] extends AnyWorkflow
    ? Effect.Effect<
        WorkflowRun<Members[K]>,
        InvalidExecutionKey | ActorError.Of<Reasons<Members[K], Creating, BoundedMailbox>>
      >
    : Effect.Effect<
        Members[K]["output"]["Type"],
        | Members[K]["errors"][number]["Type"]
        | ActorError.Of<Reasons<Members[K], Creating, BoundedMailbox>>
      >) &
    WatchMethod<Members[K]>
} & {
  /** Subscribes to a live feed on the actor's activation; it ends with that activation. */
  readonly [K in StreamKeys<Members>]: (
    ...args: Members[K]["input"]["Type"] extends void ? [] : [input: Members[K]["input"]["Type"]]
  ) => Stream.Stream<
    Members[K]["output"]["Type"],
    Members[K]["errors"][number]["Type"] | ActorError.Of<StreamReason>
  >
} & { readonly ref: ActorRef }

type HandlerMap<Members extends MemberRecord, Keys extends keyof Members, R> = {
  readonly [K in Keys]: (
    input: Members[K]["input"]["Type"],
  ) => Effect.Effect<Members[K]["output"]["Type"], Members[K]["errors"][number]["Type"], R>
}

/**
 * Makes a command layer whose handlers need `Actors` unassignable: a handle
 * acquired inside a turn could only make a request/reply call, which dies.
 */
type NoRequestReply<R> = [Extract<R, Actors>] extends [never]
  ? unknown
  : { readonly "Request/reply inside a turn: use X.intents(id)": never }

/** A stream member's entry in `X.toLayer`: its live feed for one subscriber. */
export type StreamHandler<S extends AnyStream, R> = (
  input: S["input"]["Type"],
) => Stream.Stream<S["output"]["Type"], S["errors"][number]["Type"], R>

/**
 * `X.toLayer`'s handlers: one per command in `api` and `internal`, one entry
 * per connection and stream; a reducer has no handler.
 */
type Handlers<Members extends MemberRecord, R, RC = R, RS = R> = HandlerMap<
  Members,
  CommandKeys<Members>,
  R
> & {
  readonly [K in ReducerKeys<Members>]?: never
} & {
  readonly [K in ConnectionKeys<Members>]: ConnectionHandlers<Members[K] & AnyConnection, RC>
} & {
  readonly [K in StreamKeys<Members>]: StreamHandler<Members[K] & AnyStream, RS>
}

/**
 * One body per workflow in `api`. Bodies run outside turns and may use
 * request/reply handles, but only inside a step's `execute`. Calls from a step
 * carry the execution's recorded caller and skip the external access and
 * command-id expiry checks, as relay deliveries do, so accepted work continues
 * after the principal that started it loses access.
 */
export type WorkflowHandlers<Members extends MemberRecord, R> = HandlerMap<
  Members,
  WorkflowKeys<Members>,
  R
>

/**
 * One handler per query in `api`. A query declared `watch: true` may require
 * only `W`, the actor's `X.Read`, so a handler the runtime cannot record does
 * not compile.
 */
type QueryHandlers<Members extends MemberRecord, R, W> = {
  readonly [K in QueryKeys<Members>]: (
    input: Members[K]["input"]["Type"],
  ) => Effect.Effect<
    Members[K]["output"]["Type"],
    Members[K]["errors"][number]["Type"],
    Members[K] extends { readonly watch: true } ? W : R
  >
}

/**
 * One executor per declared effect, returning the effect's `success` type,
 * which is routed to the effect's `onSuccess` command. An attempt is abandoned
 * after `policy.effects[Tag].timeout` (default 30 seconds) and retried up to
 * `retry.times` more times (default 3).
 *
 * Only a typed failure proves the provider did not apply the call; a defect,
 * a timeout, or an interruption leaves the attempt's outcome unknown. A result
 * `onSuccess` cannot accept is dead-lettered rather than executed again, since
 * the provider already applied it, and a cancelled effect's result goes to
 * `onCancelled`, as an unknown outcome when that route cannot accept it. A
 * stored payload that no longer decodes never reaches the executor and is
 * still dead-lettered, without its route.
 */
export type Executors<Effects extends AnyEffect, R> = {
  readonly [Tag in Effects["tag"]]: (
    effect: Extract<Effects, { readonly tag: Tag }>["Type"],
  ) => Effect.Effect<Extract<Effects, { readonly tag: Tag }>["success"]["Type"], unknown, R>
}

/**
 * Encoded bytes of every event one turn may emit. The turn appends them in
 * one statement inside its transaction, so the budget bounds that statement.
 */
const MAX_EMIT_BYTES = 1_048_576

/** Retries after an effect's first failed attempt when its policy names none. */
const DEFAULT_EFFECT_RETRIES = 3

/** An attempt that runs longer is abandoned and counts as an unknown outcome. */
const EXECUTOR_TIMEOUT_MS = 30_000

const EFFECT_BACKOFF = { baseMs: 1000, maxMs: 256_000 } as const

const PROGRESS_EVERY_MS = { default: 250, min: 50, max: 60_000 } as const

/** Effect timings are timer durations: 1 ms to 2^31 − 1 ms. */
const effectMillis = (
  path: string,
  duration: Duration.Input,
  bounds: { readonly min: number; readonly max: number; readonly label: string } = {
    min: 1,
    max: 2_147_483_647,
    label: "1 millisecond to 2147483647 milliseconds",
  },
) => {
  const millis = Duration.toMillis(Duration.fromInputUnsafe(duration))

  if (!Number.isFinite(millis) || millis < bounds.min || millis > bounds.max)
    throw new Error(`${path} must be a duration from ${bounds.label}`)

  return Math.floor(millis)
}

const effectTiming = (tag: string, policy: EffectPolicy<AnyEffect, AnyCommand> | undefined) => {
  const backoff = policy?.retry?.backoff

  const timing = {
    timeoutMs:
      policy?.timeout === undefined
        ? EXECUTOR_TIMEOUT_MS
        : effectMillis(`policy.effects.${tag}.timeout`, policy.timeout),
    backoff:
      backoff === undefined
        ? EFFECT_BACKOFF
        : {
            baseMs: effectMillis(`policy.effects.${tag}.retry.backoff.base`, backoff.base),
            maxMs: effectMillis(`policy.effects.${tag}.retry.backoff.max`, backoff.max),
          },
    progressEveryMs:
      policy?.progressEvery === undefined
        ? PROGRESS_EVERY_MS.default
        : effectMillis(`policy.effects.${tag}.progressEvery`, policy.progressEvery, {
            min: PROGRESS_EVERY_MS.min,
            max: PROGRESS_EVERY_MS.max,
            label: "50 milliseconds to 1 minute",
          }),
  } satisfies {
    readonly timeoutMs: number
    readonly backoff: RegisteredEffect["backoff"]
    readonly progressEveryMs: number
  }

  if (timing.backoff.maxMs < timing.backoff.baseMs)
    throw new Error(`policy.effects.${tag}.retry.backoff.max must be at least its base`)

  return timing
}

/** When and under which key `turn.perform` stages an effect. */
const performSchedule = (options: PerformOptions | undefined) => {
  if (options?.key !== undefined) effectKey(options.key)

  if (options?.after !== undefined && options.at !== undefined)
    throw new Error("turn.perform takes after or at, not both")

  let due: Due | undefined

  if (options?.after !== undefined) {
    const millis = Duration.toMillis(Duration.fromInputUnsafe(options.after))

    if (!Number.isFinite(millis) || millis < 0)
      throw new Error("turn.perform after needs a finite, non-negative duration")
    due = Due.cases.After.make({ millis: Math.ceil(millis) })
  }

  if (options?.at !== undefined)
    due = Due.cases.At.make({ epochMillis: DateTime.toEpochMillis(options.at) })

  return { due, key: options?.key }
}

/** The `onCancelled` input of a cancelled effect whose provider call succeeded. */
interface CancelledSuccess {
  readonly effectId: string
  readonly attempts: number
  readonly outcome: { readonly _tag: "Succeeded"; readonly value: unknown }
  readonly ambiguous: boolean
}

/** `api` and `internal` keys must equal their member's tag. */
type TagsMatch<Members extends MemberRecord> = {
  readonly [K in keyof Members]: Members[K] & { readonly tag: K }
}

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
  Effects extends ReadonlyArray<AnyEffect>,
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
   * The declared events `Actor.serve` serves as event feeds. None are served
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
  /** Public members, each keyed by its tag. */
  readonly api: Api & TagsMatch<Api> & ReducerStates<Api, NoInfer<Fields>>
  /**
   * Commands that `X.get` handles and `Actor.serve` never expose, reached by
   * intents, cron, effect routes, and subscriptions; each keyed by its tag.
   */
  readonly internal?: Internal & TagsMatch<Internal>
  /** `Actor.effect` classes this actor's turns may `perform`. */
  readonly effects?: Effects
  /** Limits, retention, creation, cron, subscriber, and per-effect settings. */
  readonly policy?: Policy<CommandsOf<Api> | Values<Internal>, Effects[number]>
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

const encodeTarget = Schema.encodeEffect(ExecutionTarget)

/** Whether `member` is a query declared `watch: true`. */
const isWatchable = (member: AnyMember) => "watch" in member && member.watch === true

const encodeStartPayload = Schema.encodeEffect(StartPayload)

/** Workflow starts staged so far in each turn's staging, numbering keyless starts. */
const startCounts = new WeakMap<object, number>()

/**
 * Validates a definition, throwing on any invalid declaration, and returns the
 * actor type's handles, layers, and client. Invariants its turns, queries, and
 * streams keep:
 *
 * - Stored state rows are upcast through the migration chain when read. An
 *   actor with no rows starts at the current version, and a turn that upcast
 *   rewrites every key at the current version; otherwise only changed keys are
 *   written.
 * - A turn's or query's capabilities die once its handler returns and when
 *   used from a fiber other than the one that runs the handler, because its
 *   one connection takes no concurrent statements. Forked fibers inherit
 *   `InsideTurn`, so the owning fiber is compared as well, and a turn records
 *   that misuse so a swallowed defect still fails it.
 * - Queries and streams run with their own `InsideTurn` marker, so a command or
 *   query call from their handlers is a defect instead of a write.
 * - A reducer's `reduce` receives its own decoded copy of state, so mutating it
 *   in place cannot hide a change, and its result round-trips through the state
 *   schema to validate it. A commutative reducer declares no errors, so a merged
 *   turn fails only by defect.
 * - A turn's services are provided as one merged context: each nested provide
 *   copies the whole fiber context.
 * - Workflow bodies receive the layer's context without its `Scope`: a body's
 *   scope is its run's.
 * - A subscriber registers its sources' event chains beside its own, because it
 *   reads their events. The relay upcasts an event before routing it, so a
 *   route decodes the current version.
 * - A connection frame that is an event entry carries its cursor, which the
 *   client deduplicates on.
 * - Handles never deliver subscriptions, so an acknowledged outcome on a handle
 *   is a defect.
 * - `toLayer`'s requirement parameters default to `never`, so an actor with no
 *   handler to infer them from, such as one of reducers only, needs nothing.
 */
const make = <
  const Name extends string,
  const Api extends MemberRecord,
  const Fields extends StateFields = {},
  const Internal extends CommandRecord = {},
  const K extends Key = undefined,
  const Events extends ReadonlyArray<EventClass> = readonly [],
  const T extends ReadonlyArray<AnyOwnedTable> = [],
  const Effects extends ReadonlyArray<AnyEffect> = readonly [],
  const P extends Policy<CommandsOf<Api> | Values<Internal>, Effects[number]> = {},
  const B extends ReadonlyArray<AnyBlob> = [],
  const F extends ReadonlyArray<Events[number]> = readonly [],
  const Subs extends ReadonlyArray<AnySubscription> = readonly [],
  const Pl extends PlacementOption = "tenant",
>(
  name: Name,
  definition: Definition<K, Fields, Api, Internal, Events, T, Effects, B, Subs, Pl> & {
    readonly key?: K
    readonly policy?: P
    readonly feeds?: F
  },
) => {
  Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]{0,79}$/)).make(name)
  const api: MemberRecord = definition.api
  const internal: MemberRecord = definition.internal ?? {}
  const tags = new Set<string>()

  for (const [key, member] of [...Object.entries(api), ...Object.entries(internal)]) {
    if (key !== member.tag) throw new Error(`Command key ${key} must equal its tag ${member.tag}`)

    if (
      tags.has(member.tag) ||
      member.tag === "ref" ||
      member.tag === "state" ||
      member.tag.startsWith("$")
    )
      throw new Error(`Duplicate or reserved command: ${member.tag}`)
    tags.add(member.tag)
  }

  for (const member of Object.values(internal))
    if (member.kind !== "command")
      throw new Error(`Internal members must be commands: ${member.tag}`)

  const all = [...Object.values(api), ...Object.values(internal)]
  const members = all.filter((member): member is AnyCommand => member.kind === "command")
  const queries = all.filter((member) => member.kind === "query")
  const watches = new Set(queries.flatMap((member) => (isWatchable(member) ? [member.tag] : [])))

  const connectionMembers = all.filter(
    (member): member is AnyConnection => member.kind === "connection",
  )

  const streamMembers = all.filter((member): member is AnyStream => member.kind === "stream")

  const connectionCodecs = new Map(
    connectionMembers.map((member) => {
      const server = valueCodec(member.server)
      const client = valueCodec(member.client)
      const session = member.session === undefined ? undefined : valueCodec(member.session)

      return [
        member.tag,
        {
          encodeServer: Schema.encodeEffect(server),
          decodeClient: Schema.decodeEffect(client),
          encodeSession: session === undefined ? undefined : Schema.encodeEffect(session),
          decodeSession: session === undefined ? undefined : Schema.decodeEffect(session),
        },
      ] as const
    }),
  )

  const reducers = all.filter((member): member is AnyReducer => member.kind === "reducer")
  const workflows = all.filter(isWorkflow)

  for (const member of Object.values(internal))
    if (isWorkflow(member)) throw new Error(`Workflow ${member.tag} must be in api`)
  const internalMembers = new Set<AnyMember>(Object.values(internal))
  const fields: StateFields = definition.state?.fields ?? {}
  const policy = resolvePolicy({ declared: definition.policy, commands: members })
  const cron = resolveCron({ declared: definition.policy?.cron, commands: members })
  const isSingleton = Schema.is(SingletonKeySchema)(definition.key)
  const effects = new Map<string, AnyEffect>()

  for (const declared of definition.effects ?? []) {
    if (effects.has(declared.tag)) throw new Error(`Duplicate effect: ${declared.tag}`)
    effects.set(declared.tag, declared)
  }

  const effectCodecs = new Map(
    [...effects.values()].map(
      (declared) => [declared.tag, payloadCodec({ schema: declared, tag: declared.tag })] as const,
    ),
  )

  const progressEffects = new Set<string>()

  for (const member of [...connectionMembers, ...streamMembers])
    for (const declared of member.progress?.effects ?? []) {
      if (effects.get(declared.tag) !== declared || declared.progress === undefined)
        throw new Error(
          `${member.tag} lists progress of ${declared.tag}, which is not a declared effect with a progress schema`,
        )
      progressEffects.add(declared.tag)
    }

  const effectPolicies: Readonly<Record<string, EffectPolicy<AnyEffect, AnyCommand> | undefined>> =
    definition.policy?.effects ?? {}

  const effectTimings = new Map<string, ReturnType<typeof effectTiming>>()

  const unrouted = new Set<string>()

  const warnUnrouted = (tag: string) =>
    Effect.suspend(() => {
      const routes = effectPolicies[tag]

      if (
        unrouted.has(tag) ||
        routes?.onCancelled !== undefined ||
        routes?.onDeadLetter !== undefined
      )
        return Effect.void
      unrouted.add(tag)

      return Effect.logWarning(
        `Keyed effect ${tag} has neither onCancelled nor onDeadLetter; an ambiguous cancellation is only dead-lettered`,
      )
    })

  for (const [tag, effectPolicy] of Object.entries(effectPolicies)) {
    if (!effects.has(tag)) throw new Error(`policy.effects.${tag} names no declared effect`)

    for (const route of [
      effectPolicy?.onSuccess,
      effectPolicy?.onDeadLetter,
      effectPolicy?.onCancelled,
    ])
      if (route !== undefined && !members.includes(route))
        throw new Error(`policy.effects.${tag} routes must name a command of this actor`)

    const perActor = effectPolicy?.concurrency?.perActor

    if (
      effectPolicy?.concurrency !== undefined &&
      (perActor === undefined || !Number.isInteger(perActor) || perActor < 1 || perActor > 64)
    )
      throw new Error(`policy.effects.${tag}.concurrency.perActor must be an integer from 1 to 64`)

    const times = effectPolicy?.retry?.times

    if (times !== undefined && (!Number.isInteger(times) || times < 0 || times > 100))
      throw new Error(`policy.effects.${tag}.retry.times must be an integer from 0 to 100`)

    effectTimings.set(tag, effectTiming(tag, effectPolicy))
  }

  if ("set" in fields) throw new Error("State key 'set' is reserved")

  for (const reducer of reducers)
    if (reducer.state !== definition.state)
      throw new Error(`Reducer ${reducer.tag} must declare its actor's state`)

  const tables: ReadonlyArray<AnyOwnedTable> = definition.tables ?? []
  const declaredPlacement: PlacementOption = definition.placement ?? "tenant"

  const parented =
    declaredPlacement === "tenant" || declaredPlacement === "actor" ? undefined : declaredPlacement

  const parent = parented === undefined ? undefined : placedDefinitions.get(parented.parent)

  if (parented !== undefined) {
    if (!Predicate.hasProperty(parented, "parent"))
      throw new Error(`placement is "tenant", "actor", or { parent }`)

    if (parent === undefined) throw new Error("placement.parent takes an Actor.make definition")

    if (parent.placement === "tenant")
      throw new Error(
        `${name}'s parent ${parent.name} is tenant-placed, so its children already share its shard; place ${name} by "tenant"`,
      )

    if (parent.depth + 1 > MAX_PLACEMENT_DEPTH)
      throw new Error(
        `${name} would be ${parent.depth + 1} levels below its root; parent placement allows ${MAX_PLACEMENT_DEPTH}`,
      )

    if (isSingleton) throw new Error(`Singleton ${name} cannot be parent-placed`)

    if (definition.key === undefined && policy.createdBy === undefined)
      throw new Error(`Parent-placed ${name} needs a key or policy.createdBy`)
  }

  const placement: Placement =
    declaredPlacement === "tenant" || declaredPlacement === "actor"
      ? declaredPlacement
      : { parent: parent!.name, placement: parent!.placement }

  for (const table of tables) {
    const info = ownership(table)

    if (info === undefined) throw new Error("tables takes Actor.table values")

    if (tables.indexOf(table) !== tables.lastIndexOf(table))
      throw new Error(`Table ${info.name} is listed twice`)

    if (info.owner !== undefined && info.owner !== name)
      throw new Error(`Table ${info.name} is already owned by actor ${info.owner}`)

    if (info.adopted && policy.createdBy !== undefined)
      throw new Error(
        `Actor ${name} mints its ids and cannot adopt table ${info.name}: legacy rows carry ids it never minted`,
      )
  }

  const events = new Map<string, EventClass>()

  for (const event of definition.events ?? []) {
    if (events.has(event.identifier)) throw new Error(`Duplicate event: ${event.identifier}`)
    events.set(event.identifier, event)
  }

  const feeds = new Set<string>()

  for (const event of definition.feeds ?? []) {
    if (events.get(event.identifier) !== event)
      throw new Error(`Feed ${event.identifier} is not one of ${name}'s events`)
    feeds.add(event.identifier)
  }

  const eventCodecs = new Map(
    [...events.values()].map(
      (event) => [event, payloadCodec({ schema: event, tag: event.identifier })] as const,
    ),
  )

  const eventCodecsByTag = new Map(
    [...eventCodecs].map(([event, codec]) => [event.identifier, codec] as const),
  )

  const upcastEvent = (tag: string, version: number, value: string) => {
    const codec = eventCodecsByTag.get(tag)

    return codec === undefined
      ? Effect.die(new Error(`Undeclared event: ${tag}`))
      : codec.upcast(value, version).pipe(Effect.orDie)
  }

  const payloadDeclarations = (writes: boolean): ReadonlyArray<PayloadDeclaration> => [
    ...[...events.values()].map((event) => ({
      actorType: name,
      kind: "event" as const,
      tag: event.identifier,
      chain: payloadChain(event),
      writes,
    })),
    ...[...effects.values()].map((declared) => ({
      actorType: name,
      kind: "effect" as const,
      tag: declared.tag,
      chain: payloadChain(declared),
      writes,
    })),
  ]

  const blobs: ReadonlyArray<AnyBlob> = definition.blobs ?? []
  const blobNames = new Set<string>()

  for (const blob of blobs) {
    if (!isBlob(blob)) throw new Error("blobs takes Actor.blob and Actor.content values")

    if (blobNames.has(blob.name)) throw new Error(`Blob ${blob.name} is listed twice`)
    blobNames.add(blob.name)
  }

  const migrations = definition.state?.migrations ?? []
  ActorStates.validateChain(fields, migrations)
  const version = migrations.length

  const decodeStored = Effect.fnUntraced(function* (
    rows: ReadonlyArray<readonly [string, string]>,
  ) {
    const stored: Record<string, Schema.Json> = {}
    let storedVersion = rows.length === 0 ? version : 0

    for (const [key, value] of rows)
      if (key === VERSION_KEY) storedVersion = yield* decodeStoredVersion(value).pipe(Effect.orDie)
      else stored[key] = yield* decodeJson(value).pipe(Effect.orDie)

    if (storedVersion > version)
      return yield* Effect.die(new Error(`Stored state version ${storedVersion} is unknown`))

    let current: Schema.Json = stored

    for (const step of migrations.slice(storedVersion)) current = yield* upcastStep(step, current)

    return {
      state: yield* decodeStateJson(current).pipe(Effect.orDie),
      upcast: storedVersion < version && rows.length > 0,
    }
  })

  const stateSchema = Schema.Struct(fields)
  const decodeStateJson = Schema.decodeEffect(Schema.toCodecJson(stateSchema))
  const stateCodec = Schema.fromJsonString(Schema.toCodecJson(stateSchema))
  const encodeState = Schema.encodeEffect(stateCodec)
  const decodeState = Schema.decodeEffect(stateCodec)
  const codecs = new Map(all.map((member) => [member.tag, memberCodecs(member)]))
  const decodeCaller = Schema.decodeEffect(Caller)

  const fieldEquivalences = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, Schema.toEquivalence(field)]),
  )

  const key: Key = definition.key

  const mintable = key === undefined && policy.createdBy !== undefined

  const isLocalId = Schema.isSchema(key) ? Schema.is(key) : isMintedId

  const idSchema: KeySchema =
    parent !== undefined
      ? Schema.String.check(
          Schema.makeFilter(
            (id: string) => {
              const parts = parseChildId(id)

              return parts !== undefined && parent.isId(parts.parent) && isLocalId(parts.local)
            },
            { expected: `c1.<byte length>.<${parent.name} id>.<${name} local id>` },
          ),
        ).pipe(Schema.brand(name))
      : Schema.isSchema(key)
        ? key
        : key === undefined
          ? Schema.String.check(
              Schema.makeFilter((id: string) => isUUIDv7(id) || isMintedId(id), {
                expected: "a UUID v7 or a minted UUID v8",
              }),
            ).pipe(Schema.brand(name))
          : Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand(name))

  const decodeId = Schema.decodeEffect(idSchema)

  const encodeId = Schema.encodeEffect(idSchema)

  const subscriptions: ReadonlyArray<AnySubscription> = definition.subscriptions ?? []
  const subscriptionTags = new Set<string>()
  const handlerTags = new Set<string>()

  for (const declared of subscriptions) {
    if (declared?.kind !== "subscription")
      throw new Error("subscriptions takes Actor.subscription values")

    if (subscriptionTags.has(declared.tag))
      throw new Error(`Duplicate subscription: ${declared.tag}`)
    subscriptionTags.add(declared.tag)

    if (internal[declared.handler.tag] !== declared.handler)
      throw new Error(`Subscription ${declared.tag}'s handler must be a command in internal`)
    handlerTags.add(declared.handler.tag)

    const source = sources.get(declared.source)

    if (source === undefined)
      throw new Error(`Subscription ${declared.tag}'s source must be an Actor.make definition`)

    if (source.subscribers !== undefined && !source.subscribers.includes(name))
      throw new Error(
        `${declared.source.name} policy.subscribers does not allow ${name} (subscription ${declared.tag})`,
      )

    const toSingleton = declared.route !== undefined && !Predicate.isFunction(declared.route)

    if (isSingleton && declared.route !== undefined && !toSingleton)
      throw new Error(`Singleton ${name} routes subscription ${declared.tag} with Actor.singleton`)

    if (!isSingleton && toSingleton)
      throw new Error(
        `Subscription ${declared.tag} routes to Actor.singleton, but ${name} is keyed`,
      )
  }

  const registeredSubscriptions: ReadonlyArray<RegisteredSubscription> = subscriptions.map(
    (declared) => {
      const decoders = new Map(
        declared.events.map(
          (event) =>
            [event.identifier, payloadCodec({ schema: event, tag: event.identifier })] as const,
        ),
      )

      const route = declared.route

      return {
        tag: declared.tag,
        sourceType: declared.source.name,
        handler: declared.handler.tag,
        events: declared.events.map((event) => event.identifier),
        retired: declared.retired,
        routed: route === undefined ? undefined : Predicate.isFunction(route) ? "id" : "singleton",
        upcast: (tag, version, value) =>
          Effect.gen(function* () {
            const codec = decoders.get(tag)

            if (codec === undefined)
              return yield* SubscriptionFailure.make({
                message: `Subscription ${declared.tag} names no ${tag}`,
              })

            return yield* codec.upcast(value, version)
          }).pipe(
            Effect.catchTag("PayloadError", (error) =>
              Effect.fail(SubscriptionFailure.make({ message: error.message })),
            ),
          ),
        route: (tag, value, source) =>
          Effect.gen(function* () {
            if (!Predicate.isFunction(route)) return "singleton"

            const codec = decoders.get(tag)

            if (codec === undefined)
              return yield* SubscriptionFailure.make({
                message: `Subscription ${declared.tag} names no ${tag}`,
              })

            const event = yield* codec.decode(value, codec.chain.current)

            const id = yield* Effect.try({
              try: () => route(event, source),
              catch: (cause) => SubscriptionFailure.make({ message: String(cause) }),
            })

            return yield* decodeId(id)
          }).pipe(
            Effect.catchTags({
              SchemaError: (error) =>
                Effect.fail(SubscriptionFailure.make({ message: error.message })),
              PayloadError: (error) =>
                Effect.fail(SubscriptionFailure.make({ message: error.message })),
            }),
          ),
      }
    },
  )

  type Creating = P extends { readonly createdBy: infer C extends AnyCommand } ? C["tag"] : never

  type BoundedMailbox = P extends { readonly mailboxCapacity: number } ? true : false

  type PublicHandle = Handle<Api, Creating, BoundedMailbox>

  type All = Api & Internal

  type State = StateOf<Fields>

  type Event = Events[number]

  type Owned = T[number]

  type Blobs = B[number]

  class Turn extends Context.Service<
    Turn,
    CommandContext<State, Event, Owned, Blobs> &
      PerformContext<Effects[number]> &
      BroadcastContext<ConnectionsOf<Api>> &
      SubscribeContext<Subs[number]>
  >()(`durable-actors/Turn/${name}`) {}

  class Executor extends Context.Service<Executor, ExecutorContext<Effects[number]>>()(
    `durable-actors/Executor/${name}`,
  ) {}

  class Workflow extends Context.Service<Workflow, WorkflowContext>()(
    `durable-actors/Workflow/${name}`,
  ) {}

  const workflowExits = new Map(
    workflows.map((member) => [
      member.tag,
      exitCodec({ success: member.output, errors: member.errors }),
    ]),
  )

  const runOf = (
    member: AnyWorkflow,
    ref: ActorRef,
    caller: Caller,
    executionId: string,
    execute: (request: Request) => Effect.Effect<Outcome, ActorError>,
    poll: (request: Request) => Effect.Effect<WorkflowStatus | undefined, ActorError>,
    mint: Effect.Effect<string, ActorError>,
  ) =>
    workflowRun({
      executionId,
      poll: poll(
        Request.make({ ref, caller, command: member.tag, commandId: "", payload: executionId }),
      ),
      interrupt: Effect.gen(function* () {
        const commandId = (yield* CurrentCommandId) ?? (yield* mint)

        const outcome = yield* execute(
          Request.make({
            ref,
            caller,
            command: INTERRUPT,
            commandId,
            payload: yield* encodeTarget({ executionId }).pipe(Effect.orDie),
          }),
        )

        if (Outcome.guards.Defect(outcome)) return yield* Effect.die(outcome.cause)
      }),
      decode: workflowExits.get(member.tag)!.decode,
    })

  class Read extends Context.Service<
    Read,
    QueryContext<State, Event, Owned, Blobs, Effects[number]>
  >()(`durable-actors/Read/${name}`) {}

  const progressCodecs = new Map(
    [...progressEffects].map((tag) => {
      const declared = effects.get(tag)!

      return [
        tag,
        {
          effect: Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(declared))),
          frame: Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(declared.progress!))),
        },
      ] as const
    }),
  )

  const entryOf = <E extends Event>(event: E, stored: StoredEvent) =>
    Effect.map(
      eventCodecs.get(event)!.decode(stored.value, stored.version).pipe(Effect.orDie),
      (decoded): EventEntry<E["Type"]> => ({
        cursor: stored.cursor,
        event: decoded as E["Type"],
        commandId: stored.commandId,
        timestamp: DateTime.makeUnsafe(stored.timestampMs),
      }),
    )

  const replayWith = (readEvents: EventReader) =>
    Effect.fnUntraced(function* <E extends Event>(
      event: E,
      options?: {
        readonly after?: string | undefined
        readonly limit?: number | undefined
      },
    ) {
      if (events.get(event.identifier) !== event)
        return yield* Effect.die(new Error(`Undeclared event: ${event.identifier}`))

      const limit = options?.limit ?? DEFAULT_REPLAY_LIMIT

      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT)
        return yield* Effect.die(
          new Error(`read.events limit must be an integer from 1 to ${MAX_REPLAY_LIMIT}`),
        )

      return yield* Effect.forEach(
        yield* readEvents(event.identifier, options?.after, limit),
        (stored) => entryOf(event, stored),
      )
    })

  type Connections = ConnectionsOf<Api>

  class Connection extends Context.Service<
    Connection,
    ConnectionContext<
      State,
      Event,
      Connections["server"]["Type"],
      Exclude<Connections["session"], undefined>["Type"]
    >
  >()(`durable-actors/Connection/${name}`) {}

  const getHandle = Effect.fnUntraced(function* (
    id: string,
    includeInternal: boolean,
    as?: Caller,
    tenant?: string,
  ): Effect.fn.Return<Handle<All, Creating, BoundedMailbox>, never, Actors | InternalActors> {
    yield* outsideTurn
    const actors = yield* Actors
    const internalActors = yield* InternalActors

    const caller = yield* decodeCaller(as ?? (yield* CurrentCaller)).pipe(Effect.orDie)

    const ref = ActorRef.make({
      actor: name,
      tenant: tenant ?? (yield* Tenant),
      id: isSingleton ? "singleton" : yield* decodeId(id).pipe(Effect.orDie),
    })

    const callable = Effect.gen(function* () {
      if (CallPhase.$is("Body")(yield* CurrentCallPhase))
        return yield* Effect.die(new Error("Actor call in a workflow body outside a step"))
    })

    const send = (request: Request) =>
      Effect.gen(function* () {
        if (CallPhase.$is("Activity")(yield* CurrentCallPhase))
          return yield* internalActors.deliver(request)

        return (yield* internalActors.execute(request)).outcome
      })

    const callId = (command: string) =>
      Effect.gen(function* () {
        const phase = yield* CurrentCallPhase

        if (CallPhase.$is("Activity")(phase)) return yield* phase.nextCommandId

        const explicit = yield* CurrentCommandId

        if (explicit !== undefined) return explicit
        const connectionCommands = yield* CurrentConnectionCommands

        return connectionCommands === undefined
          ? yield* actors.mintCommandId
          : yield* connectionCommands(`${ref.tenant}\u0000${ref.actor}\u0000${ref.id}`, command)
      })

    const callIdOnce = (command: string) => {
      const lock = Semaphore.makeUnsafe(1)
      let identity: string | undefined

      return lock.withPermit(
        Effect.gen(function* () {
          if (identity === undefined) identity = yield* callId(command)

          return identity
        }),
      )
    }

    const methods = Object.fromEntries(
      (includeInternal ? all : Object.values(api))
        .filter((member) => member.kind !== "connection")
        .map((member) => {
          const { encodeInput, decodeOutput, decodeError } = codecs.get(member.tag)!

          const decoded = <A>(
            elements: Stream.Stream<A, ActorError | { readonly failure: string }>,
            encoded: (element: A) => string,
          ) =>
            elements.pipe(
              Stream.mapEffect((element) =>
                Effect.map(decodeOutput(encoded(element)).pipe(Effect.orDie), (out) => out.value),
              ),
              Stream.catch((error) =>
                Schema.is(ActorError)(error)
                  ? Stream.fail(error)
                  : Stream.fromEffect(
                      Effect.flatMap(decodeError(error.failure).pipe(Effect.orDie), Effect.fail),
                    ),
              ),
            )

          if (member.kind === "stream")
            return [
              member.tag,
              (input: typeof member.input.Type) =>
                Stream.unwrap(
                  Effect.gen(function* () {
                    yield* outsideTurn
                    const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)

                    return decoded(
                      internalActors.subscribe(
                        Request.make({ ref, caller, command: member.tag, commandId: "", payload }),
                      ),
                      (value) => value,
                    )
                  }),
                ),
            ]

          if (isWorkflow(member))
            return [
              member.tag,
              (input: typeof member.input.Type) => {
                const identify = callIdOnce(member.tag)

                return Effect.gen(function* () {
                  yield* outsideTurn
                  yield* callable

                  if (member.key !== undefined) yield* checkExecutionKey(member.key(input))
                  const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)

                  const outcome = yield* send(
                    Request.make({
                      ref,
                      caller,
                      command: member.tag,
                      commandId: yield* identify,
                      payload,
                    }),
                  )

                  if (!Outcome.guards.Success(outcome))
                    return yield* Effect.die(
                      Outcome.guards.Defect(outcome)
                        ? outcome.cause
                        : new Error("Workflow start failed"),
                    )

                  const { value: executionId } = yield* Schema.decodeEffect(ExecutionIdOutput)(
                    outcome.value,
                  ).pipe(Effect.orDie)

                  return runOf(
                    member,
                    ref,
                    caller,
                    executionId,
                    (request) =>
                      Effect.map(internalActors.execute(request), (executed) => executed.outcome),
                    internalActors.pollWorkflow,
                    actors.mintCommandId,
                  )
                })
              },
            ]

          const call = (input: typeof member.input.Type) => {
            const identify = callIdOnce(member.tag)

            return Effect.gen(function* () {
              yield* outsideTurn

              if (member.kind !== "query") yield* callable

              const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)

              const outcome =
                member.kind === "query"
                  ? yield* internalActors.query(
                      Request.make({ ref, caller, command: member.tag, commandId: "", payload }),
                      internalActors.observedVersion(),
                    )
                  : yield* send(
                      Request.make({
                        ref,
                        caller,
                        command: member.tag,
                        commandId: yield* identify,
                        payload,
                      }),
                    )

              if (Outcome.guards.Defect(outcome)) return yield* Effect.die(outcome.cause)

              if (Outcome.guards.Failure(outcome)) {
                return yield* yield* decodeError(outcome.value).pipe(Effect.orDie)
              }

              if (Outcome.guards.Acknowledged(outcome))
                return yield* Effect.die(new Error(`Unexpected ${outcome.reason} acknowledgement`))

              return (yield* decodeOutput(outcome.value).pipe(Effect.orDie)).value
            })
          }

          if (!isWatchable(member)) return [member.tag, call]

          const watch = (input: typeof member.input.Type) =>
            Stream.unwrap(
              Effect.gen(function* () {
                yield* outsideTurn
                const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)

                const results = yield* internalActors.watch(
                  Request.make({ ref, caller, command: member.tag, commandId: "", payload }),
                  { minVersion: internalActors.observedVersion(), expiresAt: undefined },
                )

                return decoded(results, ({ value }) => value).pipe(
                  Stream.catchIf(
                    (error) =>
                      Schema.is(ActorError)(error) && Schema.is(InvalidInput)(error.reason),
                    Stream.die,
                  ),
                )
              }),
            )

          return [member.tag, Object.assign(call, { watch })]
        }),
    )

    return { ...methods, ref } as Handle<All, Creating, BoundedMailbox>
  })

  const stateWrites = Effect.fnUntraced(function* (
    current: typeof stateSchema.Type,
    dirty: ReadonlySet<string>,
  ) {
    const json = yield* encodeState(current).pipe(Effect.orDie)

    if (utf8.encode(json).byteLength > policy.stateMaxBytes)
      return yield* Effect.die(new Error("State exceeds policy.maxStateBytes"))

    const encoded = yield* decodeJsonObject(json).pipe(Effect.orDie)
    const writes: Array<readonly [string, string]> = []

    for (const key of dirty)
      writes.push([key, yield* encodeJson(encoded[key] ?? null).pipe(Effect.orDie)])

    if (dirty.size > 0 && version > 0) writes.push([VERSION_KEY, String(version)])

    return writes
  })

  const declaredFailure = Effect.fnUntraced(function* (
    { isError, encodeError }: MemberCodecs,
    error: DeclaredError["Type"],
  ) {
    if (!isError(error)) return yield* Effect.die(error)

    const value = yield* encodeError(error).pipe(Effect.orDie)

    return yield* Effect.fail<BusinessResult>({
      outcome: Outcome.cases.Failure.make({ value }),
      state: [],
      complete: false,
      events: [],
      outbox: emptyOutbox,
    })
  })

  type ServerFrame = Connections["server"]["Type"]

  const isEventEntry = Schema.is(
    Schema.Struct({
      cursor: Schema.String,
      event: Schema.Unknown,
      commandId: Schema.String,
      timestamp: Schema.DateTimeUtc,
    }),
  )

  const encodeFrame = (member: string, frame: FrameOf<ServerFrame>) =>
    Effect.gen(function* () {
      const codec = connectionCodecs.get(member)

      if (codec === undefined)
        return yield* Effect.die(new Error(`Undeclared connection ${member}`))

      if (isEventEntry(frame)) {
        const encoded = yield* codec.encodeServer({ value: frame.event }).pipe(Effect.option)

        if (Option.isSome(encoded)) return { frame: encoded.value, event: frame.cursor }
      }

      return { frame: yield* codec.encodeServer({ value: frame }).pipe(Effect.orDie) }
    })

  const broadcastsTo = (
    broadcasts: Array<Broadcast>,
    guard: (capability: string) => Effect.Effect<void>,
  ) =>
    Effect.fnUntraced(function* (
      member: AnyConnection,
      frame: FrameOf<ServerFrame>,
      options?: BroadcastOptions,
    ) {
      yield* guard("Broadcast")

      if (!connectionMembers.includes(member))
        return yield* Effect.die(new Error(`Undeclared connection ${member.tag}`))

      broadcasts.push({
        member: member.tag,
        ...(yield* encodeFrame(member.tag, frame)),
        to: options?.to,
        except: options?.except,
      })
    })

  type SessionOf = Exclude<Connections["session"], undefined>["Type"]

  const connectionHandler = <R>(
    member: AnyConnection,
    entry: ConnectionHandlers<AnyConnection, R>,
    services: Context.Context<R>,
  ): RegisteredConnection => {
    const codec = connectionCodecs.get(member.tag)!
    const memberCodec = codecs.get(member.tag)!

    return {
      stampCursor: member.stampCursor,
      progress:
        member.progress === undefined
          ? undefined
          : {
              effects: new Set(member.progress.effects.map((effect) => effect.tag)),
              to: member.progress.to,
            },
      hasResync: entry.resync !== undefined,
      run: Effect.fnUntraced(function* (input, phase) {
        let open = true
        const { state } = yield* decodeStored(input.state)

        let session: SessionOf | undefined =
          input.session === undefined || codec.decodeSession === undefined
            ? undefined
            : (yield* codec.decodeSession(input.session).pipe(Effect.orDie)).value

        let changed = false
        let close = false
        const sends: Array<{ readonly frame: string; readonly event?: string | undefined }> = []
        const broadcasts: Array<Broadcast> = []

        const guard = (capability: string) =>
          open
            ? Effect.void
            : Effect.die(new Error(`${capability} capability escaped its connection handler`))

        const set = Effect.fnUntraced(function* (patch: Partial<SessionOf>) {
          yield* guard("Session")

          if (codec.encodeSession === undefined || codec.decodeSession === undefined)
            return yield* Effect.die(new Error(`Connection ${member.tag} declares no session`))

          if (ConnectionPhase.guards.Resync(phase))
            return yield* Effect.die(new Error("A resync handler cannot change the session"))

          const next = Object.assign({}, session, patch)

          const encoded = yield* codec.encodeSession({ value: next }).pipe(Effect.orDie)
          session = (yield* codec.decodeSession(encoded).pipe(Effect.orDie)).value
          changed = true
        })

        let calls = 0
        const commands = input.commands

        const commandIds =
          commands === undefined
            ? undefined
            : (target: string, command: string) =>
                connectionCommandId({ commands, index: calls++, target, command })

        const context: ConnectionContext<State, Event, Connections["server"]["Type"], SessionOf> = {
          id: input.ref.id,
          ref: input.ref,
          connectionId: input.connectionId,
          member: input.member,
          caller: input.caller,
          principal: principal(input.caller),
          state: Object.freeze(state) as Readonly<State>,
          cursor: input.cursor,
          resumed: input.resumed,
          session: {
            get: Effect.sync(() => Option.fromUndefinedOr(session)),
            set,
          },
          send: Effect.fnUntraced(function* (frame: FrameOf<ServerFrame>) {
            yield* guard("Send")
            sends.push(yield* encodeFrame(member.tag, frame))
          }),
          broadcast: (frame, options) => broadcastsTo(broadcasts, guard)(member, frame, options),
          connections: (options) =>
            Effect.gen(function* () {
              yield* guard("Connections")

              return yield* Effect.forEach(yield* input.connections(member.tag), (open) =>
                Effect.gen(function* () {
                  if (
                    options?.session !== true ||
                    open.session === undefined ||
                    codec.decodeSession === undefined
                  )
                    return { connectionId: open.connectionId, caller: open.caller }

                  return {
                    connectionId: open.connectionId,
                    caller: open.caller,
                    session: (yield* codec.decodeSession(open.session).pipe(Effect.orDie))
                      .value as SessionOf,
                  }
                }),
              )
            }),
          close: Effect.suspend(() => {
            close = true

            return guard("Close")
          }),
          events: Effect.fnUntraced(function* <E extends Event>(
            event: E,
            options?: { readonly after?: string | undefined; readonly limit?: number },
          ) {
            yield* guard("Events")

            if (events.get(event.identifier) !== event)
              return yield* Effect.die(new Error(`Undeclared event: ${event.identifier}`))

            const limit = options?.limit ?? DEFAULT_REPLAY_LIMIT

            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT)
              return yield* Effect.die(
                new Error(`events limit must be an integer from 1 to ${MAX_REPLAY_LIMIT}`),
              )

            const { decode } = eventCodecs.get(event)!

            return yield* Effect.forEach(
              yield* input.events(event.identifier, options?.after, limit),
              Effect.fnUntraced(function* (stored) {
                const entry: EventEntry<E["Type"]> = {
                  cursor: stored.cursor,
                  event: (yield* decode(stored.value, stored.version).pipe(
                    Effect.orDie,
                  )) as E["Type"],
                  commandId: stored.commandId,
                  timestamp: DateTime.makeUnsafe(stored.timestampMs),
                }

                return entry
              }),
            )
          }),
        }

        const program = ConnectionPhase.match(phase, {
          Open: ({ params }) =>
            Effect.flatMap(memberCodec.decodeInput(params).pipe(Effect.orDie), ({ value }) =>
              entry.open(value),
            ).pipe(
              Effect.catch((error) =>
                memberCodec.isError(error)
                  ? Effect.flatMap(memberCodec.encodeError(error).pipe(Effect.orDie), (failure) =>
                      Effect.fail({ failure }),
                    )
                  : Effect.die(error),
              ),
            ),
          Frame: ({ frame }) =>
            Effect.flatMap(codec.decodeClient(frame).pipe(Effect.orDie), ({ value }) =>
              entry.frame(value),
            ),
          Close: ({ reason }) =>
            Effect.flatMap(
              decodeCloseReason(reason).pipe(Effect.orDie),
              (cause) => entry.close?.(cause) ?? Effect.void,
            ),
          Resync: ({ after }) => entry.resync?.({ after }) ?? Effect.void,
        })

        return yield* program.pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              const encoded =
                !changed || codec.encodeSession === undefined
                  ? input.session
                  : yield* codec.encodeSession({ value: session }).pipe(Effect.orDie)

              const result: ConnectionResult = {
                session: encoded,
                changed,
                sends,
                broadcasts,
                close,
              }

              return result
            }),
          ),
          Effect.ensuring(Effect.sync(() => (open = false))),
          Effect.provideService(CurrentCaller, input.caller),
          Effect.provideService(Tenant, input.ref.tenant),
          Effect.provideContext(Context.add(services, Connection, context)),
          Effect.provideService(CurrentConnectionCommands, commandIds),
        )
      }),
    }
  }

  const streamHandler = <R>(
    member: AnyStream,
    handle: StreamHandler<AnyStream, R | Read | InStream>,
    services: Context.Context<R>,
    actors: InternalActors["Service"],
  ): RegisteredStream => {
    const { decodeInput, encodeOutput, isError, encodeError } = codecs.get(member.tag)!

    return {
      progress: new Set(member.progress?.effects.map((effect) => effect.tag) ?? []),
      run: (payload: string, input: StreamInput) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { state } = yield* decodeStored(input.state)
            let open = true
            const stream = Symbol()

            const guard = (capability: string) =>
              open
                ? Effect.void
                : Effect.die(new Error(`${capability} capability escaped its stream`))

            const access = yield* actors.tables(
              { ref: input.ref, placement, tables, guard: guard("Table") },
              false,
            )

            const blob = yield* actors.blobs(
              {
                ref: input.ref,
                placement,
                blobs,
                guard: guard("Blob"),
                maxBytes: policy.blobMaxBytes,
                maxEntries: policy.blobMaxEntries,
                timeoutMs: policy.executionMs,
              },
              false,
            )

            const context: QueryContext<State, Event, Owned, Blobs, Effects[number]> = {
              id: input.ref.id,
              ref: input.ref,
              caller: input.caller,
              principal: principal(input.caller),
              state: Object.freeze(state) as Readonly<State>,
              cursor: input.cursor,
              events: replayWith(input.events),
              rows: access.rows as QueryContext<State, Event, Owned>["rows"],
              group: access.group,
              blob: blob as QueryContext<State, Event, Owned, Blobs>["blob"],
              follow: <E extends Event>(
                event: E,
                options?: { readonly after?: string | undefined },
              ) =>
                events.get(event.identifier) !== event
                  ? Stream.die(new Error(`Undeclared event: ${event.identifier}`))
                  : input
                      .follow(event.identifier, options?.after)
                      .pipe(Stream.mapEffect((stored) => entryOf(event, stored))),
              progress: <E extends Extract<Effects[number], ProgressEffect>>(
                effect: E,
                options?: { readonly effectId?: string | undefined },
              ) => {
                const codecs = progressCodecs.get(effect.tag)

                if (codecs === undefined || member.progress?.effects.includes(effect) !== true)
                  return Stream.die(
                    new Error(`Stream ${member.tag} does not list progress of ${effect.tag}`),
                  )

                return input.progress(effect.tag, options?.effectId).pipe(
                  Stream.mapEffect((stored) =>
                    Effect.gen(function* () {
                      const entry: ProgressEntry<E> = {
                        effectId: stored.effectId,
                        effect: (yield* codecs.effect(stored.effect)) as E["Type"],
                        attempt: stored.attempt,
                        seq: stored.seq,
                        frame: (yield* codecs.frame(stored.frame)) as ProgressOf<E>,
                      }

                      return entry
                    }).pipe(Effect.orDie),
                  ),
                )
              },
            }

            const { value } = yield* decodeInput(payload).pipe(Effect.orDie)

            return handle(value).pipe(
              Stream.mapEffect((output) => encodeOutput({ value: output }).pipe(Effect.orDie)),
              Stream.catch((error) =>
                isError(error)
                  ? Stream.fromEffect(
                      Effect.flatMap(encodeError(error).pipe(Effect.orDie), (failure) =>
                        Effect.fail({ failure }),
                      ),
                    )
                  : Stream.die(error),
              ),
              Stream.ensuring(Effect.sync(() => (open = false))),
              Stream.provideService(Read, context),
              Stream.provideService(InStream, { stream }),
              Stream.provideContext(services),
              Stream.provideService(CurrentCaller, input.caller),
              Stream.provideService(Tenant, input.ref.tenant),
              Stream.provideService(InsideTurn, stream),
            )
          }),
        ),
    }
  }

  const commandsOf = <R, RC, RS>(
    handlers: Handlers<All, R, RC, RS>,
    services: Context.Context<R | RC | RS>,
  ) =>
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const commands = new Map<string, RegisteredCommand>()
      const connections = new Map<string, RegisteredConnection>()

      for (const member of connectionMembers) {
        const entry = (
          handlers as Record<string, ConnectionHandlers<AnyConnection, RC> | undefined>
        )[member.tag]

        if (
          entry === undefined ||
          !Predicate.isFunction(entry.open) ||
          !Predicate.isFunction(entry.frame)
        )
          return yield* Effect.die(new Error(`Missing connection handlers ${member.tag}`))

        connections.set(member.tag, connectionHandler(member, entry, services))
      }

      const streams = new Map<string, RegisteredStream>()

      for (const member of streamMembers) {
        const handle = (
          handlers as Record<string, StreamHandler<AnyStream, RS | Read | InStream> | undefined>
        )[member.tag]

        if (!Predicate.isFunction(handle))
          return yield* Effect.die(new Error(`Missing stream handler ${member.tag}`))

        streams.set(member.tag, streamHandler(member, handle, services, actors))
      }

      for (const member of members) {
        const handle = (
          handlers as Record<string, (input: never) => Effect.Effect<unknown, unknown, R>>
        )[member.tag] as (
          input: typeof member.input.Type,
        ) => Effect.Effect<
          typeof member.output.Type,
          (typeof member.errors)[number]["Type"],
          R | Turn
        >

        if (handle === undefined)
          return yield* Effect.die(new Error(`Missing handler ${member.tag}`))

        const memberCodec = codecs.get(member.tag)!

        commands.set(member.tag, {
          internal: internalMembers.has(member),
          handler: handlerTags.has(member.tag),
          run: Effect.fnUntraced(function* (
            request: Request,
            rows: ReadonlyArray<readonly [string, string]>,
            {
              head,
              connections: listConnections,
            }: {
              readonly head: string
              readonly connections?: ConnectionLister | undefined
            },
          ) {
            let open = true
            const broadcasts: Array<Broadcast> = []
            const turn = Symbol()
            const dirty = new Set<string>()
            const emitted: Array<EmittedEvent> = []
            let emittedBytes = 0

            const loaded = yield* decodeStored(rows)
            let current = loaded.state

            if (loaded.upcast) for (const key of Object.keys(fields)) dirty.add(key)

            const set = Effect.fnUntraced(function* (patch: Partial<State>) {
              if (!open || (yield* InsideTurn) !== turn)
                return yield* Effect.die(new Error("State capability escaped its turn"))

              for (const key of Object.keys(patch)) {
                if (!(key in fields))
                  return yield* Effect.die(new Error(`Undeclared state key: ${key}`))
                dirty.add(key)
              }

              current = yield* decodeState(
                yield* encodeState({ ...current, ...patch }).pipe(Effect.orDie),
              ).pipe(Effect.orDie)
            })

            const emit = Effect.fnUntraced(function* (event: Event["Type"]) {
              if (!open || (yield* InsideTurn) !== turn)
                return yield* Effect.die(new Error("Event capability escaped its turn"))

              const declared = events.get(event._tag)

              if (declared === undefined || !Schema.is(declared)(event))
                return yield* Effect.die(new Error(`Undeclared event: ${event._tag}`))

              const { value, version } = yield* eventCodecs
                .get(declared)!
                .encode(event)
                .pipe(Effect.orDie)

              emittedBytes += utf8.encode(value).byteLength

              if (emittedBytes > MAX_EMIT_BYTES)
                return yield* Effect.die(
                  new Error(`Events emitted in one turn exceed ${MAX_EMIT_BYTES} bytes`),
                )

              emitted.push({ tag: declared.identifier, value, version })
            })

            const view = { set }

            const owner = Fiber.getCurrent()
            let misused: string | undefined

            const escaped = (capability: string) =>
              Effect.gen(function* () {
                if (!open || (yield* InsideTurn) !== turn)
                  return yield* Effect.die(new Error(`${capability} capability escaped its turn`))

                if (Fiber.getCurrent() !== owner) {
                  misused = `${capability} capability used from a fiber other than its turn's; timeout, race, and concurrent combinators run on other fibers`

                  return yield* Effect.die(new Error(misused))
                }
              })

            const wroteTables = new Set<string>()
            const wroteBlobs = new Set<string>()

            const access = yield* actors.tables(
              {
                ref: request.ref,
                placement,
                tables,
                guard: escaped("Table"),
                wrote: (table) => wroteTables.add(table),
              },
              true,
            )

            const blob = yield* actors.blobs(
              {
                ref: request.ref,
                placement,
                blobs,
                guard: escaped("Blob"),
                wrote: (name) => wroteBlobs.add(name),
                maxBytes: policy.blobMaxBytes,
                maxEntries: policy.blobMaxEntries,
                timeoutMs: policy.executionMs,
              },
              true,
            )

            for (const key of Object.keys(fields)) {
              const field = key as keyof typeof current
              Object.defineProperty(view, key, { enumerable: true, get: () => current[field] })
            }

            const outbox = openOutbox({
              sender: request.ref,
              commandId: request.commandId,
              head,
              onBehalfOf: Option.getOrUndefined(principal(request.caller)),
            })

            const mint = Effect.fnUntraced(function* (child: Mintable<string>) {
              yield* escaped("Mint")

              const target = mintables.get(child)

              if (target === undefined)
                return yield* Effect.die(
                  new Error("turn.mint needs an unkeyed actor that declares policy.createdBy"),
                )

              if (target.parent !== undefined && target.parent !== name)
                return yield* Effect.die(
                  new Error(
                    `turn.mint(${target.name}) needs a turn of its parent ${target.parent}`,
                  ),
                )

              const proof = outbox.nextMint()

              const minted = yield* actors.mintChildId({
                parent: isSingleton ? { ...request.ref, id: "" } : request.ref,
                commandId: request.commandId,
                ordinal: proof.ordinal,
                child: target.name,
              })

              const id =
                target.parent === undefined
                  ? minted
                  : childId({ parent: request.ref.id, local: minted })

              outbox.minted(
                ActorRef.make({ tenant: request.ref.tenant, actor: target.name, id }),
                target.createdBy,
                proof,
              )

              return id
            })

            const perform = Effect.fnUntraced(function* (
              instance: { readonly _tag: string },
              options?: PerformOptions,
            ) {
              if (!open || (yield* InsideTurn) !== turn)
                return yield* Effect.die(new Error("Effect capability escaped its turn"))

              const declared = effectCodecs.get(instance._tag)

              if (declared === undefined)
                return yield* Effect.die(new Error(`Undeclared effect: ${instance._tag}`))

              const scheduled = yield* Effect.sync(() => performSchedule(options))

              if (scheduled.key !== undefined) yield* warnUnrouted(instance._tag)
              const { value, version } = yield* declared.encode(instance).pipe(Effect.orDie)

              outbox.perform({
                effect: instance._tag,
                payload: value,
                version,
                capped: effectPolicies[instance._tag]?.concurrency !== undefined,
                ...scheduled,
              })
            })

            const changeSubscription = (op: "subscribe" | "remove") =>
              Effect.fnUntraced(function* (
                declared: AnySubscription,
                id: string,
                options?: { readonly from?: SubscribeFrom },
              ) {
                yield* escaped("Subscription")

                if (!subscriptions.includes(declared) || declared.route !== undefined)
                  return yield* Effect.die(
                    new Error(`${declared.tag} is not a dynamic subscription of ${name}`),
                  )

                const source = sources.get(declared.source)!
                const from = options?.from ?? "now"

                if (from !== "now" && from !== "start" && !isCursor(from))
                  return yield* Effect.die(
                    new Error(`subscribe from is "now", "start", or a cursor, not ${from}`),
                  )

                outbox.subscribe({
                  subscription: declared.tag,
                  source: ActorRef.make({
                    tenant: request.ref.tenant,
                    actor: declared.source.name,
                    id: source.singleton
                      ? "singleton"
                      : yield* source.decodeId(id).pipe(Effect.orDie),
                  }),
                  op,
                  from,
                  events: declared.events.map((event) => event.identifier),
                })
              })

            const cancelEffect = Effect.fnUntraced(function* (key: string) {
              if (!open || (yield* InsideTurn) !== turn)
                return yield* Effect.die(new Error("Effect capability escaped its turn"))

              yield* Effect.sync(() => effectKey(key))
              outbox.cancelEffect(key)
            })

            const context: CommandContext<State, Event, Owned, Blobs> &
              PerformContext<Effects[number]> &
              BroadcastContext<ConnectionsOf<Api>> & {
                readonly subscribe: (
                  declared: AnySubscription,
                  id: string,
                  options?: { readonly from?: SubscribeFrom },
                ) => Effect.Effect<void>
                readonly unsubscribe: (declared: AnySubscription, id: string) => Effect.Effect<void>
              } = {
              id: request.ref.id,
              ref: request.ref,
              caller: request.caller,
              principal: principal(request.caller),
              commandId: request.commandId,
              state: Object.freeze(view) as CommandContext<State>["state"],
              emit,
              rows: access.rows as CommandContext<State, Event, Owned>["rows"],
              group: access.group,
              blob: blob as CommandContext<State, Event, Owned, Blobs>["blob"],
              mint: mint as CommandContext<State>["mint"],
              perform,
              cancelEffect,
              broadcast: broadcastsTo(broadcasts, escaped),
              subscribe: changeSubscription("subscribe"),
              unsubscribe: (declared, id) => changeSubscription("remove")(declared, id),
              connections: (member: AnyConnection): Effect.Effect<ReadonlyArray<ConnectionInfo>> =>
                Effect.gen(function* () {
                  yield* escaped("Connections")

                  if (listConnections === undefined) return []

                  return (yield* listConnections(member.tag)).map(({ connectionId, caller }) => ({
                    connectionId,
                    caller,
                  }))
                }),
            }

            return yield* Effect.gen(function* () {
              const input = yield* memberCodec.decodeInput(request.payload).pipe(Effect.orDie)

              const output = yield* handle(input.value)

              if (misused !== undefined) return yield* Effect.die(new Error(misused))

              const uncreated = outbox.uncreated()

              if (uncreated !== undefined)
                return yield* Effect.die(
                  new Error(
                    `Minted actor ${uncreated.actor}/${uncreated.id} has no creating intent`,
                  ),
                )

              const keyed = outbox.keyedCreation()

              if (keyed !== undefined)
                return yield* Effect.die(
                  new Error(`Minted actor ${keyed.actor}/${keyed.id} has a keyed creating intent`),
                )

              const value = yield* memberCodec.encodeOutput({ value: output }).pipe(Effect.orDie)

              return {
                outcome: Outcome.cases.Success.make({ value }),
                state: yield* stateWrites(current, dirty),
                complete: loaded.upcast,
                events: emitted,
                outbox: outbox.close(),
                broadcasts,
                writes: { tables: [...wroteTables], blobs: [...wroteBlobs] },
              }
            }).pipe(
              Effect.catch((error) => declaredFailure(memberCodec, error)),
              Effect.ensuring(
                Effect.sync(() => {
                  open = false
                  outbox.close()
                }),
              ),
              Effect.provideContext(
                Context.merge(Context.make(InsideTurn, turn), services).pipe(
                  Context.add(InTurn, outbox.marker),
                  Context.add(Turn, context),
                ),
              ),
            )
          }),
        })
      }

      for (const reducer of reducers) {
        const reducerCodec = codecs.get(reducer.tag)!

        const reduceOnce = Effect.fnUntraced(function* (
          rows: ReadonlyArray<readonly [string, string]>,
          input: (typeof reducer.input)["Type"],
        ) {
          const loaded = yield* decodeStored(rows)

          const given = yield* decodeState(
            yield* encodeState(loaded.state).pipe(Effect.orDie),
          ).pipe(Effect.orDie)

          const reduced = reducer.reduce(given, input)

          if (Result.isFailure(reduced))
            return yield* declaredFailure(reducerCodec, reduced.failure)

          const next = yield* decodeState(
            yield* encodeState(reduced.success).pipe(Effect.orDie),
          ).pipe(Effect.orDie)

          const dirty = new Set(
            Object.keys(fields).filter(
              (key) => loaded.upcast || !fieldEquivalences[key]!(loaded.state[key], next[key]),
            ),
          )

          const value = yield* reducerCodec
            .encodeOutput({ value: reducer.commutative === undefined ? next : undefined })
            .pipe(Effect.orDie)

          return {
            outcome: Outcome.cases.Success.make({ value }),
            state: yield* stateWrites(next, dirty),
            complete: loaded.upcast,
            events: [],
            outbox: emptyOutbox,
          }
        })

        const decodeInput = (request: Request) =>
          reducerCodec.decodeInput(request.payload).pipe(
            Effect.orDie,
            Effect.map((input) => input.value),
          )

        const commutative = reducer.commutative

        const single: RegisteredCommand = {
          internal: false,
          handler: false,
          run: Effect.fnUntraced(function* (request, rows) {
            return yield* reduceOnce(rows, yield* decodeInput(request))
          }),
        }

        if (commutative === undefined) {
          commands.set(reducer.tag, single)
          continue
        }

        commands.set(reducer.tag, {
          ...single,
          merge: Effect.fnUntraced(function* (requests, rows) {
            const inputs = yield* Effect.forEach(requests, decodeInput)

            const combined = inputs.reduce((first, second) => commutative.combine(first, second))

            return yield* reduceOnce(rows, combined).pipe(
              Effect.catch(() =>
                Effect.die(new Error(`Commutative reducer ${reducer.tag} failed`)),
              ),
            )
          }),
        })
      }

      return {
        commands: commands as ReadonlyMap<string, RegisteredCommand>,
        connections,
        streams,
      }
    })

  const workflowsOf = <RW>(
    workflowHandlers: WorkflowHandlers<All, RW>,
    workflowServices: Context.Context<RW>,
  ) =>
    Effect.gen(function* () {
      const registeredWorkflows = new Map<string, RegisteredWorkflow>()

      for (const member of workflows) {
        const body = (
          workflowHandlers as Record<
            string,
            | ((input: never) => Effect.Effect<unknown, Cause.YieldableError, RW | Workflow>)
            | undefined
          >
        )[member.tag]

        if (body === undefined)
          return yield* Effect.die(new Error(`Missing workflow ${member.tag}`))

        const memberCodec = codecs.get(member.tag)!
        const exits = workflowExits.get(member.tag)!

        registeredWorkflows.set(member.tag, {
          member,
          steps: new Map(member.registry.steps),
          key: (payload, fallback) =>
            Effect.gen(function* () {
              if (member.key === undefined) return fallback

              const input = yield* memberCodec.decodeInput(payload)
              const key = member.key(input.value)

              yield* checkExecutionKey(key)

              return key
            }).pipe(Effect.orDie),
          run: (payload, context) =>
            memberCodec.decodeInput(payload).pipe(
              Effect.orDie,
              Effect.flatMap((input) => body(input.value as never)),
              Effect.exit,
              Effect.provideContext(
                Context.merge(Context.make(Workflow, context), workflowServices).pipe(
                  Context.add(Tenant, context.ref.tenant),
                  Context.add(
                    CurrentCaller,
                    System.make({
                      source: "workflow",
                      ref: context.ref,
                      onBehalfOf: Option.getOrUndefined(context.principal),
                    }),
                  ),
                ),
              ),
            ),
          encodeExit: exits.encode,
        })
      }

      return registeredWorkflows as ReadonlyMap<string, RegisteredWorkflow>
    })

  const toLayer = <R = never, RB = never, RC = never, RW = never, RS = never>(
    build: Effect.Effect<Handlers<All, R, RC, RS> & WorkflowHandlers<All, RW>, never, RB> &
      NoRequestReply<R>,
  ): Layer.Layer<
    never,
    never,
    | Exclude<R, Turn | InTurn>
    | Exclude<RC, Connection>
    | Exclude<RS, Read | InStream>
    | Exclude<RW, Workflow | WorkflowEngine.WorkflowInstance | Scope.Scope>
    | Exclude<RB, Scope.Scope>
    | InternalActors
  > =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const actors = yield* InternalActors

        const registration = {
          name,
          singleton: isSingleton,
          mintable,
          watches,
          tenant: yield* Tenant,
          access: definition.access,
          placement,
          policy,
          tables,
          blobs,
          cron,
          subscriptions: registeredSubscriptions,
          subscribers: policy.subscribers,
          payloads: [
            ...payloadDeclarations(true),
            ...subscriptions.flatMap((declared) =>
              declared.events.map((event) => ({
                actorType: declared.source.name,
                kind: "event" as const,
                tag: event.identifier,
                chain: payloadChain(event),
                writes: false,
              })),
            ),
          ],
          upcastEvent,
        }

        if (!isSingleton) {
          const handlers = yield* build

          const services = yield* Effect.context<
            Exclude<R, Turn | InTurn> | Exclude<RC, Connection> | Exclude<RS, Read | InStream>
          >()

          const workflowServices = Context.omit(Scope.Scope)(
            yield* Effect.context<
              Exclude<RW, Workflow | WorkflowEngine.WorkflowInstance | Scope.Scope>
            >(),
          )

          const { commands, connections, streams } = yield* commandsOf(
            handlers,
            services as Context.Context<R | RC | RS>,
          )

          return yield* actors.register({
            ...registration,
            workflows: yield* workflowsOf(handlers, workflowServices as Context.Context<RW>),
            activate: () => Effect.succeed(commands),
            connections,
            streams,
            feeds,
          })
        }

        if (
          connectionMembers.length > 0 ||
          streamMembers.length > 0 ||
          feeds.size > 0 ||
          watches.size > 0
        )
          return yield* Effect.die(
            new Error(
              "Singleton actors cannot declare connections, streams, feeds, or watches yet",
            ),
          )

        const services = yield* Effect.context<
          Exclude<R, Turn | InTurn> | Exclude<RB, Scope.Scope> | InternalActors
        >()

        if (workflows.length > 0)
          return yield* Effect.die(new Error(`Singleton actor ${name} cannot declare workflows`))

        yield* actors.register({
          ...registration,
          workflows: new Map(),
          activate: Effect.fnUntraced(function* (ref: ActorRef) {
            const scope = yield* Scope.Scope

            const handlers = yield* build.pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.provideService(Tenant, ref.tenant),
              Effect.provideService(CurrentCaller, System.make({ source: "actor", ref })),
              Effect.provideContext(services as Context.Context<RB>),
            )

            const { commands } = yield* commandsOf(
              handlers,
              services as Context.Context<R | RC | RS>,
            ).pipe(Effect.provideContext(services))

            return commands
          }),
          connections: new Map(),
          streams: new Map(),
          feeds,
        })
      }),
    ) as Layer.Layer<
      never,
      never,
      | Exclude<R, Turn | InTurn>
      | Exclude<RC, Connection>
      | Exclude<RS, Read | InStream>
      | Exclude<RW, Workflow | WorkflowEngine.WorkflowInstance | Scope.Scope>
      | Exclude<RB, Scope.Scope>
      | InternalActors
    >

  const recordingRead = (
    context: QueryContext<State, Event, Owned, Blobs, Effects[number]>,
    reads: ReadSet,
  ): QueryContext<State, Event, Owned, Blobs, Effects[number]> => ({
    get id() {
      reads.caller = true

      return context.id
    },
    get ref() {
      reads.caller = true

      return context.ref
    },
    get caller() {
      reads.caller = true

      return context.caller
    },
    get principal() {
      reads.caller = true

      return context.principal
    },
    get state() {
      reads.state = true

      return context.state
    },
    cursor: context.cursor,
    events: (event, options) => {
      reads.events.add(event.identifier)

      return context.events(event, options)
    },
    rows: (table) => {
      reads.tables.add(ownership(table)?.name ?? "")

      return context.rows(table)
    },
    get group() {
      reads.group = true

      return context.group
    },
    blob: (declared) => {
      reads.blobs.add(declared.name)

      return context.blob(declared)
    },
    follow: context.follow,
    progress: context.progress,
  })

  const registerQueries = <R>(
    handlers: QueryHandlers<Api, R, Read>,
    services: Context.Context<R>,
  ) =>
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const registered = new Map<string, RegisteredQuery>()

      for (const member of queries) {
        const handle = (
          handlers as Record<string, (input: never) => Effect.Effect<unknown, unknown, R>>
        )[member.tag] as (
          input: typeof member.input.Type,
        ) => Effect.Effect<
          typeof member.output.Type,
          (typeof member.errors)[number]["Type"],
          R | Read
        >

        if (handle === undefined)
          return yield* Effect.die(new Error(`Missing query handler ${member.tag}`))

        const { decodeInput, encodeOutput, isError, encodeError } = codecs.get(member.tag)!

        const watch = isWatchable(member)

        registered.set(member.tag, {
          watch,
          run: Effect.fnUntraced(function* (request, rows, cursor, readEvents, reads) {
            const { state } = yield* decodeStored(rows)
            let open = true
            const query = Symbol()

            const replay = replayWith(readEvents)

            const owner = Fiber.getCurrent()

            const escaped = (capability: string) =>
              Effect.gen(function* () {
                if (!open || (yield* InsideTurn) !== query)
                  return yield* Effect.die(new Error(`${capability} capability escaped its query`))

                if (Fiber.getCurrent() !== owner)
                  return yield* Effect.die(
                    new Error(
                      `${capability} capability used from a fiber other than its query's; timeout, race, and concurrent combinators run on other fibers`,
                    ),
                  )
              })

            const access = yield* actors.tables(
              { ref: request.ref, placement, tables, guard: escaped("Table") },
              false,
            )

            const blob = yield* actors.blobs(
              {
                ref: request.ref,
                placement,
                blobs,
                guard: escaped("Blob"),
                maxBytes: policy.blobMaxBytes,
                maxEntries: policy.blobMaxEntries,
                timeoutMs: policy.executionMs,
              },
              false,
            )

            const context: QueryContext<State, Event, Owned, Blobs, Effects[number]> = {
              id: request.ref.id,
              ref: request.ref,
              caller: request.caller,
              principal: principal(request.caller),
              state: Object.freeze(state) as Readonly<State>,
              cursor,
              events: replay,
              rows: access.rows as QueryContext<State, Event, Owned>["rows"],
              group: access.group,
              blob: blob as QueryContext<State, Event, Owned, Blobs>["blob"],
              follow: () =>
                Stream.die(new Error("read.follow is only available in stream handlers")),
              progress: () =>
                Stream.die(new Error("Progress is only available in stream handlers")),
            }

            return yield* Effect.gen(function* () {
              const input = yield* decodeInput(request.payload).pipe(Effect.orDie)

              const output = yield* handle(input.value)

              const value = yield* encodeOutput({ value: output }).pipe(Effect.orDie)

              return Outcome.cases.Success.make({ value })
            }).pipe(
              Effect.catch(
                Effect.fnUntraced(function* (error) {
                  if (!isError(error)) return yield* Effect.die(error)

                  const value = yield* encodeError(error).pipe(Effect.orDie)

                  return Outcome.cases.Failure.make({ value })
                }),
              ),
              Effect.catchDefect((cause) => Effect.succeed(Outcome.cases.Defect.make({ cause }))),
              Effect.ensuring(
                Effect.sync(() => {
                  open = false
                }),
              ),
              Effect.provideService(
                Read,
                reads === undefined ? context : recordingRead(context, reads),
              ),
              Effect.provideContext((watch ? Context.empty() : services) as Context.Context<R>),
              Effect.provideService(InsideTurn, query),
            )
          }),
        })
      }

      yield* actors.registerQueries({
        name,
        access: definition.access,
        placement,
        timeoutMs: policy.executionMs,
        tables,
        blobs,
        queries: registered,
        payloads: payloadDeclarations(false).filter((declared) => declared.kind === "event"),
      })
    })

  const toQueryLayer = <R = never, RB = never>(
    build: Effect.Effect<QueryHandlers<Api, R, Read>, never, RB>,
  ): Layer.Layer<never, never, Exclude<R, Read> | Exclude<RB, Scope.Scope> | InternalActors> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const handlers = yield* build
        const services = yield* Effect.context<Exclude<R, Read>>()
        yield* registerQueries(handlers, services as Context.Context<R>)
      }),
    ) as Layer.Layer<never, never, Exclude<R, Read> | Exclude<RB, Scope.Scope> | InternalActors>

  const routeCodec = (command: AnyCommand) => {
    const codec = Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: command.input })))

    return (value: typeof command.input.Type) =>
      Schema.encodeEffect(codec)({ value }).pipe(
        Effect.map((payload): EffectRoute => ({ command: command.tag, payload })),
      )
  }

  const registerEffects = <R>(
    executors: Executors<Effects[number], R>,
    services: Context.Context<R>,
  ) =>
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const registered = new Map<string, RegisteredEffect>()

      for (const declared of effects.values()) {
        const execute = (
          executors as Record<
            string,
            (effect: AnyEffect["Type"]) => Effect.Effect<unknown, Cause.YieldableError, R>
          >
        )[declared.tag]

        if (execute === undefined)
          return yield* Effect.die(new Error(`Missing executor ${declared.tag}`))

        const routes = effectPolicies[declared.tag]
        const { decode } = effectCodecs.get(declared.tag)!
        const onSuccess = routes?.onSuccess === undefined ? undefined : routeCodec(routes.onSuccess)

        const onDeadLetter =
          routes?.onDeadLetter === undefined ? undefined : routeCodec(routes.onDeadLetter)

        const onCancelled =
          routes?.onCancelled === undefined ? undefined : routeCodec(routes.onCancelled)

        const cancelledRoute = (
          effect: AnyEffect["Type"],
          letter: Parameters<RegisteredEffect["cancelled"]>[2] | CancelledSuccess,
        ): Effect.Effect<EffectRoute | undefined, Schema.SchemaError> =>
          Effect.gen(function* () {
            if (onCancelled === undefined) return undefined

            return yield* onCancelled({
              effectId: letter.effectId,
              effect,
              attempts: letter.attempts,
              outcome: letter.outcome,
              ambiguous: letter.ambiguous,
            })
          })

        const { timeoutMs, backoff, progressEveryMs } =
          effectTimings.get(declared.tag) ?? effectTiming(declared.tag, undefined)

        const encodeProgress =
          declared.progress === undefined
            ? undefined
            : Schema.encodeUnknownEffect(
                Schema.fromJsonString(Schema.toCodecJson(declared.progress)),
              )

        registered.set(declared.tag, {
          attempts: 1 + (routes?.retry?.times ?? DEFAULT_EFFECT_RETRIES),
          backoff,
          progressEveryMs: encodeProgress === undefined ? undefined : progressEveryMs,
          perActor: routes?.concurrency?.perActor,
          routesCancelled: onCancelled !== undefined,
          execute: Effect.fnUntraced(function* (payload, version, attempt) {
            const effect = yield* decode(payload, version).pipe(
              Effect.mapError((error) => ({
                cause: error.message,
                ambiguous: false,
                notStarted: true,
              })),
            )

            const { report, reporting, ...identity } = attempt

            const progress = (
              target: AnyEffect,
              frame: ProgressOf<ProgressEffect>,
            ): Effect.Effect<void> =>
              !reporting()
                ? Effect.void
                : target !== declared || encodeProgress === undefined
                  ? Effect.logWarning("Progress frame does not match the running effect")
                  : encodeProgress(frame).pipe(
                      Effect.map((json) => utf8.encode(json)),
                      Effect.matchEffect({
                        onFailure: (error) =>
                          Effect.logWarning("Progress frame did not encode", String(error)),
                        onSuccess: (bytes) =>
                          bytes.length > MAX_PROGRESS_BYTES
                            ? Effect.logWarning("Progress frame exceeds 4 KiB")
                            : report(bytes),
                      }),
                      Effect.catchDefect((defect) =>
                        Effect.logWarning("Progress frame did not encode", String(defect)),
                      ),
                    )

            const context = { ...identity, progress } as ExecutorContext<Effects[number]>

            const exit = yield* execute(effect).pipe(
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () => Effect.die(new Error(`Executor timed out after ${timeoutMs} ms`)),
              }),
              Effect.provideService(Executor, context),
              Effect.provideService(Tenant, context.ref.tenant),
              Effect.exit,
            )

            if (Exit.isFailure(exit))
              return yield* Effect.fail({
                cause: Cause.pretty(exit.cause),
                ambiguous:
                  !Cause.hasFails(exit.cause) ||
                  Cause.hasDies(exit.cause) ||
                  Cause.hasInterrupts(exit.cause),
              })

            const cancelled =
              onCancelled === undefined
                ? undefined
                : yield* cancelledRoute(effect, {
                    effectId: context.effectId,
                    attempts: context.attempt,
                    outcome: CancelledOutcome.cases.Succeeded.make({ value: exit.value }),
                    ambiguous: false,
                  }).pipe(
                    Effect.catch((error) =>
                      cancelledRoute(effect, {
                        effectId: context.effectId,
                        attempts: context.attempt,
                        outcome: CancelledOutcome.cases.Unknown.make({
                          cause: `The onCancelled route cannot accept the result: ${String(error)}`,
                        }),
                        ambiguous: true,
                      }),
                    ),
                    Effect.orDie,
                  )

            if (onSuccess === undefined)
              return { success: undefined, cancelled, rejected: undefined }

            const success = yield* onSuccess(exit.value).pipe(Effect.result)

            if (Result.isFailure(success))
              return {
                success: undefined,
                cancelled,
                rejected: {
                  cause: `The onSuccess route cannot accept the result: ${String(success.failure)}`,
                  ambiguous: true,
                  final: true,
                },
              }

            return { success: success.success, cancelled, rejected: undefined }
          }) as RegisteredEffect["execute"],
          cancelled: Effect.fnUntraced(function* (payload, version, letter) {
            const effect = yield* decode(payload, version).pipe(Effect.option)

            if (Option.isNone(effect)) return undefined

            return yield* cancelledRoute(effect.value, letter)
          }, Effect.orDie),
          deadLetter: Effect.fnUntraced(function* (payload, version, letter) {
            const effect = yield* decode(payload, version).pipe(Effect.option)

            if (onDeadLetter === undefined || Option.isNone(effect)) return undefined

            return yield* onDeadLetter({ ...letter, effect: effect.value })
          }, Effect.orDie),
        })
      }

      yield* actors.registerEffects({
        name,
        progress: progressEffects,
        services: services as Context.Context<never>,
        effects: registered,
        payloads: payloadDeclarations(false).filter((declared) => declared.kind === "effect"),
      })
    })

  const toEffectLayer = <R, RB>(
    build: Effect.Effect<Executors<Effects[number], R>, never, RB> & NoDatabase<R | RB>,
  ): Layer.Layer<never, never, Exclude<R, Executor> | Exclude<RB, Scope.Scope> | InternalActors> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const executors = yield* build
        const services = yield* Effect.context<Exclude<R, Executor>>()
        yield* registerEffects(executors, services as Context.Context<R>)
      }),
    ) as Layer.Layer<never, never, Exclude<R, Executor> | Exclude<RB, Scope.Scope> | InternalActors>

  const create = Effect.fnUntraced(function* () {
    yield* outsideTurn

    if (definition.key !== undefined)
      return yield* Effect.die(new Error("Only minted actors use create()"))

    if (parent !== undefined)
      return yield* Effect.die(new Error(`${name} is minted only by its parent ${parent.name}`))
    const internalActors = yield* InternalActors

    return yield* getHandle(yield* internalActors.mintActorId, false)
  })

  type Delivered = Omit<All, Subs[number]["handler"]["tag"]>

  const getIntents = Effect.fnUntraced(function* (
    id: string,
  ): Effect.fn.Return<Intents<Delivered>, never, InTurn> {
    const { marker, staging } = yield* currentStaging()

    const target = ActorRef.make({
      actor: name,
      tenant: staging.sender.tenant,
      id: isSingleton ? "singleton" : yield* decodeId(id).pipe(Effect.orDie),
    })

    const methods = Object.fromEntries(
      members.flatMap((member) => {
        if (handlerTags.has(member.tag)) return []

        const { encodeInput } = codecs.get(member.tag)!

        return [
          [
            member.tag,
            (input: typeof member.input.Type) =>
              Effect.gen(function* () {
                const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)

                yield* stageIntent(marker, { target, command: member.tag, payload })
              }),
          ] as const,
        ]
      }),
    )

    const starts = Object.fromEntries(
      workflows.map((member) => {
        const { encodeInput } = codecs.get(member.tag)!

        return [
          member.tag,
          (input: typeof member.input.Type) =>
            Effect.gen(function* () {
              const { staging: current } = yield* currentStaging(marker)
              const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)
              const ordinal = (startCounts.get(current) ?? 0) + 1

              startCounts.set(current, ordinal)

              const key =
                member.key === undefined ? `${current.commandId}:${ordinal}` : member.key(input)

              const executionId = yield* encodeExecutionId({
                tenant: target.tenant,
                actor: target.actor,
                id: target.id,
                workflow: member.tag,
                key,
              }).pipe(Effect.orDie)

              const own = current.sender.actor === target.actor && current.sender.id === target.id

              yield* stageIntent(marker, {
                target,
                command: START,
                payload: yield* encodeStartPayload({
                  workflow: member.tag,
                  input: payload,
                  key,
                  after: own ? current.head : null,
                }).pipe(Effect.orDie),
              })

              return executionId
            }),
        ]
      }),
    )

    return { ...methods, ...starts, ref: target } as Intents<Delivered>
  })

  const run = Effect.fnUntraced(function* <W extends Extract<Values<Api>, AnyWorkflow>>(
    member: W,
    executionId: string,
  ): Effect.fn.Return<WorkflowRun<W>, InvalidExecutionId, Actors | InternalActors> {
    yield* outsideTurn
    const actors = yield* Actors
    const internalActors = yield* InternalActors
    const caller = yield* decodeCaller(yield* CurrentCaller).pipe(Effect.orDie)
    const tenant = yield* Tenant
    const invalid = InvalidExecutionId.make({ executionId })
    const execution = yield* decodeExecutionId(executionId)

    if (
      execution.tenant !== tenant ||
      execution.actor !== name ||
      execution.workflow !== member.tag ||
      !workflows.includes(member)
    )
      return yield* invalid

    const id = isSingleton ? "singleton" : execution.id

    if (!isSingleton && Result.isFailure(Schema.decodeResult(idSchema)(id))) return yield* invalid

    return runOf(
      member,
      ActorRef.make({ actor: name, tenant, id }),
      caller,
      executionId,
      (request) => Effect.map(internalActors.execute(request), (executed) => executed.outcome),
      internalActors.pollWorkflow,
      actors.mintCommandId,
    ) as WorkflowRun<W>
  })

  const get = isSingleton
    ? () => getHandle("singleton", false)
    : (id: string) => getHandle(id, false)

  type Id = Pl extends { readonly parent: ParentDefinition }
    ? Schema.brand<Schema.String, Name>["Type"]
    : K extends KeySchema
      ? K["Type"]
      : Schema.brand<Schema.String, Name>["Type"]

  type ParentId = Pl extends { readonly parent: infer P extends ParentDefinition }
    ? NonNullable<P[typeof PlacedType]>["id"]
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
  const idOf = (parentId: ParentId, local: LocalKey): Id => {
    if (parent === undefined) throw new Error(`${name} is not parent-placed`)

    return childId({ parent: parentId, local }) as Id
  }

  const served: ServedDefinition = {
    name,
    key: isSingleton
      ? "singleton"
      : definition.key === undefined && parent === undefined
        ? "minted"
        : "keyed",
    decodeId: isSingleton ? () => Effect.succeed("singleton") : (id) => decodeId(id),
    encodeId: isSingleton ? () => Effect.succeed("singleton") : (id) => encodeId(id),
    members: Object.values(api)
      .filter(
        (member) =>
          member.kind !== "connection" && member.kind !== "stream" && member.kind !== "workflow",
      )
      .map((member) => servedMember({ member, codecs: codecs.get(member.tag)! })),
    connections: connectionMembers.map(servedConnection),
    feeds: [...feeds],
    contents: blobs.flatMap((declared) => (isContent(declared) ? [declared.name] : [])),
    streams: Object.values(api)
      .filter((member) => member.kind === "stream")
      .map((member) => servedMember({ member, codecs: codecs.get(member.tag)! })),
  }

  const actor = {
    /** The actor type's name: a letter followed by up to 79 letters or digits. */
    name,
    /** The schema of the actor's decoded state. */
    state: stateSchema,
    /** The declared public members. */
    api: definition.api as Api,
    /** Event classes this actor emits, which subscriptions to it may name. */
    events: (definition.events ?? []) as Events,
    /** The context of a command turn, read with `yield* X.Turn` in `X.toLayer` handlers. */
    Turn,
    /** The read-only context of a query or stream handler, read with `yield* X.Read`. */
    Read,
    /** The context of a connection handler, read with `yield* X.Connection`. */
    Connection,
    /** The context of one effect executor attempt, read with `yield* X.Executor`. */
    Executor,
    /** The context of a workflow body, read with `yield* X.Workflow`. */
    Workflow,
    /**
     * Reattaches to a workflow execution by id without contacting its owner. An
     * id of another tenant, actor type, or workflow fails `InvalidExecutionId`.
     */
    run: run as <W extends Extract<Values<Api>, AnyWorkflow>>(
      member: W,
      executionId: string,
    ) => Effect.Effect<WorkflowRun<W>, InvalidExecutionId, Actors>,
    /**
     * Implements every `api` and `internal` command, connection, stream, and
     * workflow; reducers have no entry. Command handlers read their turn with
     * `yield* X.Turn`, and one that acquires a handle with `X.get` does not
     * compile. The build Effect runs once when the layer is built,
     * except on a singleton, where it runs once per activation in the
     * activation's scope, so a fiber it forks with `Effect.forkScoped` lives
     * exactly as long as the one cluster-wide activation.
     *
     * @example
     * const CounterLive = Counter.toLayer(
     *   Effect.succeed({
     *     Increment: (by) =>
     *       Effect.gen(function* () {
     *         const turn = yield* Counter.Turn
     *         yield* turn.state.set({ count: turn.state.count + by })
     *         return turn.state.count
     *       }),
     *   }),
     * )
     */
    toLayer,
    /**
     * Implements every query in `api`. Queries run on the caller's node against
     * committed rows and read their context with `yield* X.Read`.
     */
    toQueryLayer,
    /**
     * Implements every declared effect's executor. Executors run after the
     * turn that performed the effect commits, read `yield* X.Executor`, and have
     * no database capability; the return value is routed to `onSuccess`.
     */
    toEffectLayer,
    /**
     * A request/reply handle to the actor with `id`, or to the singleton. It
     * never contacts the actor; a call does. An `id` that fails the key schema
     * is a defect, and acquiring a handle inside a turn is a defect.
     */
    get: get as K extends SingletonKey
      ? () => Effect.Effect<PublicHandle, never, Actors>
      : (id: Id) => Effect.Effect<PublicHandle, never, Actors>,
    /**
     * Mints a new UUIDv7 id and returns its handle. Only an unkeyed actor that
     * is not parent-placed has `create`; calling it inside a turn is a defect.
     */
    create: create as K extends undefined
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
    intents: (isSingleton ? () => getIntents("singleton") : getIntents) as K extends SingletonKey
      ? () => Effect.Effect<Intents<Delivered>, never, InTurn>
      : (id: string) => Effect.Effect<Intents<Delivered>, never, InTurn>,
    /**
     * A Promise client of this actor's public members over `Actor.serve`'s
     * HTTP protocol, for browsers and other code that doesn't run Effect.
     * Workflows are not served; a parent-placed actor is reached by its full
     * id and never created by a client.
     */
    client: (options: ClientOptions) =>
      clientOf<
        ActorClient<Omit<Api, WorkflowKeys<Api>>, ServedKey, Id, StateOf<Fields>, F[number]>
      >(served)(options),
  }

  for (const member of Object.values(api)) checkDeclaredErrors(member)

  for (const table of tables) {
    const info = ownership(table)!
    info.owner = name
    info.placement = placement
  }

  servedDefinitions.set(actor, served)

  definitionPayloads.set(actor, {
    declarations: payloadDeclarations(true),
    keepEventsMs: policy.keepEventsMs,
    commandTimeoutMs: policy.executionMs,
  })

  internalDefinitions.set(actor, {
    handle: (id, tenant, caller) => getHandle(id, true, caller, tenant),
  })

  if (mintable) mintables.set(actor, { name, createdBy: policy.createdBy!, parent: parent?.name })

  recordDeclaredTables({ definition: actor, tables: { actor: name, placement, tables } })

  placedDefinitions.set(actor, {
    name,
    placement,
    depth: parent === undefined ? 0 : parent.depth + 1,
    isId: isSingleton ? (id) => id === "singleton" : Schema.is(idSchema),
  })

  sources.set(actor, {
    singleton: isSingleton,
    subscribers: policy.subscribers,
    decodeId: (id) => decodeId(id),
  })

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
