import { Context, Effect, Layer } from "effect"
import type { Handlers } from "../contract/context.ts"
import type { AnyActor, Def } from "../contract/make.ts"

/** Marks the service that holds one actor's handlers; the engine requires one per actor. */
export interface Implementation<Name extends string> {
  readonly "~akter/Implementation": Name
}

/** A handler of any member kind, as the engine calls it. */
export type AnyHandler = (...args: Array<any>) => any

/**
 * One actor's bound handlers and the services its layer was built with, which jobs run under.
 * Action and view handlers need nothing from it.
 */
export interface Registered {
  readonly handlers: ReadonlyMap<string, AnyHandler>
  readonly context: Context.Context<never>
}

/** The implementation type of an actor contract. */
export type ImplementationOf<X> = X extends { readonly name: infer Name extends string }
  ? Implementation<Name>
  : never

/**
 * Builds the actor's layer. Every declared member needs a handler and nothing undeclared is
 * accepted; the types say so at compile time and this says so for callers that bypass them.
 */
const layer = (actor: AnyActor, handlers: Handlers<string, Def>) => {
  const bound = new Map<string, AnyHandler>(Object.entries(handlers))
  const expected = [
    ...Object.keys(actor.actions),
    ...Object.keys(actor.views),
    ...Object.keys(actor.jobs),
    ...(actor.presence === undefined ? [] : ["connect", "disconnect"]),
  ]
  for (const name of expected)
    if (!bound.has(name)) throw new Error(`Actor ${actor.name}: no handler for '${name}'`)
  for (const name of bound.keys())
    if (!expected.includes(name))
      throw new Error(`Actor ${actor.name}: '${name}' is not declared in the contract`)
  return Layer.effect(
    actor.implementation,
    Effect.map(Effect.context<never>(), (context) => ({ handlers: bound, context })),
  )
}

/** Binds an actor's handlers into its layer. */
export const Registry = { layer }
