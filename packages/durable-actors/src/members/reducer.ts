import { Schema, type Result } from "effect"
import type { ActorState } from "../state/migration.ts"
import type { DeclaredError, Member, ValueSchema } from "./command.ts"

type Fields = Readonly<Record<string, ValueSchema>>

type StateOf<F extends Fields> = Schema.Struct<F>["Type"]

/**
 * Combines two inputs into one whose single application equals applying both
 * in order, which lets the server merge queued calls into one turn. Declared
 * as a method so its parameters stay bivariant and any reducer fits `AnyReducer`.
 */
export interface Commutative<Input> {
  combine(first: Input, second: Input): Input
}

/**
 * A pure state transition declared in the contract. The server runs it as an
 * ordinary fenced, receipted turn with no handler; a commutative reducer
 * replies `void` and declares no errors so turns may later be merged.
 */
export interface Reducer<
  Tag extends string,
  F extends Fields,
  Input extends ValueSchema,
  Output extends ValueSchema,
  Errors extends ReadonlyArray<DeclaredError>,
> extends Member<"reducer", Tag, Input, Output, Errors> {
  readonly state: ActorState<F>
  /** Declared as a method so its parameters stay bivariant and any reducer fits `AnyReducer`. */
  reduce(state: StateOf<F>, input: Input["Type"]): Result.Result<StateOf<F>, Errors[number]["Type"]>
  readonly commutative: Commutative<Input["Type"]> | undefined
}

/** Any reducer, whatever its schemas. */
export type AnyReducer = Reducer<
  string,
  Fields,
  ValueSchema,
  ValueSchema,
  ReadonlyArray<DeclaredError>
>

/**
 * The overloads of `Actor.reducer`. A commutative reducer replies `void` and
 * cannot fail, so merged turns stay equivalent to sequential ones; any other
 * replies the committed state. Declaring `errors` on a commutative reducer
 * throws.
 *
 * @example
 * const Add = Actor.reducer("Add", {
 *   state: Counter,
 *   input: Schema.Struct({ by: Schema.Int }),
 *   reduce: (state, { by }) => Result.succeed({ count: state.count + by }),
 *   commutative: { combine: (a, b) => ({ by: a.by + b.by }) },
 * })
 */
export interface MakeReducer {
  <const Tag extends string, const F extends Fields, Input extends ValueSchema = Schema.Void>(
    tag: Tag,
    options: {
      readonly state: ActorState<F>
      readonly input?: Input
      readonly errors?: readonly []
      readonly reduce: (state: StateOf<F>, input: Input["Type"]) => Result.Result<StateOf<F>, never>
      readonly commutative: Commutative<Input["Type"]>
    },
  ): Reducer<Tag, F, Input, Schema.Void, readonly []>
  <
    const Tag extends string,
    const F extends Fields,
    Input extends ValueSchema = Schema.Void,
    const Errors extends ReadonlyArray<DeclaredError> = readonly [],
  >(
    tag: Tag,
    options: {
      readonly state: ActorState<F>
      readonly input?: Input
      readonly errors?: Errors
      readonly reduce: (
        state: StateOf<F>,
        input: Input["Type"],
      ) => Result.Result<StateOf<F>, Errors[number]["Type"]>
      readonly commutative?: undefined
    },
  ): Reducer<Tag, F, Input, Schema.Struct<F>, Errors>
}

const reducer = (
  tag: string,
  options: {
    readonly state: ActorState
    readonly input?: ValueSchema
    readonly errors?: ReadonlyArray<DeclaredError>
    readonly reduce: AnyReducer["reduce"]
    readonly commutative?: Commutative<unknown>
  },
):
  | Reducer<string, Fields, ValueSchema, Schema.Void, ReadonlyArray<DeclaredError>>
  | Reducer<string, Fields, ValueSchema, Schema.Struct<Fields>, ReadonlyArray<DeclaredError>> => {
  const { state, reduce, commutative } = options
  const input = options.input ?? Schema.Void

  if (commutative === undefined)
    return {
      kind: "reducer",
      tag,
      input,
      output: Schema.Struct(state.fields),
      errors: options.errors ?? [],
      state,
      reduce,
      commutative,
    }

  if ((options.errors ?? []).length > 0)
    throw new Error(`Commutative reducer ${tag} cannot declare errors`)

  return {
    kind: "reducer",
    tag,
    input,
    output: Schema.Void,
    errors: [],
    state,
    reduce,
    commutative,
  }
}

/** `Reducer.make` is `Actor.reducer`; see `MakeReducer` for its two forms. */
export const Reducer = { make: reducer as MakeReducer }
