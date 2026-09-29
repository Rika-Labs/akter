import { BunFileSystem } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Layer } from "effect"
import { Pool, type PoolClient } from "pg"

const query = (client: PoolClient, text: string, values: Array<unknown> = []) =>
  Effect.tryPromise(() => client.query(text, values))

const migrateEffect = Effect.fn("Database.migrate")(function* (url: string) {
  const fs = yield* FileSystem.FileSystem

  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: url, max: 1 })),
    (pool) => Effect.promise(() => pool.end()),
  )

  const client = yield* Effect.acquireRelease(
    Effect.tryPromise(() => pool.connect()),
    (client) => Effect.sync(() => client.release()),
  )

  yield* query(client, "select pg_advisory_lock(741902113)")
  yield* Effect.gen(function* () {
    yield* query(
      client,
      "create table if not exists project_migration (name text primary key, applied_at timestamptz not null default now())",
    )

    const directory = new URL("../migrations/", import.meta.url)

    const names = (yield* fs.readDirectory(directory.pathname))
      .filter((name) => name.endsWith(".sql"))
      .sort()

    for (const name of names) {
      const applied = yield* query(client, "select 1 from project_migration where name = $1", [
        name,
      ])

      if (applied.rowCount !== 0) continue

      yield* query(client, "begin")
      yield* Effect.gen(function* () {
        yield* query(client, yield* fs.readFileString(`${directory.pathname}${name}`))
        yield* query(client, "insert into project_migration(name) values ($1)", [name])
        yield* query(client, "commit")
      }).pipe(
        Effect.catch((error) => query(client, "rollback").pipe(Effect.andThen(Effect.fail(error)))),
      )
    }
  }).pipe(Effect.ensuring(query(client, "select pg_advisory_unlock(741902113)").pipe(Effect.orDie)))
})

/**
 * Applies the `.sql` files in `migrations/` that are not yet recorded, in name
 * order and one transaction each, under a session advisory lock so concurrent
 * callers apply each file once. A failing file is rolled back and rejects.
 */
export const migrate = (url: string): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(BunFileSystem.layer)
        yield* migrateEffect(url).pipe(Effect.provideContext(context), Effect.orDie)
      }),
    ),
  )

if (import.meta.main) {
  void Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(BunFileSystem.layer)
        yield* migrateEffect(yield* Config.String("DATABASE_URL")).pipe(
          Effect.provideContext(context),
          Effect.orDie,
        )
        yield* Effect.log("Database migrations complete")
      }),
    ),
  )
}
