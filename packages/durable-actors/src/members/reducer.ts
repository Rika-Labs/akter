import { Schema, type Result } from "effect"
import type { ActorState } from "../state/migration.ts"
import type { DeclaredError, Member, ValueSchema } from "./command.ts"

type Fields = Readonly<Record<string, ValueSchema>>

type StateOf<F extends Fields> = Schema.Struct<F>["Type"]

/** Combines two inputs into one whose single application equals applying both in order. */
export interface Commutative<Input> {
  // Method syntax keeps the parameters bivariant so any reducer fits `AnyReducer`.
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
  // Method syntax keeps the parameters bivariant so any reducer fits `AnyReducer`.
  reduce(state: StateOf<F>, input: Input["Type"]): Result.Result<StateOf<F>, Errors[number]["Type"]>
  readonly commutative: Commutative<Input["Type"]> | undefined
}

export type AnyReducer = Reducer<
  string,
  Fields,
  ValueSchema,
  ValueSchema,
  ReadonlyArray<DeclaredError>
>

/** `Actor.reducer`: a commutative reducer replies `void` and cannot fail; any other replies the new state. */
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

  // A reducer replies with the committed state; a commutative one replies nothing and cannot fail.
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

// The declared signatures carry the precise types the untyped implementation cannot express.
export const Reducer = { make: reducer as MakeReducer }
