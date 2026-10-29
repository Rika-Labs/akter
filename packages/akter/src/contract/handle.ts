import { Context, Effect, JsonPatch, Result, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { ActorError, CommandDefect, InvalidInput } from "./errors.ts"
import type { Args, ClientState, FindQuery, Fields, ListKeys, ListTypes } from "./context.ts"
import type { AnyActor, Def } from "./make.ts"
import { isList } from "./members.ts"
import type {
  Broadcast,
  Command,
  List,
  MemberSchema,
  OptionalSchema,
  RangeOptions,
  View,
} from "./members.ts"

/** A call's reply as the transport carries it: the encoded success value or declared failure. */
export type Reply =
  | { readonly kind: "Success"; readonly value: Schema.Json }
  | { readonly kind: "Failure"; readonly error: Schema.Json }

/** One frame of a `state` stream: the full encoded state first, then JSON patches. */
export type StateFrame =
  | { readonly kind: "Frame"; readonly version: number; readonly value: Schema.Json }
  | { readonly kind: "Patch"; readonly version: number; readonly ops: JsonPatch.JsonPatch }

/** Names one actor instance: its contract and its encoded key. */
export interface Target {
  readonly actor: AnyActor
  readonly id: Schema.Json
}

/** A call to one command. */
export interface CallRequest extends Target {
  readonly member: string
  readonly payload: Schema.Json
}

/** A read of one member (a view, a broadcast or a list). */
export interface MemberRequest extends Target {
  readonly member: string
  readonly params: Schema.Json
}

/** A value a list orders by. */
export const ByValue = Schema.Union([Schema.String, Schema.Finite])

/** A value a list orders by. */
export type ByValue = typeof ByValue.Type

/** A range read of one list. */
export interface RangeRequest extends Target {
  readonly member: string
  readonly range: RangeOptions<ByValue>
}

/** A presence join. */
export interface JoinRequest extends Target {
  readonly presence: Schema.Json
}

/** A `find` over one actor type. */
export interface FindRequest {
  readonly actor: AnyActor
  readonly query: FindQuery<Fields>
}

/**
 * What a handle is derived from, in encoded values. The engine implements it in process; the
 * `/rpc` client implements it over the wire. A defect reaches the caller as a `CommandDefect`.
 */
export interface Transport {
  call(request: CallRequest): Effect.Effect<Reply, ActorError>
  state(request: Target): Stream.Stream<StateFrame, ActorError>
  view(request: MemberRequest): Stream.Stream<Schema.Json, ActorError>
  broadcast(request: MemberRequest): Stream.Stream<Schema.Json, ActorError>
  range(request: RangeRequest): Effect.Effect<ReadonlyArray<Schema.Json>, ActorError>
  watch(request: RangeRequest): Stream.Stream<ReadonlyArray<Schema.Json>, ActorError>
  join(request: JoinRequest): Effect.Effect<void, ActorError, Scope.Scope>
  find(request: FindRequest): Effect.Effect<ReadonlyArray<Schema.Json>, ActorError>
}

/** The connection handles talk through: the in-process engine, a job, or the `/rpc` client. */
export class Client extends Context.Service<Client, Transport>()(
  "@rikalabs/akter/contract/handle/Client",
) {}

type SuccessType<A extends Command> = A["success"] extends MemberSchema
  ? A["success"]["Type"]
  : void
type FailsType<A extends Command> = A["fails"] extends MemberSchema ? A["fails"]["Type"] : never

type PublicCommands<D extends Def> = {
  [A in keyof D["commands"]]: D["commands"][A]["internal"] extends true ? never : A
}[keyof D["commands"]]

type CommandMethods<D extends Def, Keys extends keyof D["commands"]> = {
  readonly [A in Keys]: (
    ...args: Args<D["commands"][A]["payload"]>
  ) => Effect.Effect<SuccessType<D["commands"][A]>, FailsType<D["commands"][A]> | ActorError>
}

/** A list on a client handle: a one-shot window and a watched one. */
export interface ListHandle<Item, By> {
  range(options?: RangeOptions<By>): Effect.Effect<ReadonlyArray<Item>, ActorError>
  watch(options?: RangeOptions<By>): Stream.Stream<ReadonlyArray<Item>, ActorError>
}

type Reads<D extends Def> = {
  readonly [L in ListKeys<D["state"]["fields"]>]: D["state"]["fields"][L] extends List
    ? ListHandle<
        ListTypes<D["state"]["fields"][L]>["item"],
        ListTypes<D["state"]["fields"][L]>["by"]
      >
    : never
} & {
  readonly [V in keyof D["views"]]: (
    ...args: Args<D["views"][V]["params"]>
  ) => Stream.Stream<D["views"][V]["success"]["Type"], ActorError>
} & {
  readonly [E in keyof D["broadcasts"]]: Stream.Stream<
    D["broadcasts"][E]["schema"]["Type"],
    ActorError
  >
} & {
  readonly state: Stream.Stream<ClientState<D["state"]["fields"]>, ActorError>
} & (D["presence"] extends MemberSchema
    ? { join(presence: D["presence"]["Type"]): Effect.Effect<void, ActorError, Scope.Scope> }
    : {})

/** The client handle of one actor instance: public commands, lists, views, broadcasts, state, `join`. */
export type Handle<Name extends string, D extends Def> = CommandMethods<D, PublicCommands<D>> &
  Reads<D> & { readonly "~name"?: Name }

/** A job's `self`: the handle with internal commands included. */
export type SelfHandle<Name extends string, D extends Def> = CommandMethods<
  D,
  keyof D["commands"]
> &
  Reads<D> & { readonly "~name"?: Name }

/** The JSON codec of any member schema. */
export type JsonCodec = Schema.toCodecJson<MemberSchema>

const codecs = new WeakMap<MemberSchema, JsonCodec>()

/** The JSON codec of a member schema, cached per schema. */
const json = (schema: MemberSchema): JsonCodec => {
  const cached = codecs.get(schema)
  if (cached !== undefined) return cached
  const codec = Schema.toCodecJson(schema)
  codecs.set(schema, codec)
  return codec
}

/**
 * Member values to and from JSON. Input that does not encode fails with `InvalidInput`; a value the
 * engine produced that does not decode is a defect.
 */
export const MemberCodec = {
  json,
  encode: (
    schema: OptionalSchema,
  ): ((value: MemberSchema["Type"]) => Effect.Effect<Schema.Json, ActorError>) => {
    if (schema === undefined) return () => Effect.succeed(null)
    const encode = Schema.encodeUnknownResult(json(schema))
    return (value) =>
      Result.match(encode(value), {
        onSuccess: Effect.succeed,
        onFailure: (error) =>
          Effect.fail(
            ActorError.make({
              reason: InvalidInput.make({
                code: "decode",
                issues: [{ path: "", message: error.message }],
              }),
            }),
          ),
      })
  },
  decode: <S extends MemberSchema>(
    schema: S | undefined,
    actor: string,
    member: string,
  ): ((value: Schema.Json) => Effect.Effect<S["Type"]>) => {
    if (schema === undefined) return () => Effect.void
    const decode = Schema.decodeResult(json(schema))
    return (value) =>
      Result.match(decode(value), {
        onSuccess: Effect.succeed,
        onFailure: (error) =>
          Effect.die(
            CommandDefect.make({ kind: "DecodeFailure", actor, member, detail: error.message }),
          ),
      })
  },
}

const clientStateSchemas = new WeakMap<AnyActor, MemberSchema>()

/** The client's `state` frame schema: every state field except lists. */
export const clientStateSchema = (actor: AnyActor): MemberSchema => {
  const cached = clientStateSchemas.get(actor)
  if (cached !== undefined) return cached
  const fields: Record<string, MemberSchema> = {}
  const declared: Fields = actor.state.fields
  for (const [name, field] of Object.entries(declared)) {
    if (!isList(field)) fields[name] = field
  }
  const schema = Schema.Struct(fields)
  clientStateSchemas.set(actor, schema)
  return schema
}

/** Derives one handle; `self` includes internal commands. A new owner's full state frame resets its version clock before schema-equivalent values are suppressed. */
const derive = <H>(target: Target & { readonly self: boolean }, transport: Transport): H => {
  const { actor, id } = target
  const handle = new Map<
    string,
    Function | Stream.Stream<MemberSchema["Type"], ActorError> | object
  >()
  const commands: Record<string, Command> = actor.commands
  const fields: Fields = actor.state.fields
  const views: Record<string, View> = actor.views
  const broadcasts: Record<string, Broadcast> = actor.broadcasts
  for (const [member, declaration] of Object.entries(commands)) {
    if (declaration.internal && !target.self) continue
    const encode = MemberCodec.encode(declaration.payload)
    const decodeSuccess = MemberCodec.decode(declaration.success, actor.name, member)
    const decodeFailure = MemberCodec.decode(declaration.fails, actor.name, member)
    handle.set(member, (payload?: MemberSchema["Type"]) =>
      encode(payload).pipe(
        Effect.flatMap((encoded) => transport.call({ actor, id, member, payload: encoded })),
        Effect.flatMap((reply) =>
          reply.kind === "Success"
            ? decodeSuccess(reply.value)
            : Effect.flatMap(decodeFailure(reply.error), Effect.fail),
        ),
      ),
    )
  }
  for (const [member, field] of Object.entries(fields)) {
    if (!isList(field)) continue
    const decodeItem = MemberCodec.decode(field.item, actor.name, member)
    const window = (
      options: RangeOptions<MemberSchema["Type"]> | undefined,
    ): RangeOptions<ByValue> => ({
      from: Schema.is(ByValue)(options?.from) ? options.from : undefined,
      to: Schema.is(ByValue)(options?.to) ? options.to : undefined,
      limit: options?.limit,
      reverse: options?.reverse,
    })
    const decodeItems = (items: ReadonlyArray<Schema.Json>) => Effect.forEach(items, decodeItem)
    handle.set(member, {
      range: (options?: RangeOptions<MemberSchema["Type"]>) =>
        Effect.flatMap(transport.range({ actor, id, member, range: window(options) }), decodeItems),
      watch: (options?: RangeOptions<MemberSchema["Type"]>) =>
        transport
          .watch({ actor, id, member, range: window(options) })
          .pipe(Stream.mapEffect(decodeItems)),
    })
  }
  for (const [member, declaration] of Object.entries(views)) {
    const encode = MemberCodec.encode(declaration.params)
    const decode = MemberCodec.decode(declaration.success, actor.name, member)
    handle.set(member, (params?: MemberSchema["Type"]) =>
      Stream.unwrap(
        Effect.map(encode(params), (encoded) =>
          transport.view({ actor, id, member, params: encoded }).pipe(Stream.mapEffect(decode)),
        ),
      ),
    )
  }
  for (const [member, declaration] of Object.entries(broadcasts)) {
    const decode = MemberCodec.decode(declaration.schema, actor.name, member)
    handle.set(
      member,
      transport.broadcast({ actor, id, member, params: null }).pipe(Stream.mapEffect(decode)),
    )
  }
  const decodeState = MemberCodec.decode(clientStateSchema(actor), actor.name, "state")
  handle.set(
    "state",
    Stream.suspend(() => {
      let current: Schema.Json = null
      let version = -1
      return transport.state({ actor, id }).pipe(
        Stream.filter((frame) => frame.kind === "Frame" || frame.version > version),
        Stream.mapEffect((frame) => {
          version = frame.version
          current = frame.kind === "Frame" ? frame.value : JsonPatch.apply(frame.ops, current)
          return decodeState(current)
        }),
        Stream.changesWith(Schema.toEquivalence(clientStateSchema(actor))),
      )
    }),
  )
  if (actor.presence !== undefined) {
    const encode = MemberCodec.encode(actor.presence)
    handle.set("join", (presence: MemberSchema["Type"]) =>
      Effect.flatMap(encode(presence), (encoded) =>
        transport.join({ actor, id, presence: encoded }),
      ),
    )
  }
  return Object.fromEntries(handle) as H
}

/** Derives handles from a contract over a transport; the same derivation the `/rpc` client uses. */
export const Handles = { derive }
