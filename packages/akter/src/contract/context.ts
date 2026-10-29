import type { DateTime, Duration, Effect, Schema, Types } from "effect"
import type { Caller, System } from "./caller.ts"
import type { SelfHandle } from "./handle.ts"
import type { Actor, AnyActor, Def, DefOf } from "./make.ts"
import type {
  Broadcast,
  Command,
  Job,
  List,
  ListDraft,
  ListReader,
  MemberSchema,
  OptionalSchema,
  View,
} from "./members.ts"

/** The state struct's fields. */
export type Fields = { readonly [name: string]: MemberSchema }

/** A member's decoded payload, or `undefined` for a member without one. */
export type PayloadOf<P extends OptionalSchema> = P extends Schema.Top ? P["Type"] : undefined

/** The arguments a call passes for a member's payload: none when it has no schema. */
export type Args<P extends OptionalSchema> = P extends Schema.Top ? [payload: P["Type"]] : []

type ItemOf<L extends List> = L["item"]["Type"]
type ListKey<L extends List> = ItemOf<L>[L["keyField"] & keyof ItemOf<L>]
type ListBy<L extends List> = ItemOf<L>[L["byField"] & keyof ItemOf<L>]

/** The item, key and order types of a list field. */
export interface ListTypes<L extends List> {
  readonly item: ItemOf<L>
  readonly key: ListKey<L>
  readonly by: ListBy<L>
}

/** Keys of `Schema.optional` state fields: optional keys of the draft and of client state. */
export type OptionalKeys<F extends Fields> = {
  [K in keyof F]: F[K] extends { readonly "~type.optionality": "optional" } ? K : never
}[keyof F]

/** Keys of list fields. */
export type ListKeys<F extends Fields> = {
  [K in keyof F]: F[K] extends List ? K : never
}[keyof F]

type DraftField<S> = S extends List
  ? ListDraft<ItemOf<S>, ListKey<S>, ListBy<S>>
  : S extends Schema.Top
    ? Types.DeepMutable<S["Type"]>
    : never

type ReadField<S> = S extends List
  ? ListReader<ItemOf<S>, ListKey<S>, ListBy<S>>
  : S extends Schema.Top
    ? S["Type"]
    : never

/**
 * The state a command handler changes: deep-mutable fields, each list as its draft API.
 * `Schema.optional` fields are optional keys, so `delete draft.field` compiles for them only.
 */
export type Draft<F extends Fields> = {
  -readonly [K in Exclude<keyof F, OptionalKeys<F>>]: DraftField<F[K]>
} & { -readonly [K in OptionalKeys<F>]?: DraftField<F[K]> }

/** The state a view handler reads. */
export type ReadState<F extends Fields> = {
  readonly [K in Exclude<keyof F, OptionalKeys<F>>]: ReadField<F[K]>
} & { readonly [K in OptionalKeys<F>]?: ReadField<F[K]> }

/** The state frame a client receives: every field except lists. */
export type ClientState<F extends Fields> = {
  readonly [K in Exclude<keyof F, ListKeys<F> | OptionalKeys<F>>]: F[K]["Type"]
} & { readonly [K in Exclude<OptionalKeys<F>, ListKeys<F>>]?: F[K]["Type"] }

/** What `Simulation.state` returns: client state plus each list's items in `by` order. */
export type FullState<F extends Fields> = ClientState<F> & {
  readonly [K in ListKeys<F>]: F[K] extends List ? ReadonlyArray<ItemOf<F[K]>> : never
}

/** The staged-call surface of `send` and `schedule`: one method per target command, fire-and-forget. */
export type Sender<X> = {
  readonly [A in keyof DefOf<X>["commands"]]: (
    ...args: Args<DefOf<X>["commands"][A]["payload"]>
  ) => void
}

/** `ctx.start`: one method per job, staging a start. */
export type Starters<J extends Record<string, Job>> = {
  readonly [K in keyof J]: (
    ...args: [...Args<J[K]["payload"]>, options?: { readonly key?: string }]
  ) => void
}

/** `ctx.broadcast` in commands: stages a broadcast for publication after durability. */
export type Broadcasters<E extends Record<string, Broadcast>> = {
  readonly [K in keyof E]: (value: E[K]["schema"]["Type"]) => void
}

/** `broadcast` in jobs: publishes at once. */
export type JobBroadcasters<E extends Record<string, Broadcast>> = {
  readonly [K in keyof E]: (value: E[K]["schema"]["Type"]) => Effect.Effect<void>
}

/** When a scheduled command runs: after a delay, or at an epoch-millisecond instant. */
export type When = Duration.Input | { readonly at: number }

/** The capabilities of a command handler; nothing else is reachable from a command. */
export interface CommandContext<Name extends string, D extends Def, C extends Caller> {
  readonly caller: C
  readonly self: D["key"]["Type"]
  readonly id: () => string
  readonly now: () => number
  readonly random: () => number
  readonly send: <X extends AnyActor>(target: X, id: DefOf<X>["key"]["Type"]) => Sender<X>
  readonly schedule: (when: When) => Sender<Actor<Name, D>>
  readonly start: Starters<D["jobs"]>
  readonly broadcast: Broadcasters<D["broadcasts"]>
}

/** The context of `connect` and `disconnect`: a command context with the connection id. */
export interface PresenceContext<Name extends string, D extends Def> extends CommandContext<
  Name,
  D,
  D["caller"] | System
> {
  readonly connection: string
}

/** A view handler reads durable state only and stages nothing. */
export interface ViewContext<D extends Def> {
  readonly caller: D["caller"] | System
  readonly self: D["key"]["Type"]
}

/**
 * Records a job step so that a journaled step never runs again. The two-argument form records a
 * JSON result; anything else names its Schema.
 */
export interface Step {
  <A extends Schema.Json | void, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>
  <S extends MemberSchema, E, R>(
    name: string,
    schema: S,
    effect: Effect.Effect<S["Type"], E, R>,
  ): Effect.Effect<S["Type"], E, R>
}

/** The context of a job handler. */
export interface JobContext<Name extends string, D extends Def> {
  readonly self: SelfHandle<Name, D>
  readonly id: () => string
  readonly attempt: number
  readonly broadcast: JobBroadcasters<D["broadcasts"]>
  readonly step: Step
}

type SuccessType<A extends Command> = A["success"] extends Schema.Top
  ? A["success"]["Type"]
  : undefined
type FailsType<A extends Command> = A["fails"] extends Schema.Top ? A["fails"]["Type"] : never

/** The caller a command handler sees: internal commands are reached by the engine only. */
export type CallerFor<D extends Def, A extends Command> = A["internal"] extends true
  ? System
  : D["caller"] | System

/**
 * A command handler: synchronous, over a copy-on-write draft. Returning the declared failure
 * discards the draft and every staged effect; returning a value is the reply.
 */
export type CommandHandler<Name extends string, D extends Def, A extends Command> = (
  draft: Draft<D["state"]["fields"]>,
  payload: PayloadOf<A["payload"]>,
  ctx: CommandContext<Name, D, CallerFor<D, A>>,
) => SuccessType<A> | FailsType<A>

/** A view handler: a pure, synchronous function of durable state and its parameters. */
export type ViewHandler<D extends Def, V extends View> = (
  state: ReadState<D["state"]["fields"]>,
  params: PayloadOf<V["params"]>,
  ctx: ViewContext<D>,
) => V["success"]["Type"]

/**
 * What a job's Effect succeeds with: the payload of its `onSuccess` command, which receives it, or
 * `void` when that command takes none; anything when the job has no `onSuccess`.
 */
export type JobSuccess<D extends Def, J extends Job> = J["onSuccess"] extends keyof D["commands"]
  ? D["commands"][J["onSuccess"]]["payload"] extends Schema.Top
    ? PayloadOf<D["commands"][J["onSuccess"]]["payload"]>
    : void
  : unknown

/** A job handler: the only place for I/O. Its requirements flow into the layer type. */
export type JobHandler<Name extends string, D extends Def, J extends Job> = (
  payload: PayloadOf<J["payload"]>,
  ctx: JobContext<Name, D>,
) => Effect.Effect<JobSuccess<D, J>, unknown, any>

/** `connect` or `disconnect`: a command over the draft receiving the presence value. */
export type PresenceHandler<Name extends string, D extends Def> = (
  draft: Draft<D["state"]["fields"]>,
  presence: PayloadOf<D["presence"]>,
  ctx: PresenceContext<Name, D>,
) => undefined

/** Every handler `X.toLayer` takes: commands, views, jobs and, with presence, `connect`/`disconnect`. */
export type Handlers<Name extends string, D extends Def> = {
  readonly [A in keyof D["commands"]]: CommandHandler<Name, D, D["commands"][A]>
} & { readonly [V in keyof D["views"]]: ViewHandler<D, D["views"][V]> } & {
  readonly [J in keyof D["jobs"]]: JobHandler<Name, D, D["jobs"][J]>
} & (D["presence"] extends Schema.Top
    ? {
        readonly connect: PresenceHandler<Name, D>
        readonly disconnect: PresenceHandler<Name, D>
      }
    : {})

type IsScalar<T> = [Exclude<T, undefined>] extends [never]
  ? false
  : [Exclude<T, undefined>] extends [string | number | boolean | bigint]
    ? true
    : [Exclude<T, undefined>] extends [DateTime.Utc]
      ? true
      : false

/** Top-level scalar state fields: the only fields `find` filters or orders by. */
export type ScalarKeys<F extends Fields> = {
  [K in keyof F]: F[K] extends List ? never : IsScalar<F[K]["Type"]> extends true ? K : never
}[keyof F] &
  string

/** A range condition on one scalar field. */
export interface Bounds<T> {
  readonly eq?: T
  readonly gt?: T
  readonly gte?: T
  readonly lt?: T
  readonly lte?: T
  readonly in?: ReadonlyArray<T>
}

/** A `find` query: conjunctive conditions on scalar fields, one order, a limit of at most 1,000. */
export interface FindQuery<F extends Fields> {
  readonly where?: { readonly [K in ScalarKeys<F>]?: F[K]["Type"] | Bounds<F[K]["Type"]> }
  readonly orderBy?: { readonly field: ScalarKeys<F>; readonly direction?: "asc" | "desc" }
  readonly limit?: number
}
