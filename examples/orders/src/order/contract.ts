import { Actor } from "@durable-actors/core"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { Effect, Schema } from "effect"
import { shopper } from "../access.ts"

/** An order's key: 1 to 64 letters, digits, `_` or `-`. */
export const OrderId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)).pipe(
  Schema.brand("OrderId"),
)

/**
 * The order's lines: an owned table. The framework adds and scopes
 * routing_key, tenant_id, and actor_id, so each order reads and writes only
 * its own lines, inside its turn's transaction.
 */
export const orderLines = Actor.table(
  pgTable("order_lines", {
    sku: text("sku").primaryKey(),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    package: text("package").notNull(),
  }),
)

/** What drizzle-kit generates for `orderLines`; the runtime checks its primary key at startup. */
export const orderLinesDdl = `CREATE TABLE IF NOT EXISTS order_lines (
  routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
  sku text NOT NULL, name text NOT NULL, quantity integer NOT NULL,
  unit_price integer NOT NULL, package text NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_id, sku))`

/** One order line with its price and package, as read when the order was placed. */
export const Line = Schema.Struct({
  sku: Schema.NonEmptyString,
  name: Schema.String,
  quantity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  unitPrice: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  package: Schema.NonEmptyString,
})

/** The customer an order is placed for. */
export const Customer = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  email: Schema.String,
})

/** An order was placed, with its total in cents and its shipment ids. */
export const OrderPlaced = Actor.event("OrderPlaced", {
  customerId: Schema.String,
  total: Schema.Int,
  shipments: Schema.Array(Schema.String),
})

/** The charge succeeded. */
export const PaymentCaptured = Actor.event("PaymentCaptured", {
  chargeId: Schema.String,
})

/** The charge failed for good; `ambiguous` says whether it may have been applied. */
export const PaymentFailed = Actor.event("PaymentFailed", {
  /** The provider may have applied the charge; an operator must check before anything else. */
  ambiguous: Schema.Boolean,
})

/**
 * Charges the customer after `Place` commits. The executor runs outside any
 * transaction, possibly more than once, and passes its job id to the
 * provider as the idempotency key.
 */
export const Charge = Actor.job("Charge", {
  payload: { customerId: Schema.String, amount: Schema.Int },
  success: Schema.Struct({ chargeId: Schema.String }),
})

/** Declared failure of `Place` for an order that already exists. */
export class OrderAlreadyPlaced extends Schema.TaggedError<OrderAlreadyPlaced>()(
  "OrderAlreadyPlaced",
  {},
) {}

/** Where an order stands in its payment. */
export const OrderStatus = Schema.Literals([
  "new",
  "awaiting_payment",
  "paid",
  "payment_failed",
  "payment_unknown",
])

/** Order state: status, customer, total in cents, shipment ids and the charge id once paid. */
export const OrderState = Actor.state({
  status: OrderStatus.pipe(Schema.withDecodingDefault(Effect.succeed("new" as const))),
  customerId: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  shipments: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  chargeId: Schema.optional(Schema.String),
})

const Lines = Schema.Array(Line).check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (lines: ReadonlyArray<{ readonly sku: string }>) =>
      new Set(lines.map(({ sku }) => sku)).size === lines.length,
    { expected: "one line per SKU" },
  ),
)

/**
 * Places the order from values the caller already read: the customer and
 * each line's price and package. The turn trusts them, so only the app's own
 * route calls it, never a client directly.
 */
export const Place = Actor.command("Place", {
  payload: { customer: Customer, lines: Lines },
  success: Schema.Struct({ total: Schema.Int, shipments: Schema.Array(Schema.String) }),
  error: OrderAlreadyPlaced,
})

/** The order's status, total, charge, shipments and lines. */
export const Summary = Actor.query("Summary", {
  success: Schema.Struct({
    status: OrderStatus,
    customerId: Schema.String,
    total: Schema.Int,
    chargeId: Schema.optional(Schema.String),
    shipments: Schema.Array(Schema.String),
    lines: Schema.Array(Line),
  }),
})

/**
 * Marks the order paid and releases its shipments. Internal: the relay delivers
 * `Charged` and `ChargeFailed` as the `Charge` job's routes.
 */
export const Charged = Actor.command("Charged", {
  payload: { chargeId: Schema.String },
})

/**
 * The charge exhausted its retries or was declined; cancels the shipments only
 * when the provider applied nothing.
 */
export const ChargeFailed = Actor.command("ChargeFailed", { payload: Actor.DeadLetter(Charge) })

/** One customer order: its lines, payment and shipments. */
export const Order = Actor.make("Order", {
  key: OrderId,
  state: OrderState,
  tables: [orderLines],
  events: [OrderPlaced, PaymentCaptured, PaymentFailed],
  jobs: {
    Charge: {
      job: Charge,
      retry: { times: 3, backoff: { base: "200 millis", max: "2 seconds" } },
      onSuccess: Charged,
      onDeadLetter: ChargeFailed,
    },
  },
  access: shopper,
  api: { Place, Summary },
  internal: { Charged, ChargeFailed },
})
