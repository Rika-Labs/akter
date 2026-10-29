import { Duration, Effect, Schema } from "effect"
import { Crons } from "./cron.ts"
import type { Cause } from "effect"

/** A schema that needs no Effect services to encode or decode, so a member codec runs anywhere. */
export type MemberSchema = Schema.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/** A declared failure: a tagged error class, or a union of them. */
export type DeclaredError = MemberSchema & {
  readonly Type: Cause.YieldableError & { readonly _tag: string }
}

/** A member schema, or `undefined` for a member without one. */
export type OptionalSchema = MemberSchema | undefined

/**
 * A declared command. `internal` commands are not on the client handle or `/rpc`; the engine's own
 * calls reach them (`schedule`, `cron`, a job's `self`, `onFailure`, another actor's `send`). A
 * `cron` command is internal and takes no payload.
 */
export interface Command<
  P extends OptionalSchema = OptionalSchema,
  S extends OptionalSchema = OptionalSchema,
  E extends DeclaredError | undefined = DeclaredError | undefined,
  I extends boolean = boolean,
> {
  readonly kind: "Command"
  readonly payload: P
  readonly success: S
  readonly fails: E
  readonly internal: I
  readonly cron: string | undefined
}

/** Options of a command with a payload. */
export interface PayloadCommandOptions {
  readonly success?: MemberSchema
  readonly fails?: DeclaredError
  readonly internal?: boolean
}

/** Options of a command without a payload; only these may name a `cron` schedule. */
export interface CommandOptions extends PayloadCommandOptions {
  readonly cron?: string
}

type SuccessOf<O> = O extends { readonly success: infer S extends MemberSchema } ? S : undefined
type FailsOf<O> = O extends { readonly fails: infer E extends DeclaredError } ? E : undefined
type InternalOf<O> = O extends { readonly cron: string }
  ? true
  : O extends { readonly internal: true }
    ? true
    : false

function command(): Command<undefined, undefined, undefined, false>
function command<P extends MemberSchema, const O extends PayloadCommandOptions = {}>(
  payload: P,
  options?: O,
): Command<P, SuccessOf<O>, FailsOf<O>, InternalOf<O>>
function command<const O extends CommandOptions>(
  options: O,
): Command<undefined, SuccessOf<O>, FailsOf<O>, InternalOf<O>>
function command(first?: MemberSchema | CommandOptions, second?: PayloadCommandOptions): Command {
  const payload = Schema.isSchema(first) ? first : undefined
  const options: CommandOptions = (Schema.isSchema(first) ? second : first) ?? {}
  if (options.cron !== undefined && payload !== undefined)
    throw new Error("A cron command takes no payload: the engine calls it with nothing")
  if (options.cron !== undefined) Crons.parse(options.cron)
  return {
    kind: "Command",
    payload,
    success: options.success,
    fails: options.fails,
    internal: options.cron !== undefined || options.internal === true,
    cron: options.cron,
  }
}

/** A declared view: a derived shape computed synchronously from durable state. */
export interface View<
  A extends MemberSchema = MemberSchema,
  P extends OptionalSchema = OptionalSchema,
> {
  readonly kind: "View"
  readonly success: A
  readonly params: P
}

const view = <A extends MemberSchema, P extends MemberSchema | undefined = undefined>(
  success: A,
  options?: { readonly params?: P },
): View<A, NoInfer<P>> => ({ kind: "View", success, params: options?.params as P })

/** A declared broadcast: published after durability, never stored. */
export interface Broadcast<A extends MemberSchema = MemberSchema> {
  readonly kind: "Broadcast"
  readonly schema: A
}

const broadcast = <A extends MemberSchema>(schema: A): Broadcast<A> => ({
  kind: "Broadcast",
  schema,
})

/** How a job retries a failed attempt. */
export interface Retry {
  readonly attempts: number
  readonly backoff: Duration.Input
}

/** A declared job: the only place for I/O. */
export interface Job<P extends OptionalSchema = OptionalSchema, F extends string = string> {
  readonly kind: "Job"
  readonly payload: P
  readonly retry: Retry
  readonly timeout: Duration.Input | undefined
  readonly concurrency: number
  readonly onFailure: F
}

const job = <
  P extends MemberSchema | undefined = undefined,
  const F extends string = string,
>(options: {
  readonly payload?: P
  readonly retry?: Retry
  readonly timeout?: Duration.Input
  readonly concurrency?: number
  readonly onFailure: F
}): Job<NoInfer<P>, NoInfer<F>> => ({
  kind: "Job",
  payload: options.payload as P,
  retry: options.retry ?? { attempts: 1, backoff: Duration.zero },
  timeout: options.timeout,
  concurrency: options.concurrency ?? 1,
  onFailure: options.onFailure,
})

/** A field of an item that a list can key or order by. */
export type KeyField<T> = {
  [K in keyof T]-?: T[K] extends string | number ? K : never
}[keyof T] &
  string

/** The encoded form of a list field inside the state struct: its size; the items live outside. */
const ListRoot = Schema.Struct({ size: Schema.Finite }).pipe(
  Schema.withDecodingDefault(Effect.succeed({ size: 0 })),
)

type ListRoot = typeof ListRoot

/**
 * A state field whose items live outside the state object, keyed by `key` and ordered by `by`.
 * On the encoded side the field is its root, so a list needs no decoding default of its own.
 */
export interface List<
  I extends MemberSchema = MemberSchema,
  K extends string = string,
  B extends string = string,
> extends ListRoot {
  readonly "~akter/List": { readonly item: I; readonly key: K; readonly by: B }
  readonly item: I
  readonly keyField: K
  readonly byField: B
}

const list = <
  I extends MemberSchema,
  const B extends KeyField<I["Type"]>,
  const K extends KeyField<I["Type"]> = B,
>(
  item: I,
  options: { readonly key?: K; readonly by: B },
): List<I, NoInfer<K>, NoInfer<B>> =>
  Object.assign(Object.create(ListRoot), {
    "~akter/List": { item, key: options.key ?? options.by, by: options.by },
    item,
    keyField: options.key ?? options.by,
    byField: options.by,
  })

/** True when a state field is an `Actor.list`. */
export const isList = (field: MemberSchema): field is List =>
  Object.prototype.hasOwnProperty.call(field, "~akter/List")

/** A window over a list in `by` order: `from` inclusive, `to` exclusive. */
export interface RangeOptions<B> {
  readonly from?: B
  readonly to?: B
  readonly limit?: number
  readonly reverse?: boolean
}

/** A list as a view handler reads it. */
export interface ListReader<Item, Key, By> {
  get(key: Key): Item | undefined
  range(options?: RangeOptions<By>): ReadonlyArray<Item>
}

/** A list as a command handler sees it: writes are staged and discarded with the draft. */
export interface ListDraft<Item, Key, By> extends ListReader<Item, Key, By> {
  put(item: Item): void
  delete(key: Key): boolean
  deleteBefore(by: By): number
}

/**
 * What a job's `onFailure` command receives once every attempt is spent. `cause` names how the last
 * attempt ended; `ambiguous` is true when a step was running and may have reached its provider;
 * `payload` is the job's payload in its encoded form; `key` is the start's key when it had one.
 */
export class JobFailure extends Schema.Class<JobFailure>("Akter/JobFailure")({
  job: Schema.String,
  declaration: Schema.String,
  key: Schema.optionalKey(Schema.String),
  payload: Schema.Json,
  attempts: Schema.Int,
  cause: Schema.Literals(["Failed", "Defect", "Timeout"]),
  ambiguous: Schema.Boolean,
}) {}

/** The member constructors: schema first, options second. */
export const Members = { command, view, broadcast, job, list }
