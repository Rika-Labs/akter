import { Context, Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

export class AuthDatabase extends Context.Service<AuthDatabase, ReturnType<typeof drizzle>>()(
  "@durable-actors/postgres/AuthDatabase",
) {}

export const databaseLayer = (url: string) =>
  Layer.mergeAll(
    PgClient.layer({ url: Redacted.make(url), maxConnections: 10 }),
    Layer.effect(
      AuthDatabase,
      Effect.gen(function* () {
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: url, max: 5 })),
          (pool) => Effect.promise(() => pool.end()),
        )

        yield* Effect.tryPromise(() => pool.query("select 1"))

        return drizzle({ client: pool })
      }),
    ),
  )
