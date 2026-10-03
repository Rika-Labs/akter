import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Override, Snapshot } from "./evaluation.ts"
import { OverrideStore, StoreError } from "./store.ts"

/** Reads on every evaluation; database failures stay failures rather than enabling defaults. */
export const postgresStore = Layer.effect(
  OverrideStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return OverrideStore.of({
      read: sql<{
        readonly key: string
        readonly rule: Override
      }>`SELECT key, rule FROM feature_flag_override`.pipe(
        Effect.flatMap((rows) =>
          Schema.decodeEffect(Snapshot)(Object.fromEntries(rows.map((row) => [row.key, row.rule]))),
        ),
        Effect.mapError(() => StoreError.make({})),
      ),
      set: (key, rule) =>
        Schema.encodeEffect(Schema.fromJsonString(Override))(rule).pipe(
          Effect.flatMap(
            (encoded) =>
              sql`INSERT INTO feature_flag_override (key, rule) VALUES (${key}, ${encoded}::jsonb) ON CONFLICT (key) DO UPDATE SET rule = EXCLUDED.rule`,
          ),
          Effect.asVoid,
          Effect.mapError(() => StoreError.make({})),
        ),
      remove: (key) =>
        sql`DELETE FROM feature_flag_override WHERE key = ${key}`.pipe(
          Effect.asVoid,
          Effect.mapError(() => StoreError.make({})),
        ),
    })
  }),
)
