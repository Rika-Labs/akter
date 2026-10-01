import { Schema, type Result } from "effect"
import type { ActorState } from "../state/migration.ts"
import {
  type DeclaredError,
  member,
  type Member,
  type PayloadOf,
  type PayloadOption,
  type ValueSchema,
} from "./command.ts"

type Fields = Readonly<Record<string, ValueSchema>>

type StateOf<F extends Fields> = Schema.Struct<F>["Type"]

/**
 * Ordered batching: `combine(first, second)` is one payload whose single
 * reduction equals reducing `first` and then `second`, which lets the server
 * fold consecutive queued calls, in their order, into one turn. It needs that
 * fold equivalence only; it is not commutativity or a merge of concurrent
 * replicas. Declared as a method so its parameters stay bivariant and any
 * reducer fits `AnyReducer`.
 */
export interface Batch<Payload> {
  combine(first: Payload, second: Payload): Payload
}

/**
 * A pure state transition declared in the contract. The server runs it as an
 * ordinary fenced, receipted turn with no handler; a batched reducer replies
 * `void` and declares no error, so combined turns stay equivalent to
 * sequential ones and each call keeps its own receipt.
 */
export interface Reducer<
  Tag extends string,
  F extends Fields,
  Payload extends ValueSchema,
  Success extends ValueSchema,
  Error extends DeclaredError,
> extends Member<"reducer", Tag, Payload, Success, Error> {
  readonly state: ActorState<F>
  /** Declared as a method so its parameters stay bivariant and any reducer fits `AnyReducer`. */
  reduce(state: StateOf<F>, payload: Payload["Type"]): Result.Result<StateOf<F>, Error["Type"]>
  readonly batch: Batch<Payload["Type"]> | undefined
}

/** Any reducer, whatever its schemas. */
export type AnyReducer = Reducer<string, Fields, ValueSchema, ValueSchema, DeclaredError>

/**
 * The overloads of `Actor.reducer`. A batched reducer replies `void` and
 * cannot fail; any other replies the committed state. Declaring `error` on a
 * batched reducer throws.
 *
 * @example
 * const Add = Actor.reducer("Add", {
 *   state: Counter,
 *   payload: { by: Schema.Int },
 *   reduce: (state, { by }) => Result.succeed({ count: state.count + by }),
 *   batch: { combine: (first, second) => ({ by: first.by + second.by }) },
 * })
 */
export interface MakeReducer {
  <const Tag extends string, const F extends Fields, const P extends PayloadOption = Schema.Void>(
    tag: Tag,
    options: {
      readonly state: ActorState<F>
      readonly payload?: P
      readonly error?: Schema.Never
      readonly reduce: (
        state: StateOf<F>,
        payload: PayloadOf<P>["Type"],
      ) => Result.Result<StateOf<F>, never>
      readonly batch: Batch<PayloadOf<P>["Type"]>
    },
  ): Reducer<Tag, F, PayloadOf<P>, Schema.Void, Schema.Never>
  <
    const Tag extends string,
    const F extends Fields,
    const P extends PayloadOption = Schema.Void,
    Error extends DeclaredError = Schema.Never,
  >(
    tag: Tag,
    options: {
      readonly state: ActorState<F>
      readonly payload?: P
      readonly error?: Error
      readonly reduce: (
        state: StateOf<F>,
        payload: PayloadOf<P>["Type"],
      ) => Result.Result<StateOf<F>, Error["Type"]>
      readonly batch?: undefined
    },
  ): Reducer<Tag, F, PayloadOf<P>, Schema.Struct<F>, Error>
}

const reducer = (
  tag: string,
  options: {
    readonly state: ActorState
    readonly payload?: PayloadOption
    readonly error?: DeclaredError
    readonly reduce: AnyReducer["reduce"]
    readonly batch?: Batch<ValueSchema["Type"]>
  },
): AnyReducer => {
  const { state, reduce, batch } = options

  if (batch === undefined)
    return {
      ...member("reducer")(tag, {
        payload: options.payload,
        success: Schema.Struct(state.fields),
        error: options.error,
      }),
      state,
      reduce,
      batch,
    }

  if (options.error !== undefined && options.error !== Schema.Never)
    throw new Error(`Batched reducer ${tag} cannot declare an error`)

  return {
    ...member("reducer")(tag, { payload: options.payload }),
    state,
    reduce,
    batch,
  }
}

const make: MakeReducer = reducer as never

/** `Reducer.make` is `Actor.reducer`; see `MakeReducer` for its two forms. */
export const Reducer = { make }
