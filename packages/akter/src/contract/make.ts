import { Context, Effect, Result, Schema } from "effect"
import type { Layer, Scope } from "effect"
import { Registry } from "../handlers/registry.ts"
import type { Implementation, Registered } from "../handlers/registry.ts"
import { isAuthenticated } from "./caller.ts"
import type { Caller, System, User } from "./caller.ts"
import type { Fields, FindQuery, Handlers, ListKeys, PayloadOf } from "./context.ts"
import type { ActorError } from "./errors.ts"
import { Client, Handles, MemberCodec } from "./handle.ts"
import type { Handle } from "./handle.ts"
import { isList } from "./members.ts"
import type {
  Broadcast,
  Command,
  Job,
  JobFailure,
  MemberSchema,
  OptionalSchema,
  View,
} from "./members.ts"

/** The state of an actor: a struct whose encoded side is fully optional. */
export type State = Schema.Struct<Fields>

/** What `access` is asked about: the kind of request, the member and the actor id. */
export interface AccessRequest {
  readonly kind:
    | "command"
    | "state"
    | "list"
    | "view"
    | "broadcast"
    | "join"
    | "find"
    | "reauthorize"
  readonly member: string
}

/** Everything `Actor.make` learned about one actor, as one type parameter. */
export interface Def {
  readonly key: MemberSchema
  readonly state: State
  readonly commands: Record<string, Command>
  readonly views: Record<string, View>
  readonly broadcasts: Record<string, Broadcast>
  readonly jobs: Record<string, Job>
  readonly presence: OptionalSchema
  readonly caller: Caller
}

/** Any actor contract. */
export type AnyActor = Actor<any, any>

/** The definition of an actor contract. */
export type DefOf<X> = X extends Actor<any, infer D> ? D : never

/** A compile-time error carried as a required property so the compiler prints the message. */
export interface TypeError<Message extends string> {
  readonly "Akter type error": Message
}

type NoExtraHandlers<H, Expected, Name extends string> = {
  readonly [
    K in Exclude<keyof H, keyof Expected>
  ]: TypeError<`'${K & string}' is not declared in contract '${Name}'`>
}

type JobServices<H, J> = {
  [K in keyof J & keyof H]: H[K] extends (...args: any) => Effect.Effect<any, any, infer R>
    ? R
    : never
}[keyof J & keyof H]

/**
 * The layer `toLayer` returns, or a compile-time error when a job needs `Scope`. The check sits on
 * the result because a parameter type that depends on the inferred handlers defeats inference of
 * context-sensitive job handlers.
 */
type LayerOf<Name extends string, R> = [Extract<R, Scope.Scope>] extends [never]
  ? Layer.Layer<
      Implementation<Name>,
      never,
      Exclude<
        R,
        | Client
        | import("effect/workflow").WorkflowEngine.WorkflowEngine
        | import("effect/workflow").WorkflowEngine.WorkflowInstance
      >
    >
  : TypeError<"a job requires Scope: jobs get no finalizers, so close scopes inside the job with Effect.scoped">

/** An actor contract: shared with clients; `toLayer` binds its handlers on the server. */
export interface Actor<Name extends string, D extends Def> {
  readonly name: Name
  readonly key: D["key"]
  readonly state: D["state"]
  readonly commands: D["commands"]
  readonly views: D["views"]
  readonly broadcasts: D["broadcasts"]
  readonly jobs: D["jobs"]
  readonly presence: D["presence"]
  readonly access: (caller: Caller, request: AccessRequest) => boolean
  readonly implementation: Context.Service<Implementation<Name>, Registered>
  readonly "~def"?: D

  /** The one layer per actor: commands, views, jobs and presence handlers in one object. */
  toLayer<H extends Handlers<Name, D>>(
    handlers: H & NoExtraHandlers<H, Handlers<Name, D>, Name>,
  ): LayerOf<Name, JobServices<H, D["jobs"]>>

  /** A handle on one instance, over the ambient `Client`. */
  client(id: D["key"]["Type"]): Effect.Effect<Handle<Name, D>, never, Client | Scope.Scope>

  /** The ids of instances whose scalar state fields match the query. */
  find(
    query: FindQuery<D["state"]["fields"]>,
  ): Effect.Effect<ReadonlyArray<D["key"]["Type"]>, ActorError, Client>
}

type RequiredEncodedKeys<F extends Fields> = {
  [K in keyof F]: F[K] extends { readonly "~encoded.optionality": "optional" } ? never : K
}[keyof F] &
  string

type StateCheck<S extends State> = [RequiredEncodedKeys<S["fields"]>] extends [never]
  ? unknown
  : TypeError<`state field '${RequiredEncodedKeys<S["fields"]>}' needs Schema.withDecodingDefault, Schema.optional or Actor.list`>

type OnFailureCheck<J extends Record<string, Job>, A extends Record<string, Command>> = {
  readonly [K in keyof J]: J[K]["onFailure"] extends keyof A
    ? A[J[K]["onFailure"]]["internal"] extends true
      ? PayloadOf<A[J[K]["onFailure"]]["payload"]> extends JobFailure
        ? unknown
        : TypeError<`job '${K & string}': onFailure command '${J[K]["onFailure"] & string}' must take Actor.JobFailure`>
      : TypeError<`job '${K & string}': onFailure command '${J[K]["onFailure"] & string}' must be internal`>
    : TypeError<`job '${K & string}': onFailure '${J[K]["onFailure"] & string}' is not a command of this actor`>
}

type OnSuccessCheck<J extends Record<string, Job>, A extends Record<string, Command>> = {
  readonly [K in keyof J]: J[K]["onSuccess"] extends undefined
    ? unknown
    : J[K]["onSuccess"] extends keyof A
      ? A[J[K]["onSuccess"]]["internal"] extends true
        ? unknown
        : TypeError<`job '${K & string}': onSuccess command '${J[K]["onSuccess"] & string}' must be internal`>
      : TypeError<`job '${K & string}': onSuccess '${J[K]["onSuccess"] & string}' is not a command of this actor`>
}

type Reserved = "state" | "join" | "connect" | "disconnect"

type Duplicates<A, V, E, J, L> =
  | (keyof A & (keyof V | keyof E | keyof J | L | Reserved))
  | (keyof V & (keyof E | keyof J | L | Reserved))
  | (keyof E & (keyof J | L | Reserved))
  | (keyof J & (L | Reserved))
  | (L & Reserved)

type NamesCheck<A, V, E, J, L> = [Duplicates<A, V, E, J, L>] extends [never]
  ? unknown
  : TypeError<`member name '${Duplicates<A, V, E, J, L> & string}' is used twice or reserved (state, join, connect, disconnect)`>

type CallerOf<Acc> = Acc extends ((caller: any, ...rest: Array<any>) => caller is infer C)
  ? Extract<C, Caller>
  : Caller

type DefaultAccess = (caller: Caller) => caller is User | System

/** The options of `Actor.make`: only `state` and `commands` are required. */
export interface MakeOptions<
  K extends MemberSchema,
  S extends State,
  A extends Record<string, Command>,
  V extends Record<string, View>,
  E extends Record<string, Broadcast>,
  J extends Record<string, Job>,
  P extends OptionalSchema,
  Acc extends (caller: Caller, request: AccessRequest) => boolean,
> {
  readonly key?: K
  readonly state: S & StateCheck<S>
  readonly commands: A
  readonly views?: V
  readonly broadcasts?: E
  readonly jobs?: J & OnFailureCheck<J, A> & OnSuccessCheck<J, A>
  readonly presence?: P
  readonly access?: Acc
}

const reserved = new Set(["state", "join", "connect", "disconnect"])

/**
 * Refuses at runtime what the types refuse at compile time, for callers that bypass them: a state
 * field without a decoding default, a duplicate or reserved member name, and an `onFailure` or
 * `onSuccess` that is not an internal command of the same actor.
 */
const validate = (actor: AnyActor): void => {
  if (Result.isFailure(Schema.decodeResult(MemberCodec.json(actor.state))({})))
    throw new Error(
      `Actor ${actor.name}: every state field needs a decoding default, Schema.optional or Actor.list`,
    )
  const names = new Set<string>()
  const fields: Fields = actor.state.fields
  const jobs: Record<string, Job> = actor.jobs
  const commands: Record<string, Command> = actor.commands
  const lists = Object.entries(fields).flatMap(([name, field]) => (isList(field) ? [name] : []))
  for (const name of [
    ...Object.keys(actor.commands),
    ...Object.keys(actor.views),
    ...Object.keys(actor.broadcasts),
    ...Object.keys(actor.jobs),
    ...lists,
  ]) {
    if (names.has(name) || reserved.has(name))
      throw new Error(`Actor ${actor.name}: member name '${name}' is used twice or reserved`)
    names.add(name)
  }
  for (const [name, declaration] of Object.entries(jobs)) {
    const target = commands[declaration.onFailure]
    if (target === undefined || !target.internal)
      throw new Error(
        `Actor ${actor.name}: job '${name}' needs onFailure naming an internal command`,
      )
    if (declaration.onSuccess === undefined) continue
    const receiver = commands[declaration.onSuccess]
    if (receiver === undefined || !receiver.internal)
      throw new Error(
        `Actor ${actor.name}: job '${name}' needs onSuccess naming an internal command`,
      )
  }
}

/**
 * Declares an actor contract. Only `state` and `commands` are required; every other member appears
 * when used. The default `access` admits `User` and `System` callers.
 */
const make = <
  const Name extends string,
  S extends State,
  A extends Record<string, Command>,
  K extends MemberSchema = Schema.String,
  V extends Record<string, View> = {},
  E extends Record<string, Broadcast> = {},
  J extends Record<string, Job> = {},
  P extends OptionalSchema = undefined,
  Acc extends (caller: Caller, request: AccessRequest) => boolean = DefaultAccess,
>(
  name: Name,
  options: MakeOptions<K, S, A, V, E, J, P, Acc> & NamesCheck<A, V, E, J, ListKeys<S["fields"]>>,
): Actor<
  Name,
  {
    readonly key: K
    readonly state: S
    readonly commands: A
    readonly views: V
    readonly broadcasts: E
    readonly jobs: J
    readonly presence: P
    readonly caller: CallerOf<Acc>
  }
> => {
  const key: MemberSchema = options.key ?? Schema.String
  const encodeKey = Schema.encodeUnknownResult(MemberCodec.json(key))
  const decodeKey = MemberCodec.decode(key, name, "find")
  const actor: AnyActor = {
    name,
    key,
    state: options.state,
    commands: options.commands,
    views: options.views ?? {},
    broadcasts: options.broadcasts ?? {},
    jobs: options.jobs ?? {},
    presence: options.presence,
    access: options.access ?? isAuthenticated,
    implementation: Context.Service<Implementation<Name>, Registered>(`akter/actor/${name}`),
    toLayer: (handlers: Handlers<string, Def>): any => Registry.layer(actor, handlers),
    client: (id: MemberSchema["Type"]) =>
      Effect.flatMap(Client, (transport) =>
        Result.match(encodeKey(id), {
          onSuccess: (encoded) =>
            Effect.succeed(
              Handles.derive<Handle<any, any>>({ actor, id: encoded, self: false }, transport),
            ),
          onFailure: (error) => Effect.die(error),
        }),
      ),
    find: (query: FindQuery<Fields>) =>
      Effect.flatMap(Client, (transport) =>
        Effect.flatMap(transport.find({ actor, query }), (ids) => Effect.forEach(ids, decodeKey)),
      ),
  }
  validate(actor)
  return actor
}

/** The contract constructor. */
export const Contract = { make }
