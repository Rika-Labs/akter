import { DateTime, Effect, Predicate, Result, Schema, SchemaTransformation } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import type { Bounds, Fields, FindQuery } from "../contract/context.ts"
import { ActorError, InvalidInput, Reason } from "../contract/errors.ts"
import { ByValue, MemberCodec } from "../contract/handle.ts"
import type { AnyActor } from "../contract/make.ts"
import { isList } from "../contract/members.ts"
import type { Action, MemberSchema } from "../contract/members.ts"

/**
 * `ActorError` as it travels: the reason with its fields, `isRetryable` and `retryAfter` in
 * milliseconds. The retry metadata is derived from the reason on both sides, so a peer cannot
 * make a refusal retryable by editing it.
 */
export const ErrorEnvelope = Schema.TaggedStruct("ActorError", {
  reason: Reason,
  isRetryable: Schema.Boolean,
  retryAfter: Schema.optionalKey(Schema.Finite),
}).pipe(
  Schema.decodeTo(
    ActorError,
    SchemaTransformation.transform({
      decode: (wire) => ({ _tag: "ActorError" as const, reason: wire.reason }),
      encode: (encoded) => {
        const error = ActorError.make({ reason: encoded.reason })
        const retryAfter = error.retryAfter
        if (retryAfter === undefined)
          return {
            _tag: "ActorError" as const,
            reason: encoded.reason,
            isRetryable: error.isRetryable,
          }
        return {
          _tag: "ActorError" as const,
          reason: encoded.reason,
          isRetryable: error.isRetryable,
          retryAfter,
        }
      },
    }),
  ),
)

/** An action call: the actor id, the client-minted command id and the encoded payload. */
export const ActionPayload = Schema.Struct({
  id: Schema.Json,
  commandId: Schema.String,
  payload: Schema.Json,
})

/** An action's success: the encoded reply and whether admission returned a stored outcome. */
export const ActionSuccess = Schema.Struct({ value: Schema.Json, replayed: Schema.Boolean })

/**
 * An action's declared failure, in the declared error's own encoding, with the same `replayed`
 * flag a success carries.
 */
export const ActionFailed = Schema.TaggedStruct("ActionFailed", {
  error: Schema.Json,
  replayed: Schema.Boolean,
})

/** What an action call can fail with on the wire. */
export const ActionError = Schema.Union([ErrorEnvelope, ActionFailed])

/** A read of one actor instance. */
export const TargetPayload = Schema.Struct({ id: Schema.Json })

/** A view read: the actor id and the view's encoded parameters. */
export const ViewPayload = Schema.Struct({ id: Schema.Json, params: Schema.Json })

/** A list window: the actor id and the range options. */
export const RangePayload = Schema.Struct({
  id: Schema.Json,
  from: Schema.optional(ByValue),
  to: Schema.optional(ByValue),
  limit: Schema.optional(Schema.Int),
  reverse: Schema.optional(Schema.Boolean),
})

/** A presence join: the actor id and the encoded presence value. */
export const JoinPayload = Schema.Struct({ id: Schema.Json, presence: Schema.Json })

/** One encoded condition of a `find`: equality, or range bounds. */
export const Condition = Schema.Union([
  Schema.Struct({ eq: Schema.Json }),
  Schema.Struct({
    gt: Schema.optionalKey(Schema.Json),
    gte: Schema.optionalKey(Schema.Json),
    lt: Schema.optionalKey(Schema.Json),
    lte: Schema.optionalKey(Schema.Json),
    in: Schema.optionalKey(Schema.Array(Schema.Json)),
  }),
])

/** A `find` query with every condition encoded by its field's schema. */
export const FindPayload = Schema.Struct({
  where: Schema.Record(Schema.String, Condition),
  orderBy: Schema.optionalKey(
    Schema.Struct({
      field: Schema.String,
      direction: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
    }),
  ),
  limit: Schema.optionalKey(Schema.Int),
})

const PatchOperation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add"),
    path: Schema.String,
    value: Schema.Json,
    description: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    path: Schema.String,
    description: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("replace"),
    path: Schema.String,
    value: Schema.Json,
    description: Schema.optionalKey(Schema.String),
  }),
])

/** One element of a state, list or view stream: the full value first, JSON patches after. */
export const Frame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Frame"), version: Schema.Finite, value: Schema.Json }),
  Schema.Struct({
    kind: Schema.Literal("Patch"),
    version: Schema.Finite,
    ops: Schema.Array(PatchOperation),
  }),
])

/** One element of a state, list or view stream. */
export type Frame = typeof Frame.Type

/** The one element a `join` stream sends once `connect` is durable; the stream then stays open. */
export const Joined = Schema.Literal("joined")

/** The session's fresh credential, in the `authorization` header's form. */
export const ReauthenticatePayload = Schema.Struct({ authorization: Schema.String })

/**
 * The tag of each call. An action is `<Actor>/<action>`; every other call puts a `$` before its
 * kind, which application members never start with, so a proxy classifies a call by its tag
 * alone. Action spans are then named `akter.<Actor>/<action>`.
 */
export const Tags = {
  action: (actor: string, member: string) => `${actor}/${member}`,
  state: (actor: string) => `${actor}/$state`,
  range: (actor: string, list: string) => `${actor}/$range:${list}`,
  watch: (actor: string, list: string) => `${actor}/$watch:${list}`,
  view: (actor: string, view: string) => `${actor}/$view:${view}`,
  event: (actor: string, event: string) => `${actor}/$event:${event}`,
  join: (actor: string) => `${actor}/$join`,
  find: (actor: string) => `${actor}/$find`,
  reauthenticate: "$reauthenticate",
}

/**
 * What a call does, from its tag alone: `action` writes, `presence` writes `connect` and
 * `disconnect`, `read` only reads durable state, and `session` renews the socket's credential.
 */
export type CallClass = "action" | "presence" | "read" | "session"

/** Classifies a call by its tag, as an edge does before forwarding it. */
export const classify = (tag: string): CallClass => {
  if (tag === Tags.reauthenticate) return "session"
  const member = tag.slice(tag.lastIndexOf("/") + 1)
  if (!member.startsWith("$")) return "action"
  return member === "$join" ? "presence" : "read"
}

/** Spans are named for the call with this prefix: `akter.<Actor>/<action>`. */
export const SPAN_PREFIX = "akter"

const checkName = (kind: string, name: string): void => {
  if (name.length === 0 || name.includes("/") || name.startsWith("$"))
    throw new Error(
      `${kind} '${name}' cannot be served on /rpc: names must be non-empty, without '/', and not start with '$'`,
    )
}

const actionRpc = (tag: string) =>
  Rpc.make(tag, { payload: ActionPayload, success: ActionSuccess, error: ActionError })

const frameRpc = <P extends typeof TargetPayload | typeof RangePayload | typeof ViewPayload>(
  tag: string,
  payload: P,
) => Rpc.make(tag, { payload, success: Frame, error: ErrorEnvelope, stream: true })

const itemsRpc = <P extends typeof RangePayload | typeof FindPayload>(tag: string, payload: P) =>
  Rpc.make(tag, { payload, success: Schema.Array(Schema.Json), error: ErrorEnvelope })

const eventRpc = (tag: string) =>
  Rpc.make(tag, {
    payload: TargetPayload,
    success: Schema.Json,
    error: ErrorEnvelope,
    stream: true,
  })

const joinRpc = (tag: string) =>
  Rpc.make(tag, { payload: JoinPayload, success: Joined, error: ErrorEnvelope, stream: true })

const reauthenticateRpc = Rpc.make(Tags.reauthenticate, {
  payload: ReauthenticatePayload,
  error: ErrorEnvelope,
})

/** Any call of the group, by its kind's schemas; tags are only known once actors are. */
export type GroupRpc =
  | ReturnType<typeof actionRpc>
  | ReturnType<typeof frameRpc<typeof TargetPayload>>
  | ReturnType<typeof frameRpc<typeof RangePayload>>
  | ReturnType<typeof frameRpc<typeof ViewPayload>>
  | ReturnType<typeof itemsRpc<typeof RangePayload>>
  | ReturnType<typeof itemsRpc<typeof FindPayload>>
  | ReturnType<typeof eventRpc>
  | ReturnType<typeof joinRpc>
  | typeof reauthenticateRpc

/** Every call one actor serves: public actions, state, lists, views, events, `join` and `find`. */
const rpcsOf = (actor: AnyActor): Array<GroupRpc> => {
  checkName("Actor", actor.name)
  const name = actor.name
  const rpcs: Array<GroupRpc> = [
    frameRpc(Tags.state(name), TargetPayload),
    itemsRpc(Tags.find(name), FindPayload),
  ]
  const actions: Record<string, Action> = actor.actions
  for (const [member, action] of Object.entries(actions)) {
    if (action.internal) continue
    checkName("Action", member)
    rpcs.push(actionRpc(Tags.action(name, member)))
  }
  const fields: Fields = actor.state.fields
  for (const [member, field] of Object.entries(fields)) {
    if (!isList(field)) continue
    checkName("List", member)
    rpcs.push(
      itemsRpc(Tags.range(name, member), RangePayload),
      frameRpc(Tags.watch(name, member), RangePayload),
    )
  }
  for (const member of Object.keys(actor.views)) {
    checkName("View", member)
    rpcs.push(frameRpc(Tags.view(name, member), ViewPayload))
  }
  for (const member of Object.keys(actor.events)) {
    checkName("Event", member)
    rpcs.push(eventRpc(Tags.event(name, member)))
  }
  if (actor.presence !== undefined) rpcs.push(joinRpc(Tags.join(name)))
  return rpcs
}

/**
 * The one RPC group of a set of actor contracts, served at `/rpc` and called by the client. Its
 * payloads are JSON and member values are checked against the contract by the engine, so a bad
 * payload is `InvalidInput`, never a protocol defect. Throws when two actors share a name or a
 * name cannot appear in a tag.
 */
export const groupOf = (actors: ReadonlyArray<AnyActor>) => {
  const names = new Set<string>()
  const rpcs: Array<GroupRpc> = [reauthenticateRpc]
  for (const actor of actors) {
    if (names.has(actor.name)) throw new Error(`Actor '${actor.name}' is declared twice`)
    names.add(actor.name)
    rpcs.push(...rpcsOf(actor))
  }
  return RpcGroup.make(...rpcs)
}

const invalidQuery = (path: string, message: string): ActorError =>
  ActorError.make({
    reason: InvalidInput.make({ code: "decode", issues: [{ path, message }] }),
  })

const scalarField = (actor: AnyActor, field: string): MemberSchema | undefined => {
  const fields: Fields = actor.state.fields
  const schema = fields[field]
  return schema === undefined || isList(schema) ? undefined : schema
}

const isBounds = (condition: unknown): condition is Bounds<MemberSchema["Type"]> =>
  Predicate.isObject(condition) && !DateTime.isDateTime(condition) && !Array.isArray(condition)

/** `T` with its properties assignable, for building a value field by field. */
type Writable<T> = { -readonly [K in keyof T]: T[K] }

/** A `find` query's conditions encoded by their fields' schemas, for the wire. */
const encodeQuery = (
  actor: AnyActor,
  query: FindQuery<Fields>,
): Effect.Effect<typeof FindPayload.Type, ActorError> =>
  Effect.gen(function* () {
    const where: Record<string, typeof Condition.Type> = {}
    for (const [field, condition] of Object.entries(query.where ?? {})) {
      const schema = scalarField(actor, field)
      if (schema === undefined) return yield* invalidQuery(field, "not a scalar state field")
      const encode = MemberCodec.encode(schema)
      if (!isBounds(condition)) {
        where[field] = { eq: yield* encode(condition) }
        continue
      }
      const bounds: Bounds<MemberSchema["Type"]> = condition
      const encoded: { -readonly [K in "gt" | "gte" | "lt" | "lte"]?: Schema.Json } & {
        in?: ReadonlyArray<Schema.Json>
      } = {}
      for (const key of ["gt", "gte", "lt", "lte"] as const) {
        const value = bounds[key]
        if (value !== undefined) encoded[key] = yield* encode(value)
      }
      if (bounds.in !== undefined) encoded.in = yield* Effect.forEach(bounds.in, encode)
      where[field] = encoded
    }
    const payload: Writable<typeof FindPayload.Type> = { where }
    if (query.orderBy !== undefined) payload.orderBy = query.orderBy
    if (query.limit !== undefined) payload.limit = query.limit
    return payload
  })

/** Decodes a `find` query from the wire against the actor's state fields. */
const decodeQuery = (
  actor: AnyActor,
  payload: typeof FindPayload.Type,
): Effect.Effect<FindQuery<Fields>, ActorError> =>
  Effect.gen(function* () {
    const where: Record<string, MemberSchema["Type"]> = {}
    for (const [field, condition] of Object.entries(payload.where)) {
      const schema = scalarField(actor, field)
      if (schema === undefined) return yield* invalidQuery(field, "not a scalar state field")
      const decode = Schema.decodeResult(MemberCodec.json(schema))
      const value = (encoded: Schema.Json) =>
        Result.match(decode(encoded), {
          onSuccess: Effect.succeed,
          onFailure: (error) => Effect.fail(invalidQuery(field, error.message)),
        })
      if ("eq" in condition) {
        where[field] = yield* value(condition.eq)
        continue
      }
      const bounds: {
        -readonly [K in keyof Bounds<MemberSchema["Type"]>]: Bounds<MemberSchema["Type"]>[K]
      } = {}
      for (const key of ["gt", "gte", "lt", "lte"] as const) {
        const encoded = condition[key]
        if (encoded !== undefined) bounds[key] = yield* value(encoded)
      }
      if (condition.in !== undefined) bounds.in = yield* Effect.forEach(condition.in, value)
      where[field] = bounds
    }
    if (payload.orderBy !== undefined && scalarField(actor, payload.orderBy.field) === undefined)
      return yield* invalidQuery(payload.orderBy.field, "not a scalar state field")
    if (payload.limit !== undefined && (payload.limit < 0 || payload.limit > 1_000))
      return yield* invalidQuery("limit", "must be between 0 and 1000")
    const query: Writable<FindQuery<Fields>> = { where }
    if (payload.orderBy !== undefined)
      query.orderBy = {
        field: payload.orderBy.field as never,
        direction: payload.orderBy.direction,
      }
    if (payload.limit !== undefined) query.limit = payload.limit
    return query
  })

/** `find` queries to and from the wire. */
export const FindCodec = { encode: encodeQuery, decode: decodeQuery }
