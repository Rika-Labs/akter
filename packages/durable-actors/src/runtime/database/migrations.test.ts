import { BunCrypto } from "@effect/platform-bun"
import {
  Cause,
  Config,
  Crypto,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
} from "effect"
import { Migrator, SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Database } from "../layer.ts"
import { migrations, migrator } from "./migrations.ts"

describe("migrations with Postgres", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it("refuses to start when a concurrent runner commits a higher id while it waits for the migration lock", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
          const name = `migrations_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

          const admin = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: database.href })),
            (pool) => Effect.promise(() => pool.end()),
          )
          yield* Effect.acquireRelease(
            Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
            () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
          )
          database.pathname = `/${name}`

          const pool = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: database.href })),
            (db) => Effect.promise(() => db.end()),
          )
          const older = yield* Effect.acquireRelease(
            Effect.promise(() => pool.connect()),
            (client) => Effect.sync(() => client.release()),
          )

          const through9 = Object.fromEntries(
            Object.entries(migrations).filter(([id]) => id < "0010"),
          )
          const client = yield* Layer.build(
            Database.postgres({ url: Redacted.make(database.href) }),
          )
          const migrate = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
            Effect.provide(effect, client)

          yield* migrate(migrator(through9))

          // The older runner has 13 but not 12, and commits 13 only after the
          // newer runner has checked the table and is waiting for the lock.
          yield* Effect.promise(() => older.query("BEGIN"))
          yield* Effect.promise(() =>
            older.query(
              "INSERT INTO actor_migrations (migration_id, name) VALUES (13, 'inspection_views')",
            ),
          )

          const newer = yield* Effect.forkChild(
            Effect.exit(
              migrate(
                migrator({
                  ...through9,
                  "0012_workflows": Effect.void,
                  "0013_inspection_views": Effect.void,
                }),
              ),
            ),
          )

          yield* Effect.promise(() =>
            pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
              [name],
            ),
          ).pipe(
            Effect.flatMap((result) =>
              result.rowCount === 0 ? Effect.fail("not waiting") : Effect.void,
            ),
            Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
          )
          yield* Effect.promise(() => older.query("COMMIT"))

          const exit = yield* Fiber.join(newer)
          expect(Exit.isFailure(exit)).toBe(true)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(error).toBeInstanceOf(Migrator.MigrationError)
          expect(error).toMatchObject({
            kind: "BadState",
            message: expect.stringContaining(
              "Migrations 12 were never applied but migration 13 was",
            ),
          })
          expect(
            (yield* Effect.promise(() =>
              pool.query("SELECT migration_id FROM actor_migrations ORDER BY migration_id"),
            )).rows.map(({ migration_id }) => migration_id),
          ).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 13])
        }),
      ),
    ))
})
