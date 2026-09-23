import { Config, Effect } from "effect"
import { Pool } from "pg"
import { migrate } from "@durable-actors/postgres/migrate"

export interface TestDatabase {
  readonly url: string
  readonly pool: Pool
  readonly dispose: Effect.Effect<void>
}

export function makeTestDatabase(prefix: string) {
  return Effect.gen(function* () {
    const adminUrl = yield* Config.String("TEST_DATABASE_URL")

    const admin = new Pool({ connectionString: adminUrl })

    const identifier = yield* Effect.promise(() =>
      admin.query<{ id: string }>("select replace(gen_random_uuid()::text, '-', '') as id"),
    )

    const name = `${prefix}_${identifier.rows[0]!.id}`
    yield* Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`))

    const url = new URL(adminUrl)
    url.pathname = `/${name}`

    yield* Effect.promise(() => migrate(url.href)).pipe(
      Effect.onError(() =>
        Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).pipe(
          Effect.ensuring(Effect.promise(() => admin.end())),
        ),
      ),
    )

    const pool = new Pool({ connectionString: url.href })

    return {
      url: url.href,
      pool,
      dispose: Effect.promise(() => pool.end()).pipe(
        Effect.andThen(
          Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
        ),
        Effect.ensuring(Effect.promise(() => admin.end())),
      ),
    }
  })
}
