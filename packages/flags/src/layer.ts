import { Context, Effect, Layer, Result, Schema } from "effect"
import { evaluate, InvalidOverride, UnknownFlag, validateOverride } from "./evaluation.ts"
import type { Override, Registry, Snapshot, Target } from "./evaluation.ts"
import { OverrideStore, type StoreError } from "./store.ts"

/** Builds a typed service for an application's declarations, with a separately supplied store. */
export const makeFlags = <const R extends Registry>(registry: R) => {
  type Key = keyof R & string
  class Flags extends Context.Service<
    Flags,
    {
      readonly evaluate: <K extends Key>(
        key: K,
        target: Target,
      ) => Effect.Effect<R[K]["default"], UnknownFlag | InvalidOverride | StoreError>
      readonly set: (
        key: Key,
        rule: Override,
      ) => Effect.Effect<void, UnknownFlag | InvalidOverride | StoreError>
      readonly remove: (key: Key) => Effect.Effect<void, UnknownFlag | StoreError>
      readonly snapshot: (
        target: Target,
      ) => Effect.Effect<Snapshot, UnknownFlag | InvalidOverride | StoreError>
    }
  >()("@akter/flags/layer/Flags") {}
  const layer = Layer.effect(
    Flags,
    Effect.gen(function* () {
      const store = yield* OverrideStore
      const validation = (key: Key, rule: Override) =>
        Effect.try({
          try: () => validateOverride(registry)(key, rule),
          catch: (error) => (Schema.is(UnknownFlag)(error) ? error : InvalidOverride.make({ key })),
        })
      const resolve = <K extends Key>(key: K, target: Target) =>
        Effect.gen(function* () {
          if (!Object.hasOwn(registry, key)) return yield* UnknownFlag.make({ key })
          const snapshot = yield* store.read
          return yield* Effect.try({
            try: () => evaluate(registry)(key, target, snapshot),
            catch: (error) =>
              Schema.is(UnknownFlag)(error) ? error : InvalidOverride.make({ key }),
          })
        })
      return Flags.of({
        evaluate: resolve,
        set: (key, rule) =>
          validation(key, rule).pipe(Effect.flatMap((valid) => store.set(key, valid))),
        remove: (key) =>
          Effect.gen(function* () {
            if (!Object.hasOwn(registry, key)) return yield* UnknownFlag.make({ key })
            yield* store.remove(key)
          }),
        snapshot: (target) =>
          store.read.pipe(
            Effect.flatMap((snapshot) =>
              Effect.try({
                try: () =>
                  Object.fromEntries(
                    Object.keys(registry).map((key) => [
                      key,
                      {
                        value: Result.getOrThrow(
                          Schema.encodeResult(registry[key]!.schema)(
                            evaluate(registry)(key, target, snapshot),
                          ),
                        ),
                      },
                    ]),
                  ),
                catch: () => InvalidOverride.make({ key: "snapshot" }),
              }),
            ),
          ),
      })
    }),
  )
  return { Flags, layer }
}
