import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

/** Units, order count and revenue of one SKU. */
export const SalesRow = Schema.Struct({
  sku: Schema.String,
  name: Schema.String,
  orders: Schema.Int,
  quantity: Schema.Int,
  /** Cents; exact up to 2^53. */
  revenue: Schema.Int,
})

/**
 * Units and revenue per SKU across every order of a tenant. This is plain
 * application SQL over the owned `order_lines` table, outside any turn: actor
 * queries read only their own actor's rows. It reads committed rows under
 * Postgres's usual READ COMMITTED rules, so it can lag an order that commits
 * while it runs, and it takes no actor's lock.
 */
export const salesBySku = Effect.fn("Reports.salesBySku")(function* (tenant: string) {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql`
    SELECT sku, min(name) AS name,
      count(DISTINCT actor_id)::int AS orders,
      sum(quantity)::int AS quantity,
      sum(quantity::bigint * unit_price)::float8 AS revenue
    FROM order_lines
    WHERE tenant_id = ${tenant}
    GROUP BY sku
    ORDER BY revenue DESC, sku`.pipe(Effect.orDie)

  return yield* Schema.decodeUnknownEffect(Schema.Array(SalesRow))(rows).pipe(Effect.orDie)
})
