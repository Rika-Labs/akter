import { Effect, Layer, Predicate, Schema, Semaphore } from "effect"
import {
  type CommandContext,
  type WakeContext,
  InsideTurn,
  outsideTurn,
} from "../contexts/command.ts"
import type { ActorError } from "../errors/actor.ts"
import {
  Actors,
  type BusinessResult,
  Outcome,
  type RegisteredCommand,
  Request,
} from "../handles/actors.ts"
import { ActorRef, Caller, CurrentCaller, Tenant, principal, System } from "../identity/caller.ts"
import { CurrentCommandId } from "../identity/command.ts"
import type { AnyCommand, ValueSchema } from "../members/command.ts"
import { type Policy, type CreatedBy, resolvePolicies } from "../policies/command.ts"

type StateFields = Readonly<Record<string, ValueSchema>>

type StateOf<Fields extends StateFields> = Schema.Struct<Fields>["Type"]

export interface GetOptions {
  readonly as?: Caller
  readonly tenant?: string
}

export const SystemHandle = Symbol("durable-actors/SystemHandle")

type HandleReason =
  | "ActorUnavailable"
  | "CommandConflict"
  | "CommandExpired"
  | "InvalidCommandId"
  | "Unauthorized"
  | "Timeout"

export type Handle<
  Commands extends ReadonlyArray<AnyCommand>,
  Creating extends string = never,
  BoundedMailbox extends boolean = false,
> = {
  readonly [C in Commands[number] as C["tag"]]: (
    ...args: C["input"]["Type"] extends void ? [] : [input: C["input"]["Type"]]
  ) => Effect.Effect<
    C["output"]["Type"],
    | C["errors"][number]["Type"]
    | ActorError.Of<
        | HandleReason
        | (BoundedMailbox extends true ? "MailboxFull" : never)
        | ([Creating] extends [never] ? never : C["tag"] extends Creating ? never : "NotCreated")
      >
  >
} & { readonly ref: ActorRef }

export type Handlers<Commands extends ReadonlyArray<AnyCommand>, Fields extends StateFields, R> = {
  readonly [C in Commands[number] as C["tag"]]: (
    ctx: CommandContext<StateOf<Fields>>,
    input: C["input"]["Type"],
  ) => Effect.Effect<C["output"]["Type"], C["errors"][number]["Type"], R>
}

export const Definition = {
  make: <
    const Name extends string,
    const Commands extends ReadonlyArray<AnyCommand>,
    const Fields extends StateFields = {},
    Id extends Schema.Codec<string, string> | undefined = undefined,
    const Internal extends ReadonlyArray<AnyCommand> = [],
    const Policies extends ReadonlyArray<Policy> = [],
    const Single extends boolean = false,
  >(
    name: Name,
    definition: {
      readonly commands: Commands
      readonly state?: Fields
      readonly id?: Id
      readonly singleton?: Single
      readonly internal?: Internal
      readonly lifecycle?: Policies
    },
  ) => {
    Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]{0,79}$/)).make(name)
    const tags = new Set<string>()

    const members = [...definition.commands, ...(definition.internal ?? [])]
    const fields = definition.state ?? {}
    const policies = definition.lifecycle ?? []
    const policy = resolvePolicies(policies)
    const singleton = definition.singleton === true

    if (singleton && definition.id !== undefined)
      throw new Error("Singleton actors cannot declare an id schema")

    for (const item of policies) {
      if (Predicate.isTagged(item, "CreatedBy") && !members.includes(item.command))
        throw new Error("Creation command must belong to this actor")
    }

    for (const member of members) {
      if (tags.has(member.tag) || member.tag === "ref")
        throw new Error(`Duplicate or reserved command: ${member.tag}`)
      tags.add(member.tag)
    }

    if ("set" in fields) throw new Error("State key 'set' is reserved")

    const stateSchema = Schema.Struct(fields)
    const stateCodec = Schema.fromJsonString(Schema.toCodecJson(stateSchema))
    const idSchema = definition.id ?? Schema.String.check(Schema.isUUID(7)).pipe(Schema.brand(name))

    type Creating = Extract<Policies[number], CreatedBy>["command"]["tag"]

    type BoundedMailbox =
      Extract<Policies[number], { readonly _tag: "MailboxCapacity" }> extends never ? false : true

    type PublicHandle = Handle<Commands, Creating, BoundedMailbox>

    type All = readonly [...Commands, ...Internal]

    const getHandle = Effect.fnUntraced(function* (
      id: string,
      options?: GetOptions,
      internal: boolean = false,
    ): Effect.fn.Return<Handle<All, Creating, BoundedMailbox>, never, Actors> {
      yield* outsideTurn
      const actors = yield* Actors

      const caller = yield* Schema.decodeEffect(Caller)(options?.as ?? (yield* CurrentCaller)).pipe(
        Effect.orDie,
      )

      const ref = ActorRef.make({
        actor: name,
        tenant: options?.tenant ?? (yield* Tenant),
        id: singleton ? "singleton" : yield* Schema.decodeEffect(idSchema)(id).pipe(Effect.orDie),
      })

      const methods = Object.fromEntries(
        (internal ? members : definition.commands).map((member) => {
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

                const outcome = yield* actors.execute(
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

    const toLayer = <R>(
      handlers: Handlers<All, Fields, R>,
      options?: {
        readonly hooks?: {
          readonly onDefect?: (
            ctx: WakeContext<StateOf<Fields>>,
            cause: unknown,
          ) => Effect.Effect<void, never, R>
        }
      },
    ) =>
      Layer.effectDiscard(
        Effect.gen(function* () {
          const actors = yield* Actors
          const services = yield* Effect.context<R>()
          const commands = new Map<string, RegisteredCommand>()

          for (const member of members) {
            const handle = handlers[member.tag as All[number]["tag"]] as (
              ctx: CommandContext<StateOf<Fields>>,
              input: typeof member.input.Type,
            ) => Effect.Effect<typeof member.output.Type, (typeof member.errors)[number]["Type"], R>

            const inputCodec = Schema.fromJsonString(
              Schema.toCodecJson(Schema.Struct({ value: member.input })),
            )

            const outputCodec = Schema.fromJsonString(
              Schema.toCodecJson(Schema.Struct({ value: member.output })),
            )

            const errorSchema = Schema.Union(member.errors)
            const errorCodec = Schema.fromJsonString(Schema.toCodecJson(errorSchema))

            commands.set(member.tag, {
              internal: definition.internal?.includes(member) ?? false,
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

                const set = Effect.fnUntraced(function* (patch: Partial<StateOf<Fields>>) {
                  if (!open || (yield* InsideTurn) !== turn)
                    return yield* Effect.die(new Error("State capability escaped its turn"))

                  for (const key of Object.keys(patch)) {
                    if (!(key in fields))
                      return yield* Effect.die(new Error(`Undeclared state key: ${key}`))
                    dirty.add(key)
                  }

                  current = yield* Schema.decodeEffect(stateCodec)(
                    yield* Schema.encodeEffect(stateCodec)({ ...current, ...patch }).pipe(
                      Effect.orDie,
                    ),
                  ).pipe(Effect.orDie)
                })

                const view = { set }

                for (const key of Object.keys(fields)) {
                  const field = key as keyof typeof current
                  Object.defineProperty(view, key, {
                    enumerable: true,
                    get: () => current[field],
                  })
                }

                const state = Object.freeze(view) as CommandContext<StateOf<Fields>>["state"]

                const run = Effect.gen(function* () {
                  const input = yield* Schema.decodeEffect(inputCodec)(request.payload).pipe(
                    Effect.orDie,
                  )

                  const output = yield* handle(
                    {
                      ref: request.ref,
                      caller: request.caller,
                      principal: principal(request.caller),
                      commandId: request.commandId,
                      state,
                    },
                    input.value,
                  )

                  const value = yield* Schema.encodeEffect(outputCodec)({ value: output }).pipe(
                    Effect.orDie,
                  )

                  const json = yield* Schema.encodeEffect(stateCodec)(current).pipe(Effect.orDie)

                  if (new TextEncoder().encode(json).byteLength > policy.stateMaxBytes)
                    return yield* Effect.die(new Error("State exceeds State.maxBytes"))

                  const encoded = yield* Schema.decodeEffect(
                    Schema.fromJsonString(Schema.JsonObject),
                  )(json).pipe(Effect.orDie)

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
                  Effect.provideContext(services),
                  Effect.provideService(InsideTurn, turn),
                )

                return yield* run
              }),
            })
          }

          yield* actors.register({
            name,
            commands,
            singleton,
            policy,
            onDefect: (ref, cause, rows) => {
              const state = rows.pipe(
                Effect.flatMap((values) =>
                  Schema.decodeEffect(stateCodec)(
                    `{${values.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`,
                  ),
                ),
                Effect.orDie,
              )

              const context = { ref, state } as WakeContext<StateOf<Fields>>

              return (options?.hooks?.onDefect?.(context, cause) ?? Effect.void).pipe(
                Effect.provideContext(services),
              )
            },
          })
        }),
      )

    const create = Effect.fnUntraced(function* (options?: GetOptions) {
      yield* outsideTurn

      if (definition.id !== undefined || singleton)
        return yield* Effect.die(new Error("Only minted actors use create()"))
      const actors = yield* Actors

      return yield* getHandle(yield* actors.mintActorId, options)
    })

    const get = singleton
      ? (options?: GetOptions) => getHandle("singleton", options)
      : (id: string, options?: GetOptions) => getHandle(id, options)

    return {
      name,
      state: stateSchema,
      commands: definition.commands,
      toLayer,
      get: get as Single extends true
        ? (options?: GetOptions) => Effect.Effect<PublicHandle, never, Actors>
        : (
            id: Id extends Schema.Codec<string, string>
              ? Id["Type"]
              : Schema.brand<Schema.String, Name>["Type"],
            options?: GetOptions,
          ) => Effect.Effect<PublicHandle, never, Actors>,
      create: create as Id extends undefined
        ? Single extends true
          ? never
          : (options?: GetOptions) => Effect.Effect<PublicHandle, never, Actors>
        : never,
      id: idSchema as Id extends Schema.Codec<string, string>
        ? Id
        : Schema.brand<Schema.String, Name>,
      [SystemHandle]: (id: string, caller: typeof System.Type, options?: GetOptions) =>
        getHandle(id, { ...options, as: caller }, true),
    }
  },
}
