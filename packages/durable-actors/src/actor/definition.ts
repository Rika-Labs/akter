import { Context, Effect, Fiber, Layer, Option, Result, Schema, Scope, Semaphore } from "effect"
import {
  type CommandContext,
  InsideTurn,
  outsideTurn,
  type QueryContext,
} from "../contexts/command.ts"
import type { ActorError } from "../errors/actor.ts"
import {
  Actors,
  type BusinessResult,
  InternalActors,
  Outcome,
  type RegisteredCommand,
  type RegisteredQuery,
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
import { type AnyBlob, isBlob } from "../members/blob.ts"
import type {
  AnyCommand,
  AnyMember,
  CommandRecord,
  DeclaredError,
  MemberRecord,
  ValueSchema,
} from "../members/command.ts"
import type { AnyReducer } from "../members/reducer.ts"
import { type Policy, resolvePolicy } from "../policies/command.ts"
import { type AnyOwnedTable, ownership } from "../tables/owned.ts"
import {
  type ActorState,
  ActorStates,
  type StateMigration,
  VERSION_KEY,
} from "../state/migration.ts"

type StateFields = Readonly<Record<string, ValueSchema>>

const StoredVersion = Schema.fromJsonString(
  Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
)

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
type QueryReason = "ActorUnavailable" | "Unauthorized"

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
  Tables extends ReadonlyArray<AnyOwnedTable>,
  Blobs extends ReadonlyArray<AnyBlob>,
> {
  readonly key?: Key
  /** Which rows share a shard: the tenant (default) or each actor on its own. */
  readonly placement?: "tenant" | "actor"
  readonly state?: ActorState<Fields>
  /** `Actor.table` tables whose rows this actor type owns. */
  readonly tables?: Tables
  /** `Actor.blob` binary storage this actor type's turns write and its queries read. */
  readonly blobs?: Blobs
  readonly api: Api & TagsMatch<Api> & ReducerStates<Api, NoInfer<Fields>>
  readonly internal?: Internal & TagsMatch<Internal>
  readonly policy?: Policy<CommandsOf<Api> | Values<Internal>>
}

const make = <
  const Name extends string,
  const Api extends MemberRecord,
  const Fields extends StateFields = {},
  const Internal extends CommandRecord = {},
  const K extends Key = undefined,
  const P extends Policy<CommandsOf<Api> | Values<Internal>> = {},
  const T extends ReadonlyArray<AnyOwnedTable> = [],
  const B extends ReadonlyArray<AnyBlob> = [],
>(
  name: Name,
  definition: Definition<K, Fields, Api, Internal, T, B> & {
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
      if (key === VERSION_KEY)
        storedVersion = yield* Schema.decodeEffect(StoredVersion)(value).pipe(Effect.orDie)
      else
        stored[key] = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(value).pipe(
          Effect.orDie,
        )

    if (storedVersion > version)
      return yield* Effect.die(new Error(`Stored state version ${storedVersion} is unknown`))

    let current: Schema.Json = stored

    for (const step of migrations.slice(storedVersion)) current = yield* upcastStep(step, current)

    return {
      state: yield* Schema.decodeEffect(Schema.toCodecJson(stateSchema))(current).pipe(
        Effect.orDie,
      ),
      upcast: storedVersion < version && rows.length > 0,
    }
  })

  const stateSchema = Schema.Struct(fields)
  const stateCodec = Schema.fromJsonString(Schema.toCodecJson(stateSchema))

  const fieldEquivalences = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, Schema.toEquivalence(field)]),
  )

  const key: Key = definition.key

  const idSchema: KeySchema = Schema.isSchema(key)
    ? key
    : Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand(name))

  type Creating = P extends { readonly createdBy: infer C extends AnyCommand } ? C["tag"] : never

  type BoundedMailbox = P extends { readonly mailboxCapacity: number } ? true : false

  type PublicHandle = Handle<Api, Creating, BoundedMailbox>

  type All = Api & Internal

  type State = StateOf<Fields>

  type Owned = T[number]

  type Blobs = B[number]

  class Turn extends Context.Service<Turn, CommandContext<State, Owned, Blobs>>()(
    `durable-actors/Turn/${name}`,
  ) {}

  class Read extends Context.Service<Read, QueryContext<State, Owned, Blobs>>()(
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

    const caller = yield* Schema.decodeEffect(Caller)(as ?? (yield* CurrentCaller)).pipe(
      Effect.orDie,
    )

    const ref = ActorRef.make({
      actor: name,
      tenant: tenant ?? (yield* Tenant),
      id: isSingleton ? "singleton" : yield* Schema.decodeEffect(idSchema)(id).pipe(Effect.orDie),
    })

    const methods = Object.fromEntries(
      (includeInternal ? all : Object.values(api)).map((member) => {
        const inputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: member.input })),
        )

        const outputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: member.output })),
        )

        const errorCodec = Schema.fromJsonString(Schema.toCodecJson(Schema.Union(member.errors)))

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

              const payload = yield* Schema.encodeEffect(inputCodec)({ value: input }).pipe(
                Effect.orDie,
              )

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
                return yield* yield* Schema.decodeEffect(errorCodec)(outcome.value).pipe(
                  Effect.orDie,
                )
              }

              return (yield* Schema.decodeEffect(outputCodec)(outcome.value).pipe(Effect.orDie))
                .value
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
    const json = yield* Schema.encodeEffect(stateCodec)(current).pipe(Effect.orDie)

    if (new TextEncoder().encode(json).byteLength > policy.stateMaxBytes)
      return yield* Effect.die(new Error("State exceeds policy.maxStateBytes"))

    const encoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(json).pipe(
      Effect.orDie,
    )

    const writes: Array<readonly [string, string]> = []

    for (const key of dirty)
      writes.push([
        key,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(encoded[key] ?? null).pipe(
          Effect.orDie,
        ),
      ])

    if (dirty.size > 0 && version > 0) writes.push([VERSION_KEY, String(version)])

    return writes
  })

  // A declared failure commits only its receipt: no state rows.
  const declaredFailure = Effect.fnUntraced(function* (
    errorSchema: ValueSchema,
    error: DeclaredError["Type"],
  ) {
    if (!Schema.is(errorSchema)(error)) return yield* Effect.die(error)

    const value = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(errorSchema)),
    )(error).pipe(Effect.orDie)

    return yield* Effect.fail<BusinessResult>({
      outcome: Outcome.cases.Failure.make({ value }),
      state: [],
      complete: false,
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

        const inputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: member.input })),
        )

        const outputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: member.output })),
        )

        const errorSchema = Schema.Union(member.errors)

        commands.set(member.tag, {
          internal: internalMembers.has(member),
          run: Effect.fnUntraced(function* (
            request: Request,
            rows: ReadonlyArray<readonly [string, string]>,
          ) {
            let open = true
            const turn = Symbol()
            const dirty = new Set<string>()

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

              current = yield* Schema.decodeEffect(stateCodec)(
                yield* Schema.encodeEffect(stateCodec)({ ...current, ...patch }).pipe(Effect.orDie),
              ).pipe(Effect.orDie)
            })

            const view = { set }

            // A forked fiber inherits InsideTurn, so the turn's own fiber is checked too.
            const owner = Fiber.getCurrent()

            const escaped = (capability: string) =>
              Effect.gen(function* () {
                if (!open || (yield* InsideTurn) !== turn || Fiber.getCurrent() !== owner)
                  return yield* Effect.die(new Error(`${capability} capability escaped its turn`))
              })

            const access = yield* actors.tables(
              { ref: request.ref, placement, tables, guard: escaped("Table") },
              true,
            )

            const blob = yield* actors.blobs(
              { ref: request.ref, placement, blobs, guard: escaped("Blob") },
              true,
            )

            for (const key of Object.keys(fields)) {
              const field = key as keyof typeof current
              Object.defineProperty(view, key, { enumerable: true, get: () => current[field] })
            }

            const context: CommandContext<State, Owned, Blobs> = {
              id: request.ref.id,
              ref: request.ref,
              caller: request.caller,
              principal: principal(request.caller),
              commandId: request.commandId,
              state: Object.freeze(view) as CommandContext<State>["state"],
              rows: access.rows as CommandContext<State, Owned>["rows"],
              group: access.group,
              blob: blob as CommandContext<State, Owned, Blobs>["blob"],
            }

            const outbox = openOutbox({
              sender: request.ref,
              onBehalfOf: Option.getOrUndefined(context.principal),
            })

            return yield* Effect.gen(function* () {
              const input = yield* Schema.decodeEffect(inputCodec)(request.payload).pipe(
                Effect.orDie,
              )

              const output = yield* handle(input.value)

              const value = yield* Schema.encodeEffect(outputCodec)({ value: output }).pipe(
                Effect.orDie,
              )

              return {
                outcome: Outcome.cases.Success.make({ value }),
                state: yield* stateWrites(current, dirty),
                complete: loaded.upcast,
                outbox: outbox.close(),
              }
            }).pipe(
              Effect.catch((error) => declaredFailure(errorSchema, error)),
              Effect.ensuring(
                Effect.sync(() => {
                  open = false
                  outbox.close()
                }),
              ),
              Effect.provideService(Turn, context),
              Effect.provideService(InTurn, outbox.marker),
              Effect.provideContext(services),
              Effect.provideService(InsideTurn, turn),
            )
          }),
        })
      }

      for (const reducer of reducers) {
        const inputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: reducer.input })),
        )

        const outputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: reducer.output })),
        )

        const errorSchema = Schema.Union(reducer.errors)

        commands.set(reducer.tag, {
          internal: false,
          run: Effect.fnUntraced(function* (request, rows) {
            const loaded = yield* decodeStored(rows)

            const input = yield* Schema.decodeEffect(inputCodec)(request.payload).pipe(Effect.orDie)

            // `reduce` gets its own copy, so mutating it in place cannot hide a change.
            const given = yield* Schema.decodeEffect(stateCodec)(
              yield* Schema.encodeEffect(stateCodec)(loaded.state).pipe(Effect.orDie),
            ).pipe(Effect.orDie)

            const reduced = reducer.reduce(given, input.value)

            if (Result.isFailure(reduced))
              return yield* declaredFailure(errorSchema, reduced.failure)

            // Round-tripping validates the returned state against the actor's schema.
            const next = yield* Schema.decodeEffect(stateCodec)(
              yield* Schema.encodeEffect(stateCodec)(reduced.success).pipe(Effect.orDie),
            ).pipe(Effect.orDie)

            // Only changed keys are written, unless an upcast rewrites every key.
            const dirty = new Set(
              Object.keys(fields).filter(
                (key) => loaded.upcast || !fieldEquivalences[key]!(loaded.state[key], next[key]),
              ),
            )

            const value = yield* Schema.encodeEffect(outputCodec)({
              value: reducer.commutative === undefined ? next : undefined,
            }).pipe(Effect.orDie)

            return {
              outcome: Outcome.cases.Success.make({ value }),
              state: yield* stateWrites(next, dirty),
              complete: loaded.upcast,
              outbox: emptyOutbox,
            }
          }),
        })
      }

      yield* actors.register({
        name,
        commands,
        singleton: isSingleton,
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

        const inputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: member.input })),
        )

        const outputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: member.output })),
        )

        const errorSchema = Schema.Union(member.errors)
        const errorCodec = Schema.fromJsonString(Schema.toCodecJson(errorSchema))

        registered.set(member.tag, {
          run: Effect.fnUntraced(function* (request, rows) {
            const { state } = yield* decodeStored(rows)
            let open = true
            const query = Symbol()

            // A forked fiber inherits InsideTurn, so the query's own fiber is checked too.
            const owner = Fiber.getCurrent()

            const escaped = (capability: string) =>
              Effect.gen(function* () {
                if (!open || (yield* InsideTurn) !== query || Fiber.getCurrent() !== owner)
                  return yield* Effect.die(new Error(`${capability} capability escaped its query`))
              })

            const access = yield* actors.tables(
              { ref: request.ref, placement, tables, guard: escaped("Table") },
              false,
            )

            const blob = yield* actors.blobs(
              { ref: request.ref, placement, blobs, guard: escaped("Blob") },
              false,
            )

            const context: QueryContext<State, Owned, Blobs> = {
              id: request.ref.id,
              ref: request.ref,
              caller: request.caller,
              principal: principal(request.caller),
              state: Object.freeze(state) as Readonly<State>,
              rows: access.rows as QueryContext<State, Owned>["rows"],
              group: access.group,
              blob,
            }

            return yield* Effect.gen(function* () {
              const input = yield* Schema.decodeEffect(inputCodec)(request.payload).pipe(
                Effect.orDie,
              )

              const output = yield* handle(input.value)

              const value = yield* Schema.encodeEffect(outputCodec)({ value: output }).pipe(
                Effect.orDie,
              )

              return Outcome.cases.Success.make({ value })
            }).pipe(
              Effect.catch(
                Effect.fnUntraced(function* (error) {
                  if (!Schema.is(errorSchema)(error)) return yield* Effect.die(error)

                  const value = yield* Schema.encodeEffect(errorCodec)(error).pipe(Effect.orDie)

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
      id: isSingleton ? "singleton" : yield* Schema.decodeEffect(idSchema)(id).pipe(Effect.orDie),
    })

    const methods = Object.fromEntries(
      members.map((member) => {
        const inputCodec = Schema.fromJsonString(
          Schema.toCodecJson(Schema.Struct({ value: member.input })),
        )

        return [
          member.tag,
          (input: typeof member.input.Type) =>
            Effect.gen(function* () {
              const payload = yield* Schema.encodeEffect(inputCodec)({ value: input }).pipe(
                Effect.orDie,
              )

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
    toLayer,
    toQueryLayer,
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

  internalDefinitions.set(actor, {
    handle: (id, tenant, caller) => getHandle(id, true, caller, tenant),
  })

  return actor as typeof actor & DefinitionWithInternal<Handle<All, Creating, BoundedMailbox>>
}

export const Definition = { make, singleton }
