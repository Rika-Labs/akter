import { Effect, Option, Predicate } from "effect"

/**
 * Reads a missing resource as `undefined`, which a page loader answers with the not-found page.
 * Every other error passes through unchanged.
 */
export const orUndefined = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asSome,
    Effect.catchIf(Predicate.isTagged("NotFound"), () => Effect.succeedNone),
    Effect.map(Option.getOrUndefined),
  )
