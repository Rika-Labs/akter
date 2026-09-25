import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { Actor } from "../../index.ts"

it("rejects an executor that requires the SQL client", () => {
  class Lookup extends Actor.effect<Lookup>()("Lookup", { input: { id: Schema.String } }) {}

  const Owner = Actor.make("DatabaseFree", { effects: [Lookup], api: {} })

  const layer = Owner.toEffectLayer(
    // @ts-expect-error executors have no database capability
    Effect.succeed({
      Lookup: () => Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid),
    }),
  )

  expect(layer).toBeDefined()
})
