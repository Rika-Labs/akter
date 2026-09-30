import { Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Option } from "effect"

/**
 * Postgres when `DATABASE_URL` is set; otherwise PGlite, an embedded Postgres
 * kept in files under `DATA_DIR`. PGlite serves one process at a time, so it
 * is for development: point every other process at Postgres.
 */
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.option(Config.Redacted("DATABASE_URL"))

    if (Option.isSome(url)) return Database.postgres({ url: url.value })

    return Database.pglite({
      dataDir: yield* Config.String("DATA_DIR").pipe(Config.withDefault(".data")),
    })
  }),
)
