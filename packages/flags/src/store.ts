import { Context, Effect, Layer, Schema } from "effect"
import { Override, Snapshot } from "./evaluation.ts"

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {}) {}

/** Stores complete administrative rules by flag key; raw reads are not browser snapshots. */
export class OverrideStore extends Context.Service<
  OverrideStore,
  {
    readonly read: Effect.Effect<Snapshot, StoreError>
    readonly set: (key: string, rule: Override) => Effect.Effect<void, StoreError>
    readonly remove: (key: string) => Effect.Effect<void, StoreError>
  }
>()("@akter/flags/store/OverrideStore") {}

/** Every layer build gets isolated storage; JSON copies prevent callers from mutating rules. */
export const memoryStore = Layer.effect(
  OverrideStore,
  Effect.sync(() => {
    const rules = new Map<string, string>()
    return {
      read: Effect.suspend(() =>
        Effect.forEach(Array.from(rules), ([key, value]) =>
          Schema.decodeEffect(Schema.fromJsonString(Override))(value).pipe(
            Effect.map((rule) => [key, rule] as const),
          ),
        ),
      ).pipe(
        Effect.map((rows) => Object.fromEntries(rows)),
        Effect.mapError(() => StoreError.make({})),
      ),
      set: (key, rule) =>
        Schema.encodeEffect(Schema.fromJsonString(Override))(rule).pipe(
          Effect.map((value) => {
            rules.set(key, value)
          }),
          Effect.mapError(() => StoreError.make({})),
        ),
      remove: (key) =>
        Effect.sync(() => {
          rules.delete(key)
        }),
    }
  }),
)
