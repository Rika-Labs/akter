import { Crypto, DateTime, Effect, Layer, Schema } from "effect"
import { BunHttpServer } from "@effect/platform-bun"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  Cookies,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { Api, Conflict, Forbidden, Unauthorized, Unavailable } from "@project/contracts"
import { Auth, processRuntimeLayer } from "@project/auth"
import { databaseLayer } from "@project/database"
import { captureLayer, resendLayer } from "@project/email"
import { Billing, disabledLayer, polarLayer } from "@project/billing"
import { InvalidWebhook, Subscription, verifyWebhook } from "@project/billing/webhook"
import { observabilityLayer } from "@project/observability"
import type { Config } from "./config.ts"
import { HealthLive } from "./health.ts"

const authenticated = Effect.fn("Api.authenticated")(function* () {
  const auth = yield* Auth

  const result = yield* auth
    .getSession()
    .pipe(Effect.mapError(() => Unauthorized.make({ message: "Session is invalid" })))

  if (result === null || !result.user.emailVerified)
    return yield* Unauthorized.make({ message: "Sign in with a verified email" })

  return result
})

const mutation = Effect.fn("Api.mutation")(function* (origin: string) {
  const request = yield* HttpServerRequest.HttpServerRequest

  if (request.headers.origin !== origin)
    return yield* Forbidden.make({ message: "Invalid request origin" })
})

type Org = { id: string; name: string; slug: string; role: string }

const organizationFor = Effect.fn("Api.organizationFor")(function* (
  session: Effect.Success<ReturnType<typeof authenticated>>,
  displayOnly: boolean = false,
) {
  const sql = yield* SqlClient.SqlClient
  const active = session.session.activeOrganizationId

  const rows =
    active !== undefined && active !== null
      ? yield* sql<Org>`SELECT o.id,o.name,o.slug,m.role FROM organization o JOIN member m ON m.organization_id=o.id WHERE m.user_id=${session.user.id} AND o.id=${active}`.pipe(
          Effect.orDie,
        )
      : displayOnly
        ? yield* sql<Org>`SELECT o.id,o.name,o.slug,m.role FROM organization o JOIN member m ON m.organization_id=o.id WHERE m.user_id=${session.user.id} ORDER BY m.created_at,o.id LIMIT 1`.pipe(
            Effect.orDie,
          )
        : []

  return rows[0] ?? null
})

const activeOrganization = Effect.fn("Api.activeOrganization")(function* (admin: boolean = false) {
  const session = yield* authenticated()
  const org = yield* organizationFor(session)

  if (org === null || (admin && !["owner", "admin"].includes(org.role)))
    return yield* Forbidden.make({ message: "Organization permission required" })

  return { session, org }
})

const projectsFor = Effect.fn("Api.projectsFor")(function* (organizationId: string) {
  const sql = yield* SqlClient.SqlClient

  return yield* sql<{
    id: string
    name: string
    status: "active" | "archived"
  }>`SELECT id,name,status FROM project WHERE organization_id=${organizationId} ORDER BY created_at,id`.pipe(
    Effect.orDie,
  )
})

const accountLive = (config: Config) =>
  HttpApiBuilder.group(Api, "account", (handlers) =>
    handlers
      .handle(
        "session",
        Effect.fn("Api.session")(function* () {
          const session = yield* authenticated()

          return {
            user: { id: session.user.id, name: session.user.name, email: session.user.email },
            activeOrganizationId: session.session.activeOrganizationId ?? null,
          }
        }),
      )
      .handle(
        "dashboard",
        Effect.fn("Api.dashboard")(function* () {
          const session = yield* authenticated()
          const organization = yield* organizationFor(session, true)
          const sql = yield* SqlClient.SqlClient

          if (organization === null)
            return {
              user: session.user,
              organization: null,
              members: [],
              billing: { plan: "free" as const, status: "inactive" },
              projects: [],
            }

          const members = yield* sql<{
            id: string
            name: string
            email: string
            role: string
          }>`SELECT m.id,u.name,u.email,m.role FROM member m JOIN "user" u ON u.id=m.user_id WHERE m.organization_id=${organization.id} ORDER BY m.created_at,m.id`.pipe(
            Effect.orDie,
          )

          const billing = yield* sql<{
            plan: "free" | "pro"
            status: string
            renewalDate: string | null
          }>`SELECT plan,status,renewal_date::text AS "renewalDate" FROM organization_billing WHERE organization_id=${organization.id}`.pipe(
            Effect.orDie,
          )

          return {
            user: session.user,
            organization,
            members,
            billing:
              billing[0] !== undefined
                ? {
                    plan: billing[0].plan,
                    status: billing[0].status,
                    renewalDate: billing[0].renewalDate ?? undefined,
                  }
                : { plan: "free" as const, status: "inactive" },
            projects: yield* projectsFor(organization.id),
          }
        }),
      )
      .handle(
        "organization",
        Effect.fn("Api.organization")(function* ({ payload }) {
          yield* mutation(config.origin)
          yield* authenticated()
          const auth = yield* Auth
          const request = yield* HttpServerRequest.HttpServerRequest
          const headers = new Headers(request.headers)
          // The wrapper explicitly exposes raw auth for returnHeaders overloads.
          const raw = yield* auth.auth

          const result = yield* Effect.tryPromise({
            try: () => raw.api.createOrganization({ body: payload, headers, returnHeaders: true }),
            catch: () =>
              Conflict.make({
                message: "Organization could not be created; slug may already exist",
              }),
          })

          const org = result.response

          const active = yield* Effect.tryPromise({
            try: () =>
              raw.api.setActiveOrganization({
                body: { organizationId: org.id },
                headers,
                returnHeaders: true,
              }),
            catch: () => Conflict.make({ message: "Organization created; select it to continue" }),
          })

          const cookies = [...result.headers.getSetCookie(), ...active.headers.getSetCookie()]
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(
              HttpServerResponse.replaceCookies(
                response,
                Cookies.merge(response.cookies, Cookies.fromSetCookie(cookies)),
              ),
            ),
          )

          return { id: org.id, name: org.name, slug: org.slug, role: "owner" }
        }),
      )
      .handle(
        "projects",
        Effect.fn("Api.projects")(function* () {
          const { org } = yield* activeOrganization()

          return yield* projectsFor(org.id)
        }),
      )
      .handle(
        "createProject",
        Effect.fn("Api.createProject")(function* ({ payload }) {
          yield* mutation(config.origin)
          const { org, session } = yield* activeOrganization()
          const sql = yield* SqlClient.SqlClient
          const crypto = yield* Crypto.Crypto
          const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie)

          const rows = yield* sql<{
            id: string
            name: string
            status: "active" | "archived"
          }>`INSERT INTO project(id,organization_id,name) SELECT ${id},${org.id},${payload.name} WHERE EXISTS (SELECT 1 FROM member WHERE organization_id=${org.id} AND user_id=${session.user.id}) RETURNING id,name,status`.pipe(
            Effect.orDie,
          )

          if (rows[0] === undefined)
            return yield* Forbidden.make({ message: "Membership no longer exists" })

          return rows[0]
        }),
      )
      .handle(
        "checkout",
        Effect.fn("Api.checkout")(function* () {
          yield* mutation(config.origin)
          const { org } = yield* activeOrganization(true)
          const billing = yield* Billing

          return yield* billing
            .checkout(org.id)
            .pipe(Effect.mapError((error) => Unavailable.make({ message: error.message })))
        }),
      )
      .handle(
        "portal",
        Effect.fn("Api.portal")(function* () {
          yield* mutation(config.origin)
          const { org } = yield* activeOrganization(true)
          const billing = yield* Billing

          return yield* billing
            .portal(org.id)
            .pipe(Effect.mapError((error) => Unavailable.make({ message: error.message })))
        }),
      ),
  )

const webhook = (config: Config) =>
  HttpRouter.add(
    "POST",
    "/api/billing/webhook",
    Effect.gen(function* () {
      if (config.polar === undefined) return HttpServerResponse.empty({ status: 503 })
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* request.text

      if (body.length > 1_048_576) return HttpServerResponse.empty({ status: 413 })

      const event = yield* verifyWebhook(
        body,
        new Headers(request.headers),
        config.polar.webhookSecret,
      )

      if (!event.type.startsWith("subscription.")) return HttpServerResponse.empty({ status: 204 })

      const subscription = yield* Schema.decodeUnknownEffect(Subscription)(event.data).pipe(
        Effect.mapError(() => InvalidWebhook.make({ message: "Invalid subscription" })),
      )

      if (
        subscription.product_id !== config.polar.productId ||
        subscription.customer.external_id === null
      )
        return HttpServerResponse.empty({ status: 204 })
      const sql = yield* SqlClient.SqlClient
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const inserted =
              yield* sql`INSERT INTO billing_webhook(id) VALUES (${event.id}) ON CONFLICT DO NOTHING RETURNING id`

            if (inserted.length === 0) return
            const plan = ["active", "trialing"].includes(subscription.status) ? "pro" : "free"
            yield* sql`INSERT INTO organization_billing(organization_id,subscription_id,customer_id,plan,status,renewal_date,event_at)
      SELECT ${subscription.customer.external_id},${subscription.id},${subscription.customer_id},${plan},${subscription.status},${subscription.current_period_end !== null ? DateTime.formatIso(subscription.current_period_end) : null},${DateTime.formatIso(event.timestamp)}
      WHERE EXISTS (SELECT 1 FROM organization WHERE id=${subscription.customer.external_id})
      ON CONFLICT(organization_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,plan=excluded.plan,status=excluded.status,renewal_date=excluded.renewal_date,event_at=excluded.event_at
      WHERE organization_billing.event_at < excluded.event_at`
          }),
        )
        .pipe(Effect.orDie)

      return HttpServerResponse.empty({ status: 204 })
    }).pipe(
      Effect.catchTag("InvalidWebhook", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      ),
    ),
  )

export const applicationLayer = (config: Config) => {
  const database = databaseLayer(config.databaseUrl)

  const email =
    config.emailMode === "capture"
      ? captureLayer(config.captureDirectory)
      : resendLayer({ apiKey: config.resendApiKey!, from: config.emailFrom! })

  const services = Layer.mergeAll(
    database,
    Auth.layer(config).pipe(Layer.provide(Layer.merge(database, email))),
    processRuntimeLayer,
    config.polar !== undefined ? polarLayer(config.polar) : disabledLayer,
  ).pipe(Layer.provideMerge(BunHttpServer.layerHttpServices))

  const api = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Layer.merge(HealthLive, accountLive(config))),
  )

  const auth = HttpRouter.add(
    "*",
    "/auth/*",
    Effect.gen(function* () {
      return yield* (yield* Auth).fetch
    }),
  )

  return Layer.mergeAll(api, auth, webhook(config)).pipe(
    HttpRouter.provideRequest(services),
    Layer.provide(services),
    Layer.provide(observabilityLayer(config.axiom)),
  )
}

export const makeHandler = (config: Config) =>
  HttpRouter.toWebHandler(applicationLayer(config), { disableLogger: true })
