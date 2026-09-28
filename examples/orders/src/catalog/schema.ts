import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import * as PgliteDrizzle from "drizzle-orm/effect-pglite"
import * as PostgresDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"

/**
 * The application's own tables. They existed before any actor did, the app
 * migrates them itself, and no actor owns them: the framework never scopes,
 * locks, or reads them inside a turn.
 */
export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
})

export const products = pgTable("products", {
  sku: text("sku").primaryKey(),
  name: text("name").notNull(),
  /** Whole cents, so totals add exactly. */
  unitPrice: integer("unit_price").notNull(),
  /** The warehouse package a product ships in; one shipment per package. */
  package: text("package").notNull(),
})

/** The app's existing migration, as drizzle-kit would generate it. */
export const catalogDdl = [
  `CREATE TABLE IF NOT EXISTS customers (
    id text PRIMARY KEY, name text NOT NULL, email text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS products (
    sku text PRIMARY KEY, name text NOT NULL, unit_price integer NOT NULL, package text NOT NULL)`,
]

/** Demo rows: two customers, and products that ship from two packages. */
export const catalogSeed = [
  `INSERT INTO customers (id, name, email) VALUES
    ('ada', 'Ada Lovelace', 'ada@example.com'),
    ('grace', 'Grace Hopper', 'grace@example.com')
    ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO products (sku, name, unit_price, package) VALUES
    ('kettle', 'Kettle', 3900, 'bulky'),
    ('mug', 'Mug', 1200, 'small'),
    ('tea', 'Loose-leaf tea', 850, 'small'),
    ('piano', 'Grand piano', 12000000, 'freight')
    ON CONFLICT (sku) DO NOTHING`,
]

/** Creates and seeds the app's tables, standing in for the app's own migrations. */
export const CatalogLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    for (const statement of [...catalogDdl, ...catalogSeed]) yield* sql.unsafe(statement)
  }).pipe(Effect.orDie),
)

/**
 * The app's own Drizzle client over the same database. It is an ordinary
 * pooled connection: nothing read through it is part of any actor turn's
 * transaction or snapshot.
 */
export const appDatabase = Effect.gen(function* () {
  const pglite = yield* Effect.serviceOption(PgliteClient.PgliteClient)

  if (Option.isSome(pglite)) {
    const database: PostgresDrizzle.EffectPgDatabase = yield* PgliteDrizzle.makeWithDefaults().pipe(
      Effect.provideService(PgliteClient.PgliteClient, pglite.value),
    )

    return database
  }

  const postgres = yield* Effect.serviceOption(PgClient.PgClient)

  if (Option.isNone(postgres)) return yield* Effect.die(new Error("No Postgres or PGlite client"))

  return yield* PostgresDrizzle.makeWithDefaults().pipe(
    Effect.provideService(PgClient.PgClient, postgres.value),
  )
})
