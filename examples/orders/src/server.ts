import { Actor, type ActorError, Unauthorized, User } from "@durable-actors/core"
import { Actors, Auth } from "@durable-actors/core/runtime"
import { Effect, Layer, Match, Option, Schema } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { TENANT } from "./access.ts"
import { quote } from "./catalog/repository.ts"
import { Order, OrderId } from "./order/contract.ts"
import { salesBySku } from "./reports/sales.ts"
import { Shipment } from "./shipment/contract.ts"

/**
 * A stand-in for a real identity provider: the bearer token is the customer
 * id. Use `Auth.jwt` in production.
 */
const authenticate = (headers: Headers.Headers) =>
  Option.match(Headers.get(headers, "authorization"), {
    onNone: () => Effect.fail(Unauthorized.make({ code: "missing_credentials" })),
    onSome: (header) => {
      const match = /^Bearer ([a-z0-9-]{1,64})$/.exec(header)

      return match === null
        ? Effect.fail(Unauthorized.make({ code: "invalid_credentials" }))
        : Effect.succeed({ tenant: TENANT, caller: User.make({ subject: match[1]! }) })
    },
  })

/**
 * Authenticates `Authorization: Bearer <customer>` as that customer; a stand-
 * in for a real identity provider.
 */
export const demoAuth = Auth.make((request) => authenticate(request.headers))

/**
 * Shipments are served as they are: `Tracking` is a plain read. The served
 * layer also answers `POST /command-ids`, where a client gets the id it sends
 * as `Idempotency-Key` and reuses on every retry.
 */
const served = Actors.serve({
  actors: [Shipment],
  auth: demoAuth,
  openapi: { path: "/openapi.json", title: "Orders" },
})

const PlaceBody = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      sku: Schema.NonEmptyString,
      quantity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
    }),
  ).check(Schema.isMinLength(1)),
})

interface ProblemDetail {
  readonly skus?: ReadonlyArray<string>
  readonly isRetryable?: boolean
}

const problem = (status: number, error: string, detail?: ProblemDetail) =>
  HttpServerResponse.jsonUnsafe({ error, ...detail }, { status })

/** Answers an `ActorError` with its reason; the retryable reasons (unavailable, timeout, capacity) are 503. */
const actorFailure = (error: ActorError) =>
  problem(
    Match.value(error.reason).pipe(
      Match.tags({
        CommandConflict: () => 409,
        CommandExpired: () => 410,
        InvalidCommandId: () => 400,
        Unauthorized: () => 403,
        NotCreated: () => 404,
      }),
      Match.orElse(() => 503),
    ),
    error.reason._tag,
    { isRetryable: error.isRetryable },
  )

/** Runs `body` as the request's caller, or answers 401. */
const authenticated = <E, R>(
  body: (identity: {
    readonly tenant: string
    readonly subject: string
  }) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const identity = yield* authenticate(request.headers).pipe(Effect.option)

    if (Option.isNone(identity)) return problem(401, "Unauthorized")

    const { tenant, caller } = identity.value

    return yield* body({ tenant, subject: caller.subject }).pipe(
      Actor.as(caller),
      Actor.tenant(tenant),
    )
  })

const orderId = HttpRouter.params.pipe(
  Effect.flatMap(({ orderId }) => Schema.decodeUnknownEffect(OrderId)(orderId)),
  Effect.option,
)

/**
 * `POST /orders/:orderId` with `Idempotency-Key`. The route reads the
 * customer and the products with the app's own Drizzle client, outside the
 * order's turn, and passes the prices and packages it read as `Place` input.
 * A retry with the same key replays the first result; a retry after a price
 * change sends a different input under the same key and gets 409.
 */
const placeOrder = HttpRouter.add(
  "POST",
  "/orders/:orderId",
  authenticated(({ subject }) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const id = yield* orderId
      const key = Headers.get(request.headers, "idempotency-key")
      const body = yield* HttpServerRequest.schemaBodyJson(PlaceBody).pipe(Effect.option)

      if (Option.isNone(id)) return problem(400, "InvalidOrderId")

      if (Option.isNone(key)) return problem(400, "MissingIdempotencyKey")

      if (Option.isNone(body)) return problem(400, "InvalidInput")

      const input = yield* quote({ customerId: subject, items: body.value.items })
      const order = yield* Order.get(id.value)
      const placed = yield* order.Place(input).pipe(Actor.commandId(key.value))

      return HttpServerResponse.jsonUnsafe({ orderId: id.value, ...placed })
    }).pipe(
      Effect.catchTags({
        UnknownCustomer: (error) => Effect.succeed(problem(422, error._tag)),
        UnknownProducts: (error) => Effect.succeed(problem(422, error._tag, { skus: error.skus })),
        OrderAlreadyPlaced: (error) => Effect.succeed(problem(409, error._tag)),
        ActorError: (error) => Effect.succeed(actorFailure(error)),
      }),
    ),
  ),
)

/** `GET /orders/:orderId`: the order's committed summary, for its own customer only. */
const getOrder = HttpRouter.add(
  "GET",
  "/orders/:orderId",
  authenticated(({ subject }) =>
    Effect.gen(function* () {
      const id = yield* orderId

      if (Option.isNone(id)) return problem(400, "InvalidOrderId")

      const summary = yield* (yield* Order.get(id.value)).Summary()

      return summary.customerId === subject
        ? HttpServerResponse.jsonUnsafe(summary)
        : problem(404, "NotFound")
    }).pipe(Effect.catchTag("ActorError", (error) => Effect.succeed(actorFailure(error)))),
  ),
)

/** `GET /reports/sales`: plain SQL across every order of the tenant, outside any turn. */
const salesReport = HttpRouter.add(
  "GET",
  "/reports/sales",
  authenticated(({ tenant }) =>
    salesBySku(tenant).pipe(Effect.map((rows) => HttpServerResponse.jsonUnsafe(rows))),
  ),
)

/** Every route of the orders app. */
export const routes = Layer.mergeAll(served, placeOrder, getOrder, salesReport)
