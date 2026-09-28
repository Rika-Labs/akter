import type { Unify } from "effect"
import type { NodeInspectSymbol } from "effect/Inspectable"
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
} from "effect"
import {
  type CommandContext,
  type EventEntry,
  InsideTurn,
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
import { SessionEnded } from "../errors/actor.ts"
import { CallPhase, CurrentCallPhase, type WorkflowContext } from "../contexts/workflow.ts"
import { InvalidExecutionId, InvalidExecutionKey } from "../errors/workflow.ts"
import type { ActorError } from "../errors/actor.ts"
import {
  Actors,
  type BusinessResult,
  type EffectRoute,
  InternalActors,
  Outcome,
  type Broadcast,
  type ConnectionLister,
  type ConnectionResult,
  type RegisteredCommand,
  type RegisteredConnection,
  ConnectionPhase,
  type RegisteredEffect,
  type RegisteredQuery,
  type RegisteredWorkflow,
  type WorkflowStatus,
  type EmittedEvent,
  Request,
} from "../handles/actors.ts"
import {
  currentStaging,
  Due,
  effectKey,
  emptyOutbox,
  InTurn,
  openOutbox,
  stage,
} from "../handles/intents.ts"

import { ActorRef, Caller, CurrentCaller, Tenant, principal, System } from "../identity/caller.ts"
import {
  CurrentCommandId,
  CurrentConnectionCommands,
  connectionCommandId,
} from "../identity/command.ts"
import { checkKey, decodeExecutionId, encodeExecutionId } from "../identity/execution.ts"
import { type AnyWorkflow, exitCodec, isWorkflow } from "../members/workflow.ts"
import {
  ExecutionIdOutput,
  INTERRUPT,
  START,
  StartPayload,
  Target,
  workflowRun,
  type WorkflowRun,
} from "../handles/workflow.ts"
import { isMintedId } from "../identity/mint.ts"
import { type AnyBlob, isBlob } from "../members/blob.ts"
import { DEFAULT_REPLAY_LIMIT, type EventClass, MAX_REPLAY_LIMIT } from "../members/event.ts"
import type {
  AnyCommand,
  AnyMember,
  CommandRecord,
  DeclaredError,
  MemberRecord,
  ValueSchema,
} from "../members/command.ts"
import type { AnyReducer } from "../members/reducer.ts"
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
import { type AnyOwnedTable, ownership } from "../tables/owned.ts"
import { type ActorClient, type ClientOptions, clientOf } from "../client/make.ts"
import {
  checkDeclaredErrors,
  type ServedDefinition,
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

// Encoders and decoders are built once: building one per call recompiles its
// schema, which costs more than the value it encodes.
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

/** A member's payload, result, and declared-error codecs. */
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
export const singleton = SingletonKeySchema.make({})

export type SingletonKey = typeof singleton

type KeySchema = Schema.Codec<string, string>

type Key = KeySchema | SingletonKey | undefined

// Actors a turn may mint, with the command that alone creates each.
const mintables = new WeakMap<object, { readonly name: string; readonly createdBy: string }>()

const isUUIDv7 = Schema.is(Schema.String.check(Schema.isUUID(7)))

export declare const InternalHandleType: unique symbol

export interface DefinitionWithInternal<H> {
  readonly [InternalHandleType]?: H
}

export interface InternalDefinition<H extends { readonly ref: ActorRef }> {
  readonly handle: (
    id: string,
    tenant: string,
    caller: typeof System.Type,
  ) => Effect.Effect<H, never, Actors | InternalActors>
}

interface InternalDefinitionOwner {
  readonly get: unknown
}

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

type CommandKeys<Members extends MemberRecord> = {
  [K in keyof Members]: Members[K]["kind"] extends "command" ? K : never
}[keyof Members]

type QueryKeys<Members extends MemberRecord> = {
  [K in keyof Members]: Members[K]["kind"] extends "query" ? K : never
}[keyof Members]

type ConnectionKeys<Members extends MemberRecord> = {
  [K in keyof Members]: Members[K]["kind"] extends "connection" ? K : never
}[keyof Members]

type ConnectionsOf<Members extends MemberRecord> = Extract<
  Values<Members>,
  { readonly kind: "connection" }
> &
  AnyConnection

/** A connection member's entry in `X.toLayer`: short handlers, not one long-lived stream. */
export type ConnectionHandlers<C extends AnyConnection, R> = {
  readonly open: (params: C["input"]["Type"]) => Effect.Effect<void, C["errors"][number]["Type"], R>
  readonly frame: (frame: C["client"]["Type"]) => Effect.Effect<void, never, R>
  readonly close?: (reason: SessionEnded["cause"]) => Effect.Effect<void, never, R>
  /** Replays what the client missed after `after` when its owner died; it cannot change the session. */
  readonly resync?: (input: { readonly after: string | undefined }) => Effect.Effect<void, never, R>
}

type WorkflowKeys<Members extends MemberRecord> = {
  [K in keyof Members]: Members[K]["kind"] extends "workflow" ? K : never
}[keyof Members]

type ReducerKeys<Members extends MemberRecord> = {
  [K in keyof Members]: Members[K]["kind"] extends "reducer" ? K : never
}[keyof Members]

/** A query reads committed rows: it cannot conflict, expire, or hit a mailbox. */
type QueryReason = "ActorUnavailable" | "Unauthorized" | "Timeout"

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
 * delivered after it commits. Every command, public or internal, is reachable.
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

export type Handle<
  Members extends MemberRecord,
  Creating extends string = never,
  BoundedMailbox extends boolean = false,
> = {
  readonly [K in Exclude<keyof Members, ConnectionKeys<Members>>]: (
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

/** One handler per command in `api` and `internal`; a reducer has no handler. */
export type Handlers<Members extends MemberRecord, R, RC = R> = HandlerMap<
  Members,
  CommandKeys<Members>,
  R
> & {
  readonly [K in ReducerKeys<Members>]?: never
} & {
  readonly [K in ConnectionKeys<Members>]: ConnectionHandlers<Members[K] & AnyConnection, RC>
}

/**
 * One body per workflow in `api`. Bodies run outside turns and may use
 * request/reply handles, but only inside a step's `execute`.
 */
export type WorkflowHandlers<Members extends MemberRecord, R> = HandlerMap<
  Members,
  WorkflowKeys<Members>,
  R
>

/** One handler per query in `api`. */
export type QueryHandlers<Members extends MemberRecord, R> = HandlerMap<
  Members,
  QueryKeys<Members>,
  R
>

/** One executor per declared effect, returning the effect's `success` type. */
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
> {
  readonly key?: Key
  /** Which rows share a shard: the tenant (default) or each actor on its own. */
  readonly placement?: "tenant" | "actor"
  readonly state?: ActorState<Fields>
  /** Event classes this actor may emit in a turn and replay in a query. */
  readonly events?: Events
  /** `Actor.table` tables whose rows this actor type owns. */
  readonly tables?: Tables
  /** `Actor.blob` binary storage this actor type's turns write and its queries read. */
  readonly blobs?: Blobs
  readonly api: Api & TagsMatch<Api> & ReducerStates<Api, NoInfer<Fields>>
  readonly internal?: Internal & TagsMatch<Internal>
  /** `Actor.effect` classes this actor's turns may `perform`. */
  readonly effects?: Effects
  readonly policy?: Policy<CommandsOf<Api> | Values<Internal>, Effects[number]>
}

const encodeTarget = Schema.encodeEffect(Target)

const encodeStartPayload = Schema.encodeEffect(StartPayload)

// Workflow starts staged so far in each turn, numbering keyless starts.
const startCounts = new WeakMap<object, number>()

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
>(
  name: Name,
  definition: Definition<K, Fields, Api, Internal, Events, T, Effects, B> & {
    readonly key?: K
    readonly policy?: P
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

  const connectionMembers = all.filter(
    (member): member is AnyConnection => member.kind === "connection",
  )

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
  const isSingleton = Schema.is(SingletonKeySchema)(definition.key)
  const effects = new Map<string, AnyEffect>()

  for (const declared of definition.effects ?? []) {
    if (effects.has(declared.tag)) throw new Error(`Duplicate effect: ${declared.tag}`)
    effects.set(declared.tag, declared)
  }

  const effectEncoders = new Map(
    [...effects.values()].map(
      (declared) =>
        [
          declared.tag,
          Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(declared))),
        ] as const,
    ),
  )

  const effectPolicies: Readonly<Record<string, EffectPolicy<AnyEffect, AnyCommand> | undefined>> =
    definition.policy?.effects ?? {}

  const effectTimings = new Map<string, ReturnType<typeof effectTiming>>()

  const unrouted = new Set<string>()

  // A keyed effect is one a later turn may cancel; with no route to report
  // that to, an ambiguous cancellation reaches operators only.
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
  const placement = definition.placement ?? "tenant"

  // One actor type owns a table, so equal actor ids of two types never share rows.
  for (const table of tables) {
    const info = ownership(table)

    if (info === undefined) throw new Error("tables takes Actor.table values")

    if (tables.indexOf(table) !== tables.lastIndexOf(table))
      throw new Error(`Table ${info.name} is listed twice`)

    if (info.owner !== undefined && info.owner !== name)
      throw new Error(`Table ${info.name} is already owned by actor ${info.owner}`)
    info.owner = name
  }

  const events = new Map<string, EventClass>()

  for (const event of definition.events ?? []) {
    if (events.has(event.identifier)) throw new Error(`Duplicate event: ${event.identifier}`)
    events.set(event.identifier, event)
  }

  const eventCodecs = new Map(
    [...events.values()].map((event) => {
      const codec = Schema.fromJsonString(Schema.toCodecJson(event))

      return [
        event,
        { encode: Schema.encodeEffect(codec), decode: Schema.decodeEffect(codec) },
      ] as const
    }),
  )

  const blobs: ReadonlyArray<AnyBlob> = definition.blobs ?? []
  const blobNames = new Set<string>()

  for (const blob of blobs) {
    if (!isBlob(blob)) throw new Error("blobs takes Actor.blob values")

    if (blobNames.has(blob.name)) throw new Error(`Blob ${blob.name} is listed twice`)
    blobNames.add(blob.name)
  }

  const migrations = definition.state?.migrations ?? []
  ActorStates.validateChain(fields, migrations)
  const version = migrations.length

  // Decodes stored rows written at any earlier version into the current shape.
  const decodeStored = Effect.fnUntraced(function* (
    rows: ReadonlyArray<readonly [string, string]>,
  ) {
    const stored: Record<string, Schema.Json> = {}
    // An actor with no rows has nothing to upcast: it starts at the current shape.
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

  const idSchema: KeySchema = Schema.isSchema(key)
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
      BroadcastContext<ConnectionsOf<Api>>
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

  // Handles for one execution: poll reads like a query; interrupt is a receipted command.
  const runOf = (
    member: AnyWorkflow,
    ref: ActorRef,
    caller: Caller,
    executionId: string,
    execute: (request: Request) => Effect.Effect<Outcome, ActorError>,
    poll: (request: Request) => Effect.Effect<WorkflowStatus | undefined, ActorError>,
    mint: Effect.Effect<string>,
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

  class Read extends Context.Service<Read, QueryContext<State, Event, Owned, Blobs>>()(
    `durable-actors/Read/${name}`,
  ) {}

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

    // A workflow body sends only from inside a step, whose attempt derives each call's id.
    const callable = Effect.gen(function* () {
      if (CallPhase.$is("Body")(yield* CurrentCallPhase))
        return yield* Effect.die(new Error("Actor call in a workflow body outside a step"))
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

    const methods = Object.fromEntries(
      (includeInternal ? all : Object.values(api))
        .filter((member) => member.kind !== "connection")
        .map((member) => {
          const { encodeInput, decodeOutput, decodeError } = codecs.get(member.tag)!

          if (isWorkflow(member))
            return [
              member.tag,
              (input: typeof member.input.Type) => {
                const lock = Semaphore.makeUnsafe(1)
                let identity: string | undefined

                const identify = lock.withPermit(
                  Effect.gen(function* () {
                    if (identity === undefined) identity = yield* callId(member.tag)

                    return identity
                  }),
                )

                return Effect.gen(function* () {
                  yield* outsideTurn
                  yield* callable

                  if (member.key !== undefined) yield* checkKey(member.key(input))
                  const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)

                  const outcome = yield* internalActors.execute(
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
                    internalActors.execute,
                    internalActors.pollWorkflow,
                    actors.mintCommandId,
                  )
                })
              },
            ]

          return [
            member.tag,
            (input: typeof member.input.Type) => {
              const lock = Semaphore.makeUnsafe(1)
              let identity: string | undefined

              const identify = lock.withPermit(
                Effect.gen(function* () {
                  if (identity === undefined) identity = yield* callId(member.tag)

                  return identity
                }),
              )

              return Effect.gen(function* () {
                yield* outsideTurn

                if (member.kind !== "query") yield* callable

                const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)

                // Queries are reads: no command id, receipt, or retry identity.
                const outcome =
                  member.kind === "query"
                    ? yield* internalActors.query(
                        Request.make({ ref, caller, command: member.tag, commandId: "", payload }),
                      )
                    : yield* internalActors.execute(
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

                return (yield* decodeOutput(outcome.value).pipe(Effect.orDie)).value
              })
            },
          ]
        }),
    )

    return { ...methods, ref } as Handle<All, Creating, BoundedMailbox>
  })

  // Encodes a turn's final state within the size limit and lists the rows to write for `dirty` keys.
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

  // A declared failure commits only its receipt: no state rows.
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

  // Encodes a server frame; an event entry carries its own cursor for the client to deduplicate on.
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

  // Builds one connection member's handlers: each phase is a short call that
  // reads committed state and returns the frames and session it produced.
  const connectionHandler = <R>(
    member: AnyConnection,
    entry: ConnectionHandlers<AnyConnection, R>,
    services: Context.Context<R>,
  ): RegisteredConnection => {
    const codec = connectionCodecs.get(member.tag)!
    const memberCodec = codecs.get(member.tag)!

    return {
      stampCursor: member.stampCursor,
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
                  event: (yield* decode(stored.value).pipe(Effect.orDie)) as E["Type"],
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

  const commandsOf = <R, RC>(handlers: Handlers<All, R, RC>, services: Context.Context<R | RC>) =>
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
          run: Effect.fnUntraced(function* (
            request: Request,
            rows: ReadonlyArray<readonly [string, string]>,
            listConnections?: ConnectionLister,
          ) {
            let open = true
            const broadcasts: Array<Broadcast> = []
            const turn = Symbol()
            const dirty = new Set<string>()
            const emitted: Array<EmittedEvent> = []
            let emittedBytes = 0

            const loaded = yield* decodeStored(rows)
            let current = loaded.state

            // An upcast turn rewrites every key at the current version.
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

              const value = yield* eventCodecs.get(declared)!.encode(event).pipe(Effect.orDie)

              emittedBytes += new TextEncoder().encode(value).byteLength

              if (emittedBytes > MAX_EMIT_BYTES)
                return yield* Effect.die(
                  new Error(`Events emitted in one turn exceed ${MAX_EMIT_BYTES} bytes`),
                )

              emitted.push({ tag: declared.identifier, value })
            })

            const view = { set }

            // A forked fiber inherits InsideTurn, so the turn's own fiber is checked too.
            const owner = Fiber.getCurrent()
            // Set on a use from another fiber of this turn, so a swallowed defect still fails the turn.
            let misused: string | undefined

            const escaped = (capability: string) =>
              Effect.gen(function* () {
                if (!open || (yield* InsideTurn) !== turn)
                  return yield* Effect.die(new Error(`${capability} capability escaped its turn`))

                // The turn's one connection takes no concurrent statements.
                if (Fiber.getCurrent() !== owner) {
                  misused = `${capability} capability used from a fiber other than its turn's; timeout, race, and concurrent combinators run on other fibers`

                  return yield* Effect.die(new Error(misused))
                }
              })

            const access = yield* actors.tables(
              { ref: request.ref, placement, tables, guard: escaped("Table") },
              true,
            )

            const blob = yield* actors.blobs(
              {
                ref: request.ref,
                placement,
                blobs,
                guard: escaped("Blob"),
                maxBytes: policy.blobMaxBytes,
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
              onBehalfOf: Option.getOrUndefined(principal(request.caller)),
            })

            const mint = Effect.fnUntraced(function* (child: Mintable<string>) {
              yield* escaped("Mint")

              const target = mintables.get(child)

              if (target === undefined)
                return yield* Effect.die(
                  new Error("turn.mint needs an unkeyed actor that declares policy.createdBy"),
                )

              const proof = outbox.nextMint()

              const id = yield* actors.mintChildId({
                parent: isSingleton ? { ...request.ref, id: "" } : request.ref,
                commandId: request.commandId,
                ordinal: proof.ordinal,
                child: target.name,
              })

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

              const declared = effectEncoders.get(instance._tag)

              if (declared === undefined)
                return yield* Effect.die(new Error(`Undeclared effect: ${instance._tag}`))

              const scheduled = yield* Effect.sync(() => performSchedule(options))

              if (scheduled.key !== undefined) yield* warnUnrouted(instance._tag)

              outbox.perform({
                effect: instance._tag,
                payload: yield* declared(instance).pipe(Effect.orDie),
                ...scheduled,
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
              BroadcastContext<ConnectionsOf<Api>> = {
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
              }
            }).pipe(
              Effect.catch((error) => declaredFailure(memberCodec, error)),
              Effect.ensuring(
                Effect.sync(() => {
                  open = false
                  outbox.close()
                }),
              ),
              // One merged context instead of four nested provides, each of
              // which copies the whole fiber context.
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

        commands.set(reducer.tag, {
          internal: false,
          run: Effect.fnUntraced(function* (request, rows) {
            const loaded = yield* decodeStored(rows)

            const input = yield* reducerCodec.decodeInput(request.payload).pipe(Effect.orDie)

            // `reduce` gets its own copy, so mutating it in place cannot hide a change.
            const given = yield* decodeState(
              yield* encodeState(loaded.state).pipe(Effect.orDie),
            ).pipe(Effect.orDie)

            const reduced = reducer.reduce(given, input.value)

            if (Result.isFailure(reduced))
              return yield* declaredFailure(reducerCodec, reduced.failure)

            // Round-tripping validates the returned state against the actor's schema.
            const next = yield* decodeState(
              yield* encodeState(reduced.success).pipe(Effect.orDie),
            ).pipe(Effect.orDie)

            // Only changed keys are written, unless an upcast rewrites every key.
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
          }),
        })
      }

      return { commands: commands as ReadonlyMap<string, RegisteredCommand>, connections }
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

              yield* checkKey(key)

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

  /**
   * Implements every `api` and `internal` command; handlers read their turn
   * with `yield* X.Turn`. The build Effect runs once when the layer is built,
   * except on a singleton, where it runs once per activation in the
   * activation's scope, so a fiber it forks with `Effect.forkScoped` lives
   * exactly as long as the one cluster-wide activation.
   */
  // Defaults keep R `never` when there is no handler to infer it from, as for an actor of reducers only.
  const toLayer = <R = never, RB = never, RC = never, RW = never>(
    build: Effect.Effect<Handlers<All, R, RC> & WorkflowHandlers<All, RW>, never, RB> &
      NoRequestReply<R>,
  ): Layer.Layer<
    never,
    never,
    | Exclude<R, Turn | InTurn>
    | Exclude<RC, Connection>
    | Exclude<RW, Workflow>
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
          tenant: yield* Tenant,
          placement,
          policy,
          tables,
          blobs,
        }

        if (!isSingleton) {
          const handlers = yield* build

          const services = yield* Effect.context<
            Exclude<R, Turn | InTurn> | Exclude<RC, Connection>
          >()

          const workflowServices = yield* Effect.context<Exclude<RW, Workflow>>()

          const { commands, connections } = yield* commandsOf(
            handlers,
            services as Context.Context<R | RC>,
          )

          return yield* actors.register({
            ...registration,
            workflows: yield* workflowsOf(handlers, workflowServices as Context.Context<RW>),
            activate: () => Effect.succeed(commands),
            connections,
          })
        }

        if (connectionMembers.length > 0)
          return yield* Effect.die(new Error("Singleton actors cannot declare connections yet"))

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
              services as Context.Context<R | RC>,
            ).pipe(Effect.provideContext(services))

            return commands
          }),
          connections: new Map(),
        })
      }),
    ) as Layer.Layer<
      never,
      never,
      | Exclude<R, Turn | InTurn>
      | Exclude<RC, Connection>
      | Exclude<RW, Workflow>
      | Exclude<RB, Scope.Scope>
      | InternalActors
    >

  const registerQueries = <R>(handlers: QueryHandlers<Api, R>, services: Context.Context<R>) =>
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

        registered.set(member.tag, {
          run: Effect.fnUntraced(function* (request, rows, cursor, readEvents) {
            const { state } = yield* decodeStored(rows)
            let open = true
            const query = Symbol()

            const replay = Effect.fnUntraced(function* <E extends Event>(
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

              const { decode } = eventCodecs.get(event)!

              return yield* Effect.forEach(
                yield* readEvents(event.identifier, options?.after, limit),
                Effect.fnUntraced(function* (stored) {
                  const entry: EventEntry<E["Type"]> = {
                    cursor: stored.cursor,
                    event: (yield* decode(stored.value).pipe(Effect.orDie)) as E["Type"],
                    commandId: stored.commandId,
                    timestamp: DateTime.makeUnsafe(stored.timestampMs),
                  }

                  return entry
                }),
              )
            })

            // A forked fiber inherits InsideTurn, so the query's own fiber is checked too.
            const owner = Fiber.getCurrent()

            const escaped = (capability: string) =>
              Effect.gen(function* () {
                if (!open || (yield* InsideTurn) !== query)
                  return yield* Effect.die(new Error(`${capability} capability escaped its query`))

                // The query's one connection takes no concurrent statements.
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
              },
              false,
            )

            const context: QueryContext<State, Event, Owned, Blobs> = {
              id: request.ref.id,
              ref: request.ref,
              caller: request.caller,
              principal: principal(request.caller),
              state: Object.freeze(state) as Readonly<State>,
              cursor,
              events: replay,
              rows: access.rows as QueryContext<State, Event, Owned>["rows"],
              group: access.group,
              blob,
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
              Effect.provideService(Read, context),
              Effect.provideContext(services),
              // A query is read-only: marking it as a turn makes any command or
              // query call from its handler a defect instead of a write.
              Effect.provideService(InsideTurn, query),
            )
          }),
        })
      }

      yield* actors.registerQueries({
        name,
        placement,
        timeoutMs: policy.executionMs,
        tables,
        blobs,
        queries: registered,
      })
    })

  /**
   * Implements every query in `api`. Queries run on the caller's node against
   * committed rows and read their context with `yield* X.Read`.
   */
  const toQueryLayer = <R, RB>(
    build: Effect.Effect<QueryHandlers<Api, R>, never, RB>,
  ): Layer.Layer<never, never, Exclude<R, Read> | Exclude<RB, Scope.Scope> | InternalActors> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const handlers = yield* build
        const services = yield* Effect.context<Exclude<R, Read>>()
        yield* registerQueries(handlers, services as Context.Context<R>)
      }),
    ) as Layer.Layer<never, never, Exclude<R, Read> | Exclude<RB, Scope.Scope> | InternalActors>

  // A route's payload is its command's input, encoded the way intents encode it.
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
        const decode = Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(declared)))
        const onSuccess = routes?.onSuccess === undefined ? undefined : routeCodec(routes.onSuccess)

        const onDeadLetter =
          routes?.onDeadLetter === undefined ? undefined : routeCodec(routes.onDeadLetter)

        const onCancelled =
          routes?.onCancelled === undefined ? undefined : routeCodec(routes.onCancelled)

        const cancelledRoute = (
          effect: AnyEffect["Type"],
          letter: Parameters<RegisteredEffect["cancelled"]>[1] | CancelledSuccess,
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
          execute: Effect.fnUntraced(function* (payload, attempt) {
            const effect = yield* decode(payload).pipe(
              Effect.mapError((error) => ({ cause: String(error), ambiguous: false })),
            )

            const { report, reporting, ...identity } = attempt

            // Progress is cosmetic: a bad frame is dropped with a warning,
            // never a defect that would make the outcome unknown.
            const progress = (
              target: AnyEffect,
              frame: ProgressOf<ProgressEffect>,
            ): Effect.Effect<void> =>
              !reporting()
                ? Effect.void
                : target !== declared || encodeProgress === undefined
                  ? Effect.logWarning("Progress frame does not match the running effect")
                  : encodeProgress(frame).pipe(
                      Effect.map((json) => new TextEncoder().encode(json)),
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
              // Only a typed failure says the provider did not apply the call;
              // a defect, timeout, or interruption leaves the outcome unknown.
              return yield* Effect.fail({
                cause: Cause.pretty(exit.cause),
                ambiguous:
                  !Cause.hasFails(exit.cause) ||
                  Cause.hasDies(exit.cause) ||
                  Cause.hasInterrupts(exit.cause),
              })

            // A cancelled effect reports its result to onCancelled; one the
            // route cannot accept is reported as unknown there.
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

            // The provider already applied the call, so a result the route
            // cannot accept is dead-lettered instead of executed again, unless
            // the effect was cancelled and onCancelled takes the result.
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
          cancelled: Effect.fnUntraced(function* (payload, letter) {
            const effect = yield* decode(payload).pipe(Effect.option)

            if (Option.isNone(effect)) return undefined

            return yield* cancelledRoute(effect.value, letter)
          }, Effect.orDie),
          // A payload that no longer decodes is still dead-lettered for
          // operators; only its route, which needs the decoded effect, is skipped.
          deadLetter: Effect.fnUntraced(function* (payload, letter) {
            const effect = yield* decode(payload).pipe(Effect.option)

            if (onDeadLetter === undefined || Option.isNone(effect)) return undefined

            return yield* onDeadLetter({ ...letter, effect: effect.value })
          }, Effect.orDie),
        })
      }

      yield* actors.registerEffects({
        name,
        services: services as Context.Context<never>,
        effects: registered,
      })
    })

  /**
   * Implements every declared effect's executor. Executors run after the
   * turn that performed the effect commits, read `yield* X.Executor`, and have
   * no database capability; the return value is routed to `onSuccess`.
   */
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
    const internalActors = yield* InternalActors

    return yield* getHandle(yield* internalActors.mintActorId, false)
  })

  const getIntents = Effect.fnUntraced(function* (
    id: string,
  ): Effect.fn.Return<Intents<All>, never, InTurn> {
    const { marker, staging } = yield* currentStaging()

    const target = ActorRef.make({
      actor: name,
      // Intents stay within the sending turn's tenant.
      tenant: staging.sender.tenant,
      id: isSingleton ? "singleton" : yield* decodeId(id).pipe(Effect.orDie),
    })

    const methods = Object.fromEntries(
      members.map((member) => {
        const { encodeInput } = codecs.get(member.tag)!

        return [
          member.tag,
          (input: typeof member.input.Type) =>
            Effect.gen(function* () {
              const payload = yield* encodeInput({ value: input }).pipe(Effect.orDie)

              yield* stage(marker, { target, command: member.tag, payload })
            }),
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

              // A retried turn repeats its command id, so it restages the same executions.
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

              yield* stage(marker, {
                target,
                command: START,
                payload: yield* encodeStartPayload({
                  workflow: member.tag,
                  input: payload,
                  key,
                  startedBy: own ? current.commandId : null,
                }).pipe(Effect.orDie),
              })

              return executionId
            }),
        ]
      }),
    )

    return { ...methods, ...starts, ref: target } as Intents<All>
  })

  /** Reattaches to an execution by id, without contacting its owner. */
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
      internalActors.execute,
      internalActors.pollWorkflow,
      actors.mintCommandId,
    ) as WorkflowRun<W>
  })

  const get = isSingleton
    ? () => getHandle("singleton", false)
    : (id: string) => getHandle(id, false)

  type Id = K extends KeySchema ? K["Type"] : Schema.brand<Schema.String, Name>["Type"]

  const served: ServedDefinition = {
    name,
    key: isSingleton ? "singleton" : definition.key === undefined ? "minted" : "keyed",
    decodeId: isSingleton ? () => Effect.succeed("singleton") : (id) => decodeId(id),
    encodeId: isSingleton ? () => Effect.succeed("singleton") : (id) => encodeId(id),
    members: Object.values(api)
      .filter((member) => member.kind !== "connection" && member.kind !== "workflow")
      .map((member) => servedMember({ member, codecs: codecs.get(member.tag)! })),
    deliveryMs: policy.deliveryMs,
  }

  const actor = {
    name,
    state: stateSchema,
    api: definition.api as Api,
    Turn,
    Read,
    Connection,
    Executor,
    Workflow,
    run: run as <W extends Extract<Values<Api>, AnyWorkflow>>(
      member: W,
      executionId: string,
    ) => Effect.Effect<WorkflowRun<W>, InvalidExecutionId, Actors>,
    toLayer,
    toQueryLayer,
    toEffectLayer,
    get: get as K extends SingletonKey
      ? () => Effect.Effect<PublicHandle, never, Actors>
      : (id: Id) => Effect.Effect<PublicHandle, never, Actors>,
    create: create as K extends undefined
      ? () => Effect.Effect<PublicHandle, never, Actors>
      : never,
    /**
     * Durable intents to this actor; only command turns provide `InTurn`. The
     * id is a plain string so `X.intents(turn.id)` works for every key kind;
     * an id that fails the key schema is a deterministic defect.
     */
    intents: (isSingleton ? () => getIntents("singleton") : getIntents) as K extends SingletonKey
      ? () => Effect.Effect<Intents<All>, never, InTurn>
      : (id: string) => Effect.Effect<Intents<All>, never, InTurn>,
    /**
     * A Promise client of this actor's public members over `Actor.serve`'s
     * HTTP protocol, for browsers and other code that doesn't run Effect.
     */
    client: (options: ClientOptions) =>
      clientOf<
        ActorClient<
          Omit<Api, WorkflowKeys<Api> | ConnectionKeys<Api>>,
          K extends SingletonKey ? "singleton" : K extends undefined ? "minted" : "keyed",
          Id,
          StateOf<Fields>
        >
      >(served)(options),
  }

  for (const member of Object.values(api)) checkDeclaredErrors(member)

  servedDefinitions.set(actor, served)

  internalDefinitions.set(actor, {
    handle: (id, tenant, caller) => getHandle(id, true, caller, tenant),
  })

  if (mintable) mintables.set(actor, { name, createdBy: policy.createdBy! })

  return actor as typeof actor &
    DefinitionWithInternal<Handle<All, Creating, BoundedMailbox>> &
    (K extends undefined ? ([Creating] extends [never] ? unknown : Mintable<Id>) : unknown)
}

/**
 * `Actor.make`'s type. An interface keeps its name in declaration files, so
 * entries reference it instead of expanding `make`'s inferred type.
 */
export interface Make extends MakeFunction {}

type MakeFunction = typeof make

export const Definition = { make: make as Make, singleton }

/**
 * `make`'s local `Context.Service` classes inherit members keyed by these
 * unique symbols, and a declaration file can name a unique symbol only
 * through a module that exports it.
 */
export type { NodeInspectSymbol, Unify }
