import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BunServices } from "@effect/platform-bun"
import { Clock, Config, Crypto, Effect, FileSystem, ManagedRuntime, Path, Schema } from "effect"
import { Pool } from "pg"
import { migrate } from "@durable-actors/postgres/migrate"
import { makeHandler } from "./app.ts"
import { loadConfig } from "./config.ts"

const runtime = ManagedRuntime.make(BunServices.layer)

const Mail = Schema.fromJsonString(
  Schema.Struct({ to: Schema.String, subject: Schema.String, text: Schema.String }),
)

describe("real PostgreSQL API", () => {
  let database: string
  const origin = "http://localhost:3000"
  const password = "test-password-long-enough"
  const webhookKey = Buffer.from("test-only-webhook-key-with-entropy").toString("base64")
  let pool: Pool
  let admin: Pool
  let capture: string
  let app: ReturnType<typeof makeHandler>
  let config: ReturnType<typeof loadConfig>
  const owner = new Map<string, string>()
  const outsider = new Map<string, string>()
  let orgId: string
  let projectId: string

  const request = Effect.fn(function* (
    path: string,
    body?: Record<string, string | null | undefined>,
    jar = owner,
    extraHeaders: Record<string, string> = {},
  ) {
    const headers = new Headers({
      origin,
      cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
      ...extraHeaders,
    })

    const init: RequestInit = { method: body === undefined ? "GET" : "POST", headers }

    if (body !== undefined) {
      headers.set("content-type", "application/json")
      init.body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)
    }

    const response = yield* Effect.promise(() => app.handler(new Request(`${origin}${path}`, init)))

    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";")
      const separator = pair!.indexOf("=")
      jar.set(pair!.slice(0, separator), pair!.slice(separator + 1))
    }

    return response
  })

  const mail = Effect.fn(function* (email: string, subject: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let text: string | undefined
    yield* Effect.promise(() =>
      expect
        .poll(
          () =>
            runtime.runPromise(
              Effect.gen(function* () {
                for (const file of yield* fs.readDirectory(capture)) {
                  const message = yield* Schema.decodeEffect(Mail)(
                    yield* fs.readFileString(path.join(capture, file)),
                  )

                  if (message.to === email && message.subject === subject) text = message.text
                }

                return text
              }),
            ),
          { timeout: 2_000 },
        )
        .toBeDefined(),
    )

    return text!
  })

  const register = Effect.fn(function* (email: string, jar: Map<string, string>) {
    const signup = yield* request(
      "/auth/sign-up/email",
      { name: email.split("@")[0], email, password },
      jar,
    )

    expect(signup.status, yield* Effect.promise(() => signup.clone().text())).toBe(200)
    expect((yield* Effect.promise(() => signup.json())).token).toBeNull()
    expect((yield* request("/auth/sign-in/email", { email, password }, jar)).status).toBe(403)
    const link = new URL((yield* mail(email, "Verify your email")).split("Verify your email: ")[1]!)
    expect((yield* request(`${link.pathname}${link.search}`, undefined, jar)).status).toBeLessThan(
      400,
    )
    const login = yield* request("/auth/sign-in/email", { email, password }, jar)
    expect(login.status, yield* Effect.promise(() => login.clone().text())).toBe(200)
  })

  beforeAll(
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const adminUrl = yield* Config.String("TEST_DATABASE_URL")
          const crypto = yield* Crypto.Crypto
          database = `project_api_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`
          admin = new Pool({ connectionString: adminUrl })
          yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
          const url = new URL(adminUrl)
          url.pathname = `/${database}`
          yield* Effect.promise(() => migrate(url.href))
          yield* Effect.promise(() => migrate(url.href))
          pool = new Pool({ connectionString: url.href })
          const fs = yield* FileSystem.FileSystem
          capture = yield* fs.makeTempDirectory({ prefix: "project-email-" })
          config = loadConfig({
            NODE_ENV: "test",
            DATABASE_URL: url.href,
            APP_ORIGIN: origin,
            BETTER_AUTH_SECRET: "test-only-secret-with-at-least-32-characters",
            EMAIL_MODE: "capture",
            EMAIL_CAPTURE_DIR: capture,
          })
          app = makeHandler(config)
        }),
      ),
    30_000,
  )

  afterAll(() =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          if (app !== undefined) yield* Effect.promise(() => app.dispose())

          if (pool !== undefined) yield* Effect.promise(() => pool.end())

          if (admin !== undefined) {
            yield* Effect.promise(() =>
              admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
            ).pipe(Effect.ensuring(Effect.promise(() => admin.end())))
          }

          if (capture !== undefined) {
            const fs = yield* FileSystem.FileSystem
            yield* fs.remove(capture, { recursive: true, force: true })
          }
        }),
      )
      .finally(() => runtime.dispose()),
  )

  it("serves health, rejects anonymous access, and supports verification-required signup", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const health = yield* request("/health")
        expect(yield* Effect.promise(() => health.json())).toEqual({ status: "ok" })
        expect((yield* request("/api/dashboard")).status).toBe(401)
        yield* register("owner@example.com", owner)
        const dashboard = yield* request("/api/dashboard")
        expect(yield* Effect.promise(() => dashboard.json())).toMatchObject({
          organization: null,
          members: [],
          projects: [],
          billing: { plan: "free" },
        })
      }),
    ))

  it("creates and activates an organization, persists projects, validates input and rejects CSRF", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const created = yield* request("/api/organization", { name: "Alpha", slug: "alpha" })
        expect(created.status, yield* Effect.promise(() => created.clone().text())).toBe(200)
        orgId = (yield* Effect.promise(() => created.json())).id
        expect(created.headers.getSetCookie().length).toBeGreaterThan(0)
        expect(
          (yield* request("/api/organization", { name: "Another", slug: "alpha" })).status,
        ).toBe(409)
        const session = yield* request("/api/session")
        expect(yield* Effect.promise(() => session.json())).toMatchObject({
          activeOrganizationId: orgId,
        })
        expect(
          (yield* request("/api/projects", { name: "Hidden" }, owner, {
            origin: "https://evil.example",
          })).status,
        ).toBe(403)
        expect((yield* request("/api/projects", { name: " " })).status).toBe(400)
        const project = yield* request("/api/projects", { name: "Alpha private project" })
        expect(project.status, yield* Effect.promise(() => project.clone().text())).toBe(200)
        projectId = (yield* Effect.promise(() => project.json())).id
        expect(
          (yield* Effect.promise(() =>
            pool.query("select organization_id from project where id=$1", [projectId]),
          )).rows[0].organization_id,
        ).toBe(orgId)
        yield* Effect.promise(() => app.dispose())
        app = makeHandler(config)
        const projects = yield* request("/api/projects")
        expect(yield* Effect.promise(() => projects.json())).toEqual([
          { id: projectId, name: "Alpha private project", status: "active" },
        ])
      }),
    ))

  it("isolates tenants and requires an explicitly active authorized membership", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* register("outsider@example.com", outsider)
        expect(
          (yield* request("/api/organization", { name: "Beta", slug: "beta" }, outsider)).status,
        ).toBe(200)
        const projects = yield* request("/api/projects", undefined, outsider)
        expect(yield* Effect.promise(() => projects.json())).toEqual([])
        expect(
          (yield* request("/auth/organization/set-active", { organizationId: orgId }, outsider))
            .status,
        ).toBe(403)

        const outsiderUser = (yield* Effect.promise(() =>
          pool.query('select id from "user" where email=$1', ["outsider@example.com"]),
        )).rows[0].id

        yield* Effect.promise(() =>
          pool.query("update session set active_organization_id=$1 where user_id=$2", [
            orgId,
            outsiderUser,
          ]),
        )
        expect((yield* request("/api/projects", undefined, outsider)).status).toBe(403)
        const outsiderDashboard = yield* request("/api/dashboard", undefined, outsider)
        expect((yield* Effect.promise(() => outsiderDashboard.json())).organization).toBeNull()
        yield* request("/auth/organization/set-active", { organizationId: null })
        const dashboard = yield* request("/api/dashboard")
        expect((yield* Effect.promise(() => dashboard.json())).organization.id).toBe(orgId)
        expect((yield* request("/api/projects", { name: "No implicit write tenant" })).status).toBe(
          403,
        )
        yield* request("/auth/organization/set-active", { organizationId: orgId })
      }),
    ))

  it("supports invitations while enforcing member billing permissions", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const invitation = yield* request("/auth/organization/invite-member", {
          email: "outsider@example.com",
          role: "member",
          organizationId: orgId,
        })

        expect(invitation.status, yield* Effect.promise(() => invitation.clone().text())).toBe(200)
        const invitationId = (yield* Effect.promise(() => invitation.json())).id
        expect(yield* mail("outsider@example.com", "Join Alpha")).toContain(
          `/accept-invitation?invitationId=${invitationId}`,
        )
        expect(
          (yield* request("/auth/organization/accept-invitation", { invitationId }, outsider))
            .status,
        ).toBe(200)
        expect(
          (yield* request("/auth/organization/set-active", { organizationId: orgId }, outsider))
            .status,
        ).toBe(200)
        expect((yield* request("/api/billing/checkout", { plan: "pro" }, outsider)).status).toBe(
          403,
        )
        expect((yield* request("/api/billing/portal", {}, outsider)).status).toBe(403)
        expect((yield* request("/api/billing/checkout", { plan: "pro" })).status).toBe(503)
        expect(
          (yield* request(
            "/auth/organization/invite-member",
            { email: "new@example.com", role: "owner", organizationId: orgId },
            outsider,
          )).status,
        ).toBe(403)
      }),
    ))

  it("verifies webhook signatures and applies duplicate/reordered events transactionally", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => app.dispose())
        app = makeHandler({
          ...config,
          polar: {
            accessToken: "test-never-used",
            productId: "pro-product",
            webhookSecret: `whsec_${webhookKey}`,
            sandbox: true,
            origin,
          },
        })

        const webhook = Effect.fn(function* (
          id: string,
          eventAt: string,
          status: string,
          valid: boolean = true,
        ) {
          const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            type: "subscription.updated",
            timestamp: eventAt,
            data: {
              id: "subscription-1",
              customer_id: "customer-1",
              product_id: "pro-product",
              customer: { external_id: orgId },
              status,
              current_period_end: "2026-12-01T00:00:00Z",
            },
          })

          const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000).toString()

          const key = yield* Effect.promise(() =>
            crypto.subtle.importKey(
              "raw",
              Buffer.from(webhookKey, "base64"),
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign"],
            ),
          )

          const signed = yield* Effect.promise(() =>
            crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
          )

          const signature = Buffer.from(signed).toString("base64")

          return yield* Effect.promise(() =>
            app.handler(
              new Request(`${origin}/api/billing/webhook`, {
                method: "POST",
                body,
                headers: {
                  "webhook-id": id,
                  "webhook-timestamp": timestamp,
                  "webhook-signature": `v1,${valid ? signature : "invalid"}`,
                },
              }),
            ),
          )
        })

        expect((yield* webhook("invalid", "2026-09-19T12:00:00Z", "active", false)).status).toBe(
          400,
        )
        expect((yield* webhook("latest", "2026-09-19T12:00:00Z", "active")).status).toBe(204)
        expect((yield* webhook("latest", "2026-09-19T12:00:00Z", "canceled")).status).toBe(204)
        expect((yield* webhook("older", "2026-09-18T12:00:00Z", "canceled")).status).toBe(204)
        expect(
          (yield* Effect.promise(() =>
            pool.query("select plan,status from organization_billing where organization_id=$1", [
              orgId,
            ]),
          )).rows,
        ).toEqual([{ plan: "pro", status: "active" }])
        expect(
          (yield* Effect.promise(() => pool.query("select count(*)::int n from billing_webhook")))
            .rows[0].n,
        ).toBe(2)
        expect((yield* webhook("newer", "2026-09-20T12:00:00Z", "canceled")).status).toBe(204)
        const dashboard = yield* request("/api/dashboard")
        expect((yield* Effect.promise(() => dashboard.json())).billing).toMatchObject({
          plan: "free",
          status: "canceled",
        })
      }),
    ))

  it("resets a password from captured mail, revokes old sessions and supports sign-out", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        expect(
          (yield* request("/auth/request-password-reset", {
            email: "owner@example.com",
            redirectTo: `${origin}/reset-password`,
          })).status,
        ).toBe(200)

        const reset = new URL(
          (yield* mail("owner@example.com", "Reset your password")).split(
            "Reset your password: ",
          )[1]!,
        )

        const redirect = yield* request(`${reset.pathname}${reset.search}`)
        const token = new URL(redirect.headers.get("location")!).searchParams.get("token")
        expect(token).toBeTruthy()
        expect(
          (yield* request("/auth/reset-password", {
            token,
            newPassword: "replacement-password-long-enough",
          })).status,
        ).toBe(200)
        expect((yield* request("/api/session")).status).toBe(401)
        expect(
          (yield* request("/auth/sign-in/email", { email: "owner@example.com", password })).status,
        ).toBe(401)
        expect(
          (yield* request("/auth/sign-in/email", {
            email: "owner@example.com",
            password: "replacement-password-long-enough",
          })).status,
        ).toBe(200)
        expect((yield* request("/auth/sign-out", {})).status).toBe(200)
        expect((yield* request("/api/session")).status).toBe(401)
      }),
    ))
})
