import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Override, Snapshot } from "./evaluation.ts"
import { OverrideStore, StoreError } from "./store.ts"

/**
 * Idempotent statements that create the flags schema, for a host that runs its
 * own startup migrations (such as the control-plane API) to append to its list.
 */
export const flagMigrations: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS feature_flag_override (
    key text PRIMARY KEY,
    rule jsonb NOT NULL CHECK (jsonb_typeof(rule) = 'object')
  )`,
]

/** Serializes concurrent starts, since `CREATE TABLE IF NOT EXISTS` alone races. */
const MIGRATION_LOCK = 6_511_265_514

/** Applies `flagMigrations` in one transaction under an advisory lock; safe to run from several processes. */
export const migrateFlags = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`
      for (const statement of flagMigrations) yield* sql.unsafe(statement)
    }),
  )
})

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
