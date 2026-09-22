import { Effect, Layer, Schema, Semaphore } from "effect"
import { type CommandContext, InsideTurn, outsideTurn } from "../contexts/command.ts"
import type { ActorError } from "../errors/actor.ts"
import {
  Actors,
  type BusinessResult,
  Outcome,
  type RegisteredCommand,
  Request,
} from "../handles/actors.ts"
import { ActorRef, Caller, CurrentCaller, Tenant } from "../identity/caller.ts"
import { CurrentCommandId } from "../identity/command.ts"
import type { AnyCommand, ValueSchema } from "../members/command.ts"

type StateFields = Readonly<Record<string, ValueSchema>>

type StateOf<Fields extends StateFields> = Schema.Struct<Fields>["Type"]

export interface GetOptions {
  readonly as?: Caller
  readonly tenant?: string
}

export type Handle<Commands extends ReadonlyArray<AnyCommand>> = {
  readonly [C in Commands[number] as C["tag"]]: (
    ...args: C["input"]["Type"] extends void ? [] : [input: C["input"]["Type"]]
  ) => Effect.Effect<C["output"]["Type"], C["errors"][number]["Type"] | ActorError>
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
    const Fields extends StateFields,
    Id extends Schema.Codec<string, string> | undefined = undefined,
  >(
    name: Name,
    definition: { readonly commands: Commands; readonly state: Fields; readonly id?: Id },
  ) => {
    Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]{0,79}$/)).make(name)
    const tags = new Set<string>()

    for (const member of definition.commands) {
      if (tags.has(member.tag) || member.tag === "ref")
        throw new Error(`Duplicate or reserved command: ${member.tag}`)
      tags.add(member.tag)
    }

    if ("set" in definition.state) throw new Error("State key 'set' is reserved")

    const stateSchema = Schema.Struct(definition.state)
    const stateCodec = Schema.fromJsonString(Schema.toCodecJson(stateSchema))
    const idSchema = definition.id ?? Schema.NonEmptyString

    const get = Effect.fnUntraced(function* (id: string, options?: GetOptions) {
      yield* outsideTurn
      const actors = yield* Actors

      const caller = yield* Schema.decodeEffect(Caller)(options?.as ?? (yield* CurrentCaller)).pipe(
        Effect.orDie,
      )

      const ref = ActorRef.make({
        actor: name,
        tenant: options?.tenant ?? (yield* Tenant),
        id: yield* Schema.decodeEffect(idSchema)(id).pipe(Effect.orDie),
      })

      const methods = Object.fromEntries(
        definition.commands.map((member) => {
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

      // SAFETY: each declared tag is installed exactly once with its own input/output/error codecs.
      return { ...methods, ref } as Handle<Commands>
    })

    const toLayer = <R>(handlers: Handlers<Commands, Fields, R>) =>
      Layer.effectDiscard(
        Effect.gen(function* () {
          const actors = yield* Actors
          const services = yield* Effect.context<R>()
          const commands = new Map<string, RegisteredCommand>()

          for (const member of definition.commands) {
            // SAFETY: toLayer's mapped type requires the handler for this declared command and state.
            const handle = handlers[member.tag as Commands[number]["tag"]] as (
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
              run: Effect.fnUntraced(
                function* (request: Request, rows: ReadonlyArray<readonly [string, string]>) {
                  let open = true
                  const turn = Symbol()
                  const dirty = new Set<string>()

                  const stored = Object.fromEntries(
                    yield* Effect.forEach(
                      rows,
                      Effect.fnUntraced(function* ([key, value]) {
                        return [
                          key,
                          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
                            value,
                          ).pipe(Effect.orDie),
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
                      if (!(key in definition.state))
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

                  for (const key of Object.keys(definition.state)) {
                    // SAFETY: keys come from the same fields used to decode current.
                    const field = key as keyof typeof current
                    Object.defineProperty(view, key, {
                      enumerable: true,
                      get: () => current[field],
                    })
                  }

                  // SAFETY: the getters above expose every decoded state field and set is the sole mutation capability.
                  const state = Object.freeze(view) as CommandContext<StateOf<Fields>>["state"]

                  const run = Effect.gen(function* () {
                    const input = yield* Schema.decodeEffect(inputCodec)(request.payload).pipe(
                      Effect.orDie,
                    )

                    const output = yield* handle(
                      {
                        ref: request.ref,
                        caller: request.caller,
                        commandId: request.commandId,
                        state,
                      },
                      input.value,
                    )

                    const value = yield* Schema.encodeEffect(outputCodec)({ value: output }).pipe(
                      Effect.orDie,
                    )

                    const encoded = yield* Schema.decodeEffect(
                      Schema.fromJsonString(Schema.JsonObject),
                    )(yield* Schema.encodeEffect(stateCodec)(current).pipe(Effect.orDie)).pipe(
                      Effect.orDie,
                    )

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

                        const value = yield* Schema.encodeEffect(errorCodec)(error).pipe(
                          Effect.orDie,
                        )

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
                },
                Effect.catchDefect((cause) =>
                  Effect.fail<BusinessResult>({
                    outcome: Outcome.cases.Defect.make({ cause }),
                    state: [],
                  }),
                ),
              ),
            })
          }

          yield* actors.register({ name, commands })
        }),
      )

    const create = Effect.fnUntraced(function* (options?: GetOptions) {
      yield* outsideTurn

      if (definition.id !== undefined)
        return yield* Effect.die(new Error("Named actors use get(id)"))
      const actors = yield* Actors

      return yield* get(yield* actors.mintActorId, options)
    })

    return { name, state: stateSchema, commands: definition.commands, get, create, toLayer }
  },
}
