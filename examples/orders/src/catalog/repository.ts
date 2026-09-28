import { eq, inArray } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { appDatabase, customers, products } from "./schema.ts"

export class UnknownCustomer extends Schema.TaggedError<UnknownCustomer>()("UnknownCustomer", {
  customerId: Schema.String,
}) {}

export class UnknownProducts extends Schema.TaggedError<UnknownProducts>()("UnknownProducts", {
  skus: Schema.Array(Schema.String),
}) {}

/**
 * Reads the customer and the ordered products with the app's own Drizzle
 * client, outside any actor turn, and returns what `Place` needs as input.
 * Quantities of a repeated SKU are added into one line.
 */
export const quote = Effect.fn("Catalog.quote")(function* (order: {
  readonly customerId: string
  readonly items: ReadonlyArray<{ readonly sku: string; readonly quantity: number }>
}) {
  const db = yield* appDatabase

  const [customer] = yield* db
    .select({ id: customers.id, name: customers.name, email: customers.email })
    .from(customers)
    .where(eq(customers.id, order.customerId))
    .pipe(Effect.orDie)

  if (customer === undefined) return yield* UnknownCustomer.make({ customerId: order.customerId })

  const quantities = new Map<string, number>()

  for (const { sku, quantity } of order.items)
    quantities.set(sku, (quantities.get(sku) ?? 0) + quantity)

  const found = yield* db
    .select()
    .from(products)
    .where(inArray(products.sku, [...quantities.keys()]))
    .pipe(Effect.orDie)

  const bySku = new Map(found.map((product) => [product.sku, product]))
  const missing = [...quantities.keys()].filter((sku) => !bySku.has(sku))

  if (missing.length > 0) return yield* UnknownProducts.make({ skus: missing })

  return {
    customer,
    lines: [...quantities].map(([sku, quantity]) => {
      const product = bySku.get(sku)!

      return {
        sku,
        name: product.name,
        quantity,
        unitPrice: product.unitPrice,
        package: product.package,
      }
    }),
  }
})
