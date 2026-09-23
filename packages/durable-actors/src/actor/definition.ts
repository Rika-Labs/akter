import { Context, Effect, Layer, Schema, Scope, Semaphore } from "effect"
import { type CommandContext, InsideTurn, outsideTurn } from "../contexts/command.ts"
import type { ActorError } from "../errors/actor.ts"
import {
  Actors,
  type BusinessResult,
  InternalActors,
  Outcome,
  type RegisteredCommand,
  Request,
} from "../handles/actors.ts"
import {
  ActorRef,
  Caller,
  CurrentCaller,
  Tenant,
  principal,
  type System,
} from "../identity/caller.ts"
import { CurrentCommandId } from "../identity/command.ts"
import type { AnyCommand, CommandRecord, ValueSchema } from "../members/command.ts"
import { type Policy, resolvePolicy } from "../policies/command.ts"

type StateFields = Readonly<Record<string, ValueSchema>>

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

type Values<Record extends CommandRecord> = Record[keyof Record]

export type Handle<
  Commands extends CommandRecord,
  Creating extends string = never,
  BoundedMailbox extends boolean = false,
> = {
  readonly [K in keyof Commands]: (
    ...args: Commands[K]["input"]["Type"] extends void ? [] : [input: Commands[K]["input"]["Type"]]
  ) => Effect.Effect<
    Commands[K]["output"]["Type"],
    | Commands[K]["errors"][number]["Type"]
    | ActorError.Of<
        | HandleReason
        | (BoundedMailbox extends true ? "MailboxFull" : never)
        | ([Creating] extends [never]
            ? never
            : Commands[K]["tag"] extends Creating
              ? never
              : "NotCreated")
      >
  >
} & { readonly ref: ActorRef }

export type Handlers<Commands extends CommandRecord, R> = {
  readonly [K in keyof Commands]: (
    input: Commands[K]["input"]["Type"],
  ) => Effect.Effect<Commands[K]["output"]["Type"], Commands[K]["errors"][number]["Type"], R>
}

/** `api` and `internal` keys must equal their command's tag. */
type TagsMatch<Commands extends CommandRecord> = {
  readonly [K in keyof Commands]: Commands[K] & { readonly tag: K }
}

interface Definition<
  Key,
  Fields extends StateFields,
  Api extends CommandRecord,
  Internal extends CommandRecord,
> {
  readonly key?: Key
  readonly state?: Fields
  readonly api: Api & TagsMatch<Api>
  readonly internal?: Internal & TagsMatch<Internal>
  readonly policy?: Policy<Values<Api> | Values<Internal>>
}

const make = <
  const Name extends string,
  const Api extends CommandRecord,
  const Fields extends StateFields = {},
  const Internal extends CommandRecord = {},
  const K extends Key = undefined,
  const P extends Policy<Values<Api> | Values<Internal>> = {},
>(
  name: Name,
  definition: Definition<K, Fields, Api, Internal> & { readonly key?: K; readonly policy?: P },
) => {
  Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]{0,79}$/)).make(name)
  const api: CommandRecord = definition.api
  const internal: CommandRecord = definition.internal ?? {}
  const tags = new Set<string>()

  for (const [key, member] of [...Object.entries(api), ...Object.entries(internal)]) {
    if (key !== member.tag) throw new Error(`Command key ${key} must equal its tag ${member.tag}`)

    if (tags.has(member.tag) || member.tag === "ref")
      throw new Error(`Duplicate or reserved command: ${member.tag}`)
    tags.add(member.tag)
  }

  const members = [...Object.values(api), ...Object.values(internal)]
  const internalMembers = new Set(Object.values(internal))
  const fields: StateFields = definition.state ?? {}
  const policy = resolvePolicy({ declared: definition.policy, commands: members })
  const isSingleton = Schema.is(SingletonKeySchema)(definition.key)

  if ("set" in fields) throw new Error("State key 'set' is reserved")

  const stateSchema = Schema.Struct(fields)
  const stateCodec = Schema.fromJsonString(Schema.toCodecJson(stateSchema))

  const key: Key = definition.key

  const idSchema: KeySchema = Schema.isSchema(key)
    ? key
    : Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand(name))

  type Creating = P extends { readonly createdBy: infer C extends AnyCommand } ? C["tag"] : never

  type BoundedMailbox = P extends { readonly mailboxCapacity: number } ? true : false

  type PublicHandle = Handle<Api, Creating, BoundedMailbox>

  type All = Api & Internal

  type State = StateOf<Fields>

  class Turn extends Context.Service<Turn, CommandContext<State>>()(
    `durable-actors/Turn/${name}`,
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
      (includeInternal ? members : Object.values(api)).map((member) => {
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
              const commandId = yield* identify

              const payload = yield* Schema.encodeEffect(inputCodec)({ value: input }).pipe(
                Effect.orDie,
              )

              const outcome = yield* internalActors.execute(
                Request.make({ ref, caller, command: member.tag, commandId, payload }),
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

  const register = <R>(handlers: Handlers<All, R>, services: Context.Context<R>) =>
    Effect.gen(function* () {
      const actors = yield* InternalActors
      const commands = new Map<string, RegisteredCommand>()

      for (const member of members) {
        const handle = (handlers as Record<string, Handlers<All, R>[keyof All]>)[member.tag] as (
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
        const errorCodec = Schema.fromJsonString(Schema.toCodecJson(errorSchema))

        commands.set(member.tag, {
          internal: internalMembers.has(member),
          run: Effect.fnUntraced(function* (
            request: Request,
            rows: ReadonlyArray<readonly [string, string]>,
          ) {
            let open = true
            const turn = Symbol()
            const dirty = new Set<string>()

            const stored = Object.fromEntries(
              yield* Effect.forEach(
                rows,
                Effect.fnUntraced(function* ([key, value]) {
                  return [
                    key,
                    yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(value).pipe(
                      Effect.orDie,
                    ),
                  ]
                }),
              ),
            )

            let current = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(stateSchema))(
              stored,
            ).pipe(Effect.orDie)

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

            for (const key of Object.keys(fields)) {
              const field = key as keyof typeof current
              Object.defineProperty(view, key, { enumerable: true, get: () => current[field] })
            }

            const context: CommandContext<State> = {
              id: request.ref.id,
              ref: request.ref,
              caller: request.caller,
              principal: principal(request.caller),
              commandId: request.commandId,
              state: Object.freeze(view) as CommandContext<State>["state"],
            }

            return yield* Effect.gen(function* () {
              const input = yield* Schema.decodeEffect(inputCodec)(request.payload).pipe(
                Effect.orDie,
              )

              const output = yield* handle(input.value)

              const value = yield* Schema.encodeEffect(outputCodec)({ value: output }).pipe(
                Effect.orDie,
              )

              const json = yield* Schema.encodeEffect(stateCodec)(current).pipe(Effect.orDie)

              if (new TextEncoder().encode(json).byteLength > policy.stateMaxBytes)
                return yield* Effect.die(new Error("State exceeds policy.maxStateBytes"))

              const encoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
                json,
              ).pipe(Effect.orDie)

              const writes: Array<readonly [string, string]> = []

              for (const key of dirty)
                writes.push([
                  key,
                  yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
                    encoded[key] ?? null,
                  ).pipe(Effect.orDie),
                ])

              return { outcome: Outcome.cases.Success.make({ value }), state: writes }
            }).pipe(
              Effect.catch(
                Effect.fnUntraced(function* (error) {
                  if (!Schema.is(errorSchema)(error)) return yield* Effect.die(error)

                  const value = yield* Schema.encodeEffect(errorCodec)(error).pipe(Effect.orDie)

                  return yield* Effect.fail<BusinessResult>({
                    outcome: Outcome.cases.Failure.make({ value }),
                    state: [],
                  })
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  open = false
                }),
              ),
              Effect.provideService(Turn, context),
              Effect.provideContext(services),
              Effect.provideService(InsideTurn, turn),
            )
          }),
        })
      }

      yield* actors.register({ name, commands, singleton: isSingleton, policy })
    })

  /**
   * Implements every `api` and `internal` command. The build Effect runs once
   * when the layer is built; handlers read their turn with `yield* X.Turn`.
   */
  const toLayer = <R, RB>(
    build: Effect.Effect<Handlers<All, R>, never, RB>,
  ): Layer.Layer<never, never, Exclude<R, Turn> | Exclude<RB, Scope.Scope> | InternalActors> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const handlers = yield* build
        const services = yield* Effect.context<Exclude<R, Turn>>()
        yield* register(handlers, services as Context.Context<R>)
      }),
    ) as Layer.Layer<never, never, Exclude<R, Turn> | Exclude<RB, Scope.Scope> | InternalActors>

  const create = Effect.fnUntraced(function* () {
    yield* outsideTurn

    if (definition.key !== undefined)
      return yield* Effect.die(new Error("Only minted actors use create()"))
    const internalActors = yield* InternalActors

    return yield* getHandle(yield* internalActors.mintActorId, false)
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
    toLayer,
    get: get as K extends SingletonKey
      ? () => Effect.Effect<PublicHandle, never, Actors>
      : (id: Id) => Effect.Effect<PublicHandle, never, Actors>,
    create: create as K extends undefined
      ? () => Effect.Effect<PublicHandle, never, Actors>
      : never,
  }

  internalDefinitions.set(actor, {
    handle: (id, tenant, caller) => getHandle(id, true, caller, tenant),
  })

  return actor as typeof actor & DefinitionWithInternal<Handle<All, Creating, BoundedMailbox>>
}

export const Definition = { make, singleton }
