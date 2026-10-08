import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { Actor } from "../../../../../../packages/akter/src/index.ts"
import { backfillAdoption } from "../../../../../../packages/akter/src/runtime/adoption/backfill.ts"
import type { AdoptionRefused } from "../../../../../../packages/akter/src/runtime/adoption/target.ts"
import { Database } from "../../../../../../packages/akter/src/runtime/index.ts"

const adoptedTable = (name: string) => {
  const rows = pgTable(name, {
    id: text("id").primaryKey(),
    org: text("org").notNull(),
    holder: text("holder").notNull(),
  })

  return {
    name,
    adopted: Actor.table(rows, { owner: { tenant: rows.org, actor: rows.holder } }),
  }
}

/** The legacy tables of the drill: one per placement, each owned by an actor type of that placement. */
export const tenantTable = adoptedTable("crash_adopt_tenant")

export const actorTable = adoptedTable("crash_adopt_actor")

export const childTable = adoptedTable("crash_adopt_child")

const Touch = Actor.command("Touch")

export const Tenanted = Actor.make("Tenanted", {
  key: Schema.String,
  tables: [tenantTable.adopted],
  api: { Touch },
})

export const Spread = Actor.make("Spread", {
  key: Schema.String,
  placement: "actor",
  tables: [actorTable.adopted],
  api: { Touch },
})

export const Shipment = Actor.make("CrashShipment", {
  key: Schema.String,
  placement: { parent: Spread },
  tables: [childTable.adopted],
  api: { Touch },
})

export const actors = [Tenanted, Spread, Shipment]

export const legacyDdl = [tenantTable, actorTable, childTable].map(
  ({ name }) =>
    `CREATE TABLE ${name} (id text PRIMARY KEY, org text NOT NULL, holder text NOT NULL)`,
)

const program = Effect.gen(function* () {
  const only = yield* Config.String("ADOPT_ONLY")
  const batch = yield* Config.Int("ADOPT_BATCH")

  const outcome = yield* backfillAdoption(actors, { only, batch }).pipe(
    Effect.map((results) => `RESULT ${JSON.stringify(results)}`),
    Effect.catchTag("AdoptionRefused", (refused: AdoptionRefused) =>
      Effect.succeed(`REFUSED ${refused.message}`),
    ),
  )

  yield* Console.log(outcome)
}).pipe(Effect.timeout("60 seconds"))

if (import.meta.main)
  Layer.unwrap(
    Effect.gen(function* () {
      const url = yield* Config.String("CRASH_DATABASE_URL")

      return Layer.effectDiscard(program).pipe(
        Layer.provide(Database.postgres({ url: Redacted.make(url) })),
        Layer.provide(BunCrypto.layer),
      )
    }),
  ).pipe(Layer.build, Effect.scoped, BunRuntime.runMain)
