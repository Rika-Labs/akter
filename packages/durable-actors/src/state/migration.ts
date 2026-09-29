import { Schema } from "effect"
import type { ValueSchema } from "../members/command.ts"

type Fields = Readonly<Record<string, ValueSchema>>

/**
 * One step of a schema's history: `from` is the stored shape, `to` the next
 * one, and `upcast` a pure conversion. A chain's last `to` is the declared
 * shape, so a stored value upcasts through every later step in order.
 * `downcast` converts back; an event or effect needs it only for the steps
 * above its `writeVersion`, while a rolling deploy still writes the old shape.
 */
export interface StateMigration<From extends Fields = Fields, To extends Fields = Fields> {
  readonly from: From
  readonly to: To
  // Method syntax keeps the parameters bivariant so any migration fits a chain.
  upcast(previous: Schema.Struct<From>["Type"]): Schema.Struct<To>["Type"]
  downcast?(next: Schema.Struct<To>["Type"]): Schema.Struct<From>["Type"]
}

const migration = <const From extends Fields, const To extends Fields>(
  from: From,
  to: To,
  upcast: StateMigration<From, To>["upcast"],
  options?: {
    readonly downcast?: (next: Schema.Struct<To>["Type"]) => Schema.Struct<From>["Type"]
  },
): StateMigration<From, To> =>
  options?.downcast === undefined
    ? { from, to, upcast }
    : { from, to, upcast, downcast: options.downcast }

/** Stored with the actor's state rows; version `n` means `n` migrations have been applied. */
export const VERSION_KEY = "$version"

/** A chain is valid when each `to` is the next `from` and the last `to` is the declared state. */
const validateChain = (fields: Fields, chain: ReadonlyArray<StateMigration>): void => {
  for (let index = 1; index < chain.length; index++)
    if (chain[index - 1]!.to !== chain[index]!.from)
      throw new Error(`State migration ${index} must start from the previous migration's result`)

  if (chain.length > 0 && chain.at(-1)!.to !== fields)
    throw new Error("The last state migration must produce the declared state")

  if (VERSION_KEY in fields) throw new Error(`State key '${VERSION_KEY}' is reserved`)
}

/**
 * An actor's keyed state: the current fields and the migrations that upcast
 * older stored shapes to them. The last migration's `to` must be `fields`.
 */
export interface ActorState<F extends Fields = Fields> {
  readonly fields: F
  readonly migrations: ReadonlyArray<StateMigration>
}

const state = <const F extends Fields>(
  fields: F,
  options?: { readonly migrations?: ReadonlyArray<StateMigration> },
): ActorState<F> => ({ fields, migrations: options?.migrations ?? [] })

export const ActorStates = { make: state, migration, validateChain }
