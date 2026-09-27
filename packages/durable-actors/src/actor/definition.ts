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
import type { ExecutorContext, PerformContext } from "../contexts/effect.ts"
import type { ActorError } from "../errors/actor.ts"
import {
  Actors,
  type BusinessResult,
  type EffectRoute,
  InternalActors,
  Outcome,
  type RegisteredCommand,
  type RegisteredEffect,
  type RegisteredQuery,
  type EmittedEvent,
  Request,
} from "../handles/actors.ts"
import { currentStaging, emptyOutbox, InTurn, openOutbox, stage } from "../handles/intents.ts"
import {
  ActorRef,
  Caller,
  CurrentCaller,
  Tenant,
  principal,
  type System,
} from "../identity/caller.ts"
import { CurrentCommandId } from "../identity/command.ts"
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
import type { AnyEffect, EffectPolicy } from "../members/effect.ts"
import type { NoDatabase } from "../runtime/effects/isolation.ts"
import { type Policy, resolvePolicy } from "../policies/command.ts"
import { type AnyOwnedTable, ownership } from "../tables/owned.ts"
import { checkDeclaredErrors, servedDefinitions, servedMember } from "./served.ts"
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
} & { readonly ref: ActorRef }

export type Handle<
  Members extends MemberRecord,
  Creating extends string = never,
  BoundedMailbox extends boolean = false,
> = {
  readonly [K in keyof Members]: (
    ...args: Members[K]["input"]["Type"] extends void ? [] : [input: Members[K]["input"]["Type"]]
  ) => Effect.Effect<
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
export type Handlers<Members extends MemberRecord, R> = HandlerMap<
  Members,
  CommandKeys<Members>,
  R
> & {
  readonly [K in ReducerKeys<Members>]?: never
}

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

/** Effect timings are timer durations: 1 ms to 2^31 − 1 ms. */
const effectMillis = (path: string, duration: Duration.Input) => {
  const millis = Duration.toMillis(Duration.fromInputUnsafe(duration))

  if (!Number.isFinite(millis) || millis < 1 || millis > 2_147_483_647)
    throw new Error(`${path} must be a duration from 1 millisecond to 2147483647 milliseconds`)

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
  } satisfies { readonly timeoutMs: number; readonly backoff: RegisteredEffect["backoff"] }

  if (timing.backoff.maxMs < timing.backoff.baseMs)
    throw new Error(`policy.effects.${tag}.retry.backoff.max must be at least its base`)

  return timing
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

    if (tags.has(member.tag) || member.tag === "ref")
      throw new Error(`Duplicate or reserved command: ${member.tag}`)
    tags.add(member.tag)
  }

  for (const member of Object.values(internal))
    if (member.kind !== "command")
      throw new Error(`Internal members must be commands: ${member.tag}`)

  const all = [...Object.values(api), ...Object.values(internal)]
  const members = all.filter((member): member is AnyCommand => member.kind === "command")
  const queries = all.filter((member) => member.kind === "query")
  const reducers = all.filter((member): member is AnyReducer => member.kind === "reducer")
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

  for (const [tag, effectPolicy] of Object.entries(effectPolicies)) {
    if (!effects.has(tag)) throw new Error(`policy.effects.${tag} names no declared effect`)

    for (const route of [effectPolicy?.onSuccess, effectPolicy?.onDeadLetter])
      if (route !== undefined && !members.includes(route))
        throw new Error(`policy.effects.${tag} routes must name a command of this actor`)

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
    : mintable
      ? Schema.String.check(
          Schema.makeFilter((id: string) => isUUIDv7(id) || isMintedId(id), {
            expected: "a UUID v7 or a minted UUID v8",
          }),
        ).pipe(Schema.brand(name))
      : Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand(name))

  const decodeId = Schema.decodeEffect(idSchema)

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
    CommandContext<State, Event, Owned, Blobs> & PerformContext<Effects[number]>
  >()(`durable-actors/Turn/${name}`) {}

  class Executor extends Context.Service<Executor, ExecutorContext>()(
    `durable-actors/Executor/${name}`,
  ) {}

  class Read extends Context.Service<Read, QueryContext<State, Event, Owned, Blobs>>()(
    `durable-actors/Read/${name}`,
  ) {}

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

    const methods = Object.fromEntries(
      (includeInternal ? all : Object.values(api)).map((member) => {
        const { encodeInput, decodeOutput, decodeError } = codecs.get(member.tag)!

        return [
          member.tag,
          (input: typeof member.input.Type) => {
            const lock = Semaphore.makeUnsafe(1)
            let identity: string | undefined

            const identify = lock.withPermit(
              Effect.gen(function* () {
                if (identity === undefined)
                  identity = (yield* CurrentCommandId) ?? (yield* actors.mintCommandId)

                return identity
              }),
            )

            return Effect.gen(function* () {
              yield* outsideTurn

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

  const register = <R>(handlers: Handlers<All, R>, services: Context.Context<R>) =>
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const commands = new Map<string, RegisteredCommand>()

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
          ) {
            let open = true
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
              onBehalfOf: Option.getOrUndefined(principal(request.caller)),
              commandId: request.commandId,
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

            const perform = Effect.fnUntraced(function* (instance: { readonly _tag: string }) {
              if (!open || (yield* InsideTurn) !== turn)
                return yield* Effect.die(new Error("Effect capability escaped its turn"))

              const declared = effectEncoders.get(instance._tag)

              if (declared === undefined)
                return yield* Effect.die(new Error(`Undeclared effect: ${instance._tag}`))

              outbox.perform({
                effect: instance._tag,
                payload: yield* declared(instance).pipe(Effect.orDie),
              })
            })

            const context: CommandContext<State, Event, Owned, Blobs> &
              PerformContext<Effects[number]> = {
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

              const value = yield* memberCodec.encodeOutput({ value: output }).pipe(Effect.orDie)

              return {
                outcome: Outcome.cases.Success.make({ value }),
                state: yield* stateWrites(current, dirty),
                complete: loaded.upcast,
                events: emitted,

                outbox: outbox.close(),
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

      yield* actors.register({
        name,
        commands,
        singleton: isSingleton,
        mintable,
        placement,
        policy,
        tables,
        blobs,
      })
    })

  /**
   * Implements every `api` and `internal` command. The build Effect runs once
   * when the layer is built; handlers read their turn with `yield* X.Turn`.
   */
  // Defaults keep R `never` when there is no handler to infer it from, as for an actor of reducers only.
  const toLayer = <R = never, RB = never>(
    build: Effect.Effect<Handlers<All, R>, never, RB> & NoRequestReply<R>,
  ): Layer.Layer<
    never,
    never,
    Exclude<R, Turn | InTurn> | Exclude<RB, Scope.Scope> | InternalActors
  > =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const handlers = yield* build
        const services = yield* Effect.context<Exclude<R, Turn | InTurn>>()
        yield* register(handlers, services as Context.Context<R>)
      }),
    ) as Layer.Layer<
      never,
      never,
      Exclude<R, Turn | InTurn> | Exclude<RB, Scope.Scope> | InternalActors
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

        const { timeoutMs, backoff } =
          effectTimings.get(declared.tag) ?? effectTiming(declared.tag, undefined)

        registered.set(declared.tag, {
          attempts: 1 + (routes?.retry?.times ?? DEFAULT_EFFECT_RETRIES),
          backoff,
          execute: Effect.fnUntraced(function* (payload, context) {
            const effect = yield* decode(payload).pipe(
              Effect.mapError((error) => ({ cause: String(error), ambiguous: false })),
            )

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

            if (onSuccess === undefined) return undefined

            // The provider already applied the call, so a result the route
            // cannot accept is dead-lettered instead of executed again.
            return yield* onSuccess(exit.value).pipe(
              Effect.mapError((error) => ({
                cause: `The onSuccess route cannot accept the result: ${String(error)}`,
                ambiguous: true,
                final: true,
              })),
            )
          }) as RegisteredEffect["execute"],
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

    return { ...methods, ref: target } as Intents<All>
  })

  const get = isSingleton
    ? () => getHandle("singleton", false)
    : (id: string) => getHandle(id, false)

  type Id = K extends KeySchema ? K["Type"] : Schema.brand<Schema.String, Name>["Type"]

  const actor = {
    name,
    state: stateSchema,
    api: definition.api as Api,
    Turn,
    Read,
    Executor,
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
  }

  for (const member of Object.values(api)) checkDeclaredErrors(member)

  servedDefinitions.set(actor, {
    name,
    key: isSingleton ? "singleton" : definition.key === undefined ? "minted" : "keyed",
    decodeId: isSingleton ? () => Effect.succeed("singleton") : (id) => decodeId(id),
    members: Object.values(api).map((member) =>
      servedMember({ member, codecs: codecs.get(member.tag)! }),
    ),
    deliveryMs: policy.deliveryMs,
  })

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
