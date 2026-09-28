import { Actor } from "@durable-actors/core"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { Effect, Schema } from "effect"

export const OrderId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)).pipe(
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

export const Line = Schema.Struct({
  sku: Schema.NonEmptyString,
  name: Schema.String,
  quantity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  unitPrice: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  package: Schema.NonEmptyString,
})

export const Customer = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  email: Schema.String,
})

export class OrderPlaced extends Actor.Event<OrderPlaced>()("OrderPlaced", {
  customerId: Schema.String,
  total: Schema.Int,
  shipments: Schema.Array(Schema.String),
}) {}

export class PaymentCaptured extends Actor.Event<PaymentCaptured>()("PaymentCaptured", {
  chargeId: Schema.String,
}) {}

export class PaymentFailed extends Actor.Event<PaymentFailed>()("PaymentFailed", {
  /** The provider may have applied the charge; an operator must check before anything else. */
  ambiguous: Schema.Boolean,
}) {}

/**
 * Charges the customer after `Place` commits. The executor runs outside any
 * transaction, possibly more than once, and passes its effect id to the
 * provider as the idempotency key.
 */
export class Charge extends Actor.effect<Charge>()("Charge", {
  input: { customerId: Schema.String, amount: Schema.Int },
  success: Schema.Struct({ chargeId: Schema.String }),
}) {}

export class OrderAlreadyPlaced extends Schema.TaggedError<OrderAlreadyPlaced>()(
  "OrderAlreadyPlaced",
  {},
) {}

export const OrderStatus = Schema.Literals([
  "new",
  "awaiting_payment",
  "paid",
  "payment_failed",
  "payment_unknown",
])

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
  input: Schema.Struct({ customer: Customer, lines: Lines }),
  output: Schema.Struct({ total: Schema.Int, shipments: Schema.Array(Schema.String) }),
  errors: [OrderAlreadyPlaced],
})

export const Summary = Actor.query("Summary", {
  output: Schema.Struct({
    status: OrderStatus,
    customerId: Schema.String,
    total: Schema.Int,
    chargeId: Schema.optional(Schema.String),
    shipments: Schema.Array(Schema.String),
    lines: Schema.Array(Line),
  }),
})

// Internal: the relay delivers these as the Charge effect's routes.
export const Charged = Actor.command("Charged", {
  input: Schema.Struct({ chargeId: Schema.String }),
})

export const ChargeFailed = Actor.command("ChargeFailed", { input: Actor.DeadLetter(Charge) })

export const Order = Actor.make("Order", {
  key: OrderId,
  state: OrderState,
  tables: [orderLines],
  events: [OrderPlaced, PaymentCaptured, PaymentFailed],
  effects: [Charge],
  api: { Place, Summary },
  internal: { Charged, ChargeFailed },
  policy: {
    effects: {
      Charge: {
        retry: { times: 3, backoff: { base: "200 millis", max: "2 seconds" } },
        onSuccess: Charged,
        onDeadLetter: ChargeFailed,
      },
    },
  },
})
