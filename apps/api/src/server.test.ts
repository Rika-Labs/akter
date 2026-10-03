import { expect, it } from "@effect/vitest"
import * as Cloud from "@akter/cloud-api"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { Config, Crypto, Effect, Layer, Redacted, Schedule, Schema } from "effect"
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http"
import { SqlClient } from "effect/sql"
import { infrastructure, routes } from "./server.ts"
import type { ApiOptions } from "./config.ts"

const enterpriseOrganizations: Array<string> = []
const options = (databaseUrl: Redacted.Redacted<string>): ApiOptions => ({
  enterpriseOrganizations,
  databaseUrl,
  secret: Redacted.make("api-integration-test-secret-not-for-production"),
  origin: "http://localhost:3001",
  port: 0,
  production: false,
  emailMode: "local",
  emailFrom: "auth@localhost",
})
const baseOrigin = "http://localhost:3001"
const TestLive = Layer.unwrap(
  Config.Redacted("TEST_DATABASE_URL").pipe(Effect.map(options), Effect.map(infrastructure)),
).pipe(Layer.provideMerge(FetchHttpClient.layer), Layer.provideMerge(BunCrypto.layer))
const testInfrastructure: Layer.Layer<Layer.Success<typeof TestLive>, unknown, never> = TestLive

interface RequestInput {
  readonly path: string
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  readonly body?: Schema.Json
  readonly cookie?: string
  readonly key?: string
  readonly origin?: string
}

const testServer = Effect.gen(function* () {
  const context = yield* Effect.context<Layer.Success<typeof testInfrastructure>>()
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        routes.pipe(
          Layer.provide(Layer.succeedContext(context)),
          Layer.provide(BunHttpServer.layerHttpServices),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  )
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => web.handler(request) }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )
  const origin = `http://127.0.0.1:${server.port}`
  const client = yield* HttpClient.HttpClient
  const request = Effect.fn(function* (input: RequestInput) {
    const requestHeaders = new Headers({
      "content-type": "application/json",
      origin: input.origin ?? baseOrigin,
    })
    if (input.cookie !== undefined) requestHeaders.set("cookie", input.cookie)
    if (input.key !== undefined) requestHeaders.set("x-api-key", input.key)
    let httpRequest = HttpClientRequest.make(input.method ?? "GET")(`${origin}${input.path}`).pipe(
      HttpClientRequest.setHeaders(requestHeaders),
    )
    if (input.body !== undefined)
      httpRequest = yield* HttpClientRequest.bodyJson(input.body)(httpRequest)
    return yield* client
      .execute(httpRequest)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
  })
  return { request, origin }
})

const read = <A, I>(response: HttpClientResponse.HttpClientResponse, schema: Schema.Codec<A, I>) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
    Effect.orDie,
  )
const BasicUser = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String, emailVerified: Schema.Boolean }),
})

const password = "correct-horse-battery-staple-42"

type Requester = Effect.Success<typeof testServer>["request"]

const signupWith = (request: Requester, sql: SqlClient.SqlClient, suffix: string) =>
  Effect.fn(function* (name: string) {
    const email = `${name}-${suffix}@example.com`
    const response = yield* request({
      path: "/auth/sign-up/email",
      method: "POST",
      body: { name, email, password },
    })
    expect(response.status).toBe(200)
    const user = yield* read(response, BasicUser)
    expect(user.user.emailVerified).toBe(false)
    const denied = yield* request({
      path: "/auth/sign-in/email",
      method: "POST",
      body: { email, password },
    })
    expect(denied.status).toBe(403)
    const [message] = yield* sql<{
      body: string
      subject: string
    }>`SELECT body, subject FROM cloud_email_outbox WHERE recipient = ${email} ORDER BY id DESC LIMIT 1`.pipe(Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (rows) => rows.length > 0 }), Effect.timeout("5 seconds"), Effect.orDie)
    expect(message?.subject).toBe("Verify your email")
    if (message === undefined) return yield* Effect.die(new Error("Verification email missing"))
    const verifyPath = new URL(message.body).pathname + new URL(message.body).search
    const verified = yield* request({ path: verifyPath })
    expect(verified.status).toBe(302)
    const login = yield* request({
      path: "/auth/sign-in/email",
      method: "POST",
      body: { email, password },
    })
    expect(login.status).toBe(200)
    const cookie = Cookies.toCookieHeader(login.cookies)
    expect(cookie).toContain("better-auth.session_token=")
    return { email, cookie, id: user.user.id }
  })

it.layer(TestLive, { excludeTestServices: true })("cloud API over real Postgres and Bun HTTP", (it) => {
  it.effect(
    "scopes deployment records, serializes creation, and releases the environment after a recorded build failure",
    () =>
      Effect.gen(function* () {
        const { request } = yield* testServer
        const sql = yield* SqlClient.SqlClient
        const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
        const signup = signupWith(request, sql, suffix)
        const owner = yield* signup("deploy-owner")
        const outsider = yield* signup("deploy-outsider")
        const organization = yield* read(
          yield* request({
            path: "/api/organizations",
            method: "POST",
            cookie: owner.cookie,
            body: { name: "Deploy organization", slug: `deploy-${suffix}` },
          }),
          Cloud.OrganizationMembership,
        )
        const project = yield* read(
          yield* request({
            path: `/api/organizations/${organization.organization.id}/projects`,
            method: "POST",
            cookie: owner.cookie,
            body: { name: "Deploy project", slug: "deployer", homeRegion: "us-east-1" },
          }),
          Cloud.Project,
        )
        const path = `/api/projects/${project.id}/deployments`
        const create = (cookie?: string) =>
          request({
            path,
            method: "POST",
            cookie,
            body: { environment: "production", commitSha: "abcdef123456" },
          })
        expect((yield* create()).status).toBe(401)
        expect((yield* create(outsider.cookie)).status).toBe(403)
        const concurrent = yield* Effect.forEach(
          Array.from({ length: 8 }),
          () => create(owner.cookie),
          { concurrency: "unbounded" },
        )
        expect(concurrent.map((response) => response.status).sort()).toEqual([
          200, 409, 409, 409, 409, 409, 409, 409,
        ])
        const created = yield* read(
          concurrent.find((response) => response.status === 200)!,
          Cloud.DeploymentDetail,
        )
        expect(created.status).toBe("in-progress")
        expect(
          (yield* request({ path: `${path}/${created.id}`, cookie: outsider.cookie })).status,
        ).toBe(403)
        const failed = yield* read(
          yield* request({
            path: `${path}/${created.id}/build-failure`,
            method: "POST",
            cookie: owner.cookie,
            body: { reason: "The external build did not produce an image" },
          }),
          Cloud.DeploymentDetail,
        )
        expect(failed.status).toBe("failed")
        expect(failed.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
          "build:failed",
          "migrate:skipped",
          "start-runners:skipped",
          "drain-previous:skipped",
        ])
        expect(
          yield* sql`SELECT current_deployment_id FROM cloud_environment WHERE project_id = ${project.id} AND name = 'production'`,
        ).toEqual([{ current_deployment_id: null }])
        const second = yield* read(yield* create(owner.cookie), Cloud.DeploymentDetail)
        const firstPage = yield* read(
          yield* request({ path: `${path}?limit=1`, cookie: owner.cookie }),
          Cloud.Page(Cloud.DeploymentSummary),
        )
        expect(firstPage.items.map((item) => item.id)).toEqual([second.id])
        expect(firstPage.nextCursor).not.toBeNull()
        const secondPage = yield* read(
          yield* request({
            path: `${path}?limit=1&cursor=${firstPage.nextCursor!}`,
            cookie: owner.cookie,
          }),
          Cloud.Page(Cloud.DeploymentSummary),
        )
        expect(secondPage.items.map((item) => item.id)).toEqual([created.id])
        expect(secondPage.nextCursor).toBeNull()
        expect(
          (yield* request({
            path: `${path}/${created.id}/rollback`,
            method: "POST",
            cookie: owner.cookie,
          })).status,
        ).toBe(409)
        yield* request({
          path: `${path}/${second.id}/build-failure`,
          method: "POST",
          cookie: owner.cookie,
          body: { reason: "Fixture cleanup" },
        })
      }),
    { timeout: 60000 },
  )

  it.effect(
    "verifies emails, isolates organizations, persists control-plane records and immediately refuses revoked keys",
    () =>
      Effect.gen(function* () {
        const { request, origin } = yield* testServer
        const sql = yield* SqlClient.SqlClient
        const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
        const signup = signupWith(request, sql, suffix)
        const alice = yield* signup("alice")
        const bob = yield* signup("bob")
        const outsider = yield* signup("outsider")
        const wrong = yield* request({
          path: "/auth/sign-in/email",
          method: "POST",
          body: { email: alice.email, password: "wrong-password-123456" },
        })
        expect(wrong.status).toBe(401)
        expect(Cookies.toSetCookieHeaders(wrong.cookies)).toEqual([])
        const me = yield* request({ path: "/api/me", cookie: alice.cookie })
        expect(me.status).toBe(200)
        expect((yield* read(me, Cloud.Me)).user?.email).toBe(alice.email)
        expect((yield* request({ path: "/api/me" })).status).toBe(401)
        const created = yield* request({
          path: "/api/organizations",
          method: "POST",
          cookie: alice.cookie,
          body: { name: "Alice organization", slug: `alice-${suffix}` },
        })
        expect(created.status).toBe(200)
        const membership = yield* read(created, Cloud.OrganizationMembership)
        expect(membership.role).toBe("owner")
        const org = membership.organization.id
        const teamResponse = yield* request({
          path: "/auth/organization/create-team",
          method: "POST",
          cookie: alice.cookie,
          body: { organizationId: org, name: "Operators" },
        })
        expect(teamResponse.status).toBe(200)
        const team = yield* read(
          teamResponse,
          Schema.Struct({ id: Schema.String, name: Schema.String }),
        )
        expect(team.name).toBe("Operators")
        expect(
          (yield* request({
            path: "/auth/organization/update-team",
            method: "POST",
            cookie: outsider.cookie,
            body: { teamId: team.id, data: { name: "Stolen" } },
          })).status,
        ).toBe(403)
        expect(
          (yield* sql<{ name: string }>`SELECT name FROM team WHERE id = ${team.id}`)[0]?.name,
        ).toBe("Operators")
        expect(
          (yield* request({ path: `/api/organizations/${org}/members`, cookie: outsider.cookie }))
            .status,
        ).toBe(403)
        const invited = yield* request({
          path: `/api/organizations/${org}/invitations`,
          method: "POST",
          cookie: alice.cookie,
          body: { email: bob.email, role: "member" },
        })
        expect(invited.status).toBe(200)
        const invite = yield* read(invited, Cloud.Invitation)
        const invitationMessages = yield* sql<{
          subject: string
        }>`SELECT subject FROM cloud_email_outbox WHERE recipient = ${bob.email} AND subject LIKE 'Join %'`
        expect(invitationMessages).toHaveLength(1)
        expect(
          (yield* request({
            path: `/api/invitations/${invite.id}/accept`,
            method: "POST",
            cookie: outsider.cookie,
          })).status,
        ).toBe(403)
        expect(
          (yield* request({ path: `/api/organizations/${org}`, cookie: bob.cookie })).status,
        ).toBe(403)
        const accepted = yield* request({
          path: `/api/invitations/${invite.id}/accept`,
          method: "POST",
          cookie: bob.cookie,
        })
        expect(accepted.status).toBe(200)
        expect((yield* read(accepted, Cloud.OrganizationMembership)).role).toBe("member")
        expect(
          (yield* request({
            path: `/api/organizations/${org}/api-keys`,
            method: "POST",
            cookie: bob.cookie,
            body: { name: "Forbidden", permission: "admin" },
          })).status,
        ).toBe(403)
        const projectResponse = yield* request({
          path: `/api/organizations/${org}/projects`,
          method: "POST",
          cookie: alice.cookie,
          body: { name: "First project", slug: "first-project", homeRegion: "us-west-2" },
        })
        expect(projectResponse.status).toBe(200)
        const project = yield* read(projectResponse, Cloud.Project)
        expect(project.status).toBe("empty")
        const envResponse = yield* request({
          path: `/api/projects/${project.id}/environments`,
          cookie: alice.cookie,
        })
        expect(envResponse.status).toBe(200)
        const environments = yield* read(envResponse, Schema.Array(Cloud.Environment))
        expect(environments.map((env) => env.name).sort()).toEqual(["dev", "production", "staging"])
        expect(
          (yield* request({ path: `/api/projects/${project.id}`, cookie: outsider.cookie })).status,
        ).toBe(403)
        const preferences = yield* request({
          path: "/api/me/preferences",
          method: "PATCH",
          cookie: alice.cookie,
          body: { theme: "dark", timeZone: "America/Los_Angeles" },
        })
        expect(preferences.status).toBe(200)
        expect((yield* read(preferences, Cloud.Preferences)).theme).toBe("dark")
        const freshPreferences = yield* request({
          path: "/api/me/preferences",
          cookie: alice.cookie,
        })
        expect((yield* read(freshPreferences, Cloud.Preferences)).timeZone).toBe(
          "America/Los_Angeles",
        )
        const badOrigin = yield* request({
          path: "/api/me/preferences",
          method: "PATCH",
          cookie: alice.cookie,
          origin: "https://attacker.test",
          body: { theme: "light" },
        })
        expect(badOrigin.status).toBe(403)
        expect(
          (yield* read(
            yield* request({ path: "/api/me/preferences", cookie: alice.cookie }),
            Cloud.Preferences,
          )).theme,
        ).toBe("dark")
        const keyResponse = yield* request({
          path: `/api/organizations/${org}/api-keys`,
          method: "POST",
          cookie: alice.cookie,
          body: { name: "CI reader", permission: "read" },
        })
        expect(keyResponse.status).toBe(200)
        const credential = yield* read(keyResponse, Cloud.CreatedApiKey)
        expect(credential.secret).toMatch(/^akter_/)
        expect(credential.key.lastFour).toBe(credential.secret.slice(-4))
        const listed = yield* request({
          path: `/api/organizations/${org}/api-keys`,
          cookie: alice.cookie,
        })
        const listingText = yield* listed.text
        expect(listingText).not.toContain(credential.secret)
        const hashes = yield* sql<{
          key: string
        }>`SELECT key FROM apikey WHERE id = ${credential.key.id}`
        expect(hashes[0]?.key).not.toBe(credential.secret)
        const withKey = yield* request({
          path: `/api/organizations/${org}/projects`,
          key: credential.secret,
        })
        expect(withKey.status).toBe(200)
        expect((yield* read(withKey, Schema.Array(Cloud.Project)))[0]?.id).toBe(project.id)
        expect(
          (yield* read(yield* request({ path: "/api/me", key: credential.secret }), Cloud.Me)).user,
        ).toBeNull()
        expect(
          (yield* request({ path: "/api/me", cookie: alice.cookie, key: "invalid-key" })).status,
        ).toBe(401)
        expect(
          (yield* request({
            path: `/api/organizations/${org}/projects`,
            method: "POST",
            key: credential.secret,
            body: { name: "Denied", slug: "denied", homeRegion: "us-east-1" },
          })).status,
        ).toBe(403)
        const otherOrgResponse = yield* request({
          path: "/api/organizations",
          method: "POST",
          cookie: outsider.cookie,
          body: { name: "Outsider organization", slug: `outsider-${suffix}` },
        })
        const otherOrg = (yield* read(otherOrgResponse, Cloud.OrganizationMembership)).organization
          .id
        expect(
          (yield* request({
            path: `/api/organizations/${otherOrg}/projects`,
            key: credential.secret,
          })).status,
        ).toBe(403)
        const scopedKeyResponse = yield* request({
          path: `/api/organizations/${org}/api-keys`,
          method: "POST",
          cookie: alice.cookie,
          body: { name: "Scoped reader", permission: "read", projectId: project.id },
        })
        expect(scopedKeyResponse.status).toBe(200)
        const scopedKey = yield* read(scopedKeyResponse, Cloud.CreatedApiKey)
        expect(
          (yield* request({ path: `/api/projects/${project.id}`, key: scopedKey.secret })).status,
        ).toBe(200)
        expect(
          (yield* request({ path: `/api/organizations/${org}/projects`, key: scopedKey.secret }))
            .status,
        ).toBe(403)
        yield* sql`UPDATE apikey SET "expiresAt" = now() - interval '1 second' WHERE id = ${scopedKey.key.id}`
        expect(
          (yield* request({ path: `/api/projects/${project.id}`, key: scopedKey.secret })).status,
        ).toBe(401)
        yield* sql.unsafe(
          `CREATE FUNCTION reject_key_audit_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'api-key.revoke' THEN RAISE EXCEPTION 'injected key audit failure'; END IF; RETURN NEW; END $$`,
        )
        yield* sql.unsafe(
          `CREATE TRIGGER reject_key_audit_${suffix} BEFORE INSERT ON cloud_audit FOR EACH ROW EXECUTE FUNCTION reject_key_audit_${suffix}()`,
        )
        yield* Effect.addFinalizer(() =>
          sql
            .unsafe(`DROP TRIGGER IF EXISTS reject_key_audit_${suffix} ON cloud_audit`)
            .pipe(
              Effect.andThen(sql.unsafe(`DROP FUNCTION IF EXISTS reject_key_audit_${suffix}()`)),
              Effect.orDie,
            ),
        )
        const rolledBack = yield* request({
          path: `/api/organizations/${org}/api-keys/${credential.key.id}`,
          method: "DELETE",
          cookie: alice.cookie,
        })
        expect(rolledBack.status).toBe(500)
        const [stillActive] = yield* sql<{
          enabled: boolean
          revoked_at: Date | null
        }>`SELECT a.enabled, k.revoked_at FROM apikey a JOIN cloud_api_key k ON k.id = a.id WHERE a.id = ${credential.key.id}`
        expect(stillActive).toEqual({ enabled: true, revoked_at: null })
        expect(
          (yield* request({ path: `/api/organizations/${org}/projects`, key: credential.secret }))
            .status,
        ).toBe(200)
        yield* sql.unsafe(`DROP TRIGGER reject_key_audit_${suffix} ON cloud_audit`)
        yield* sql.unsafe(`DROP FUNCTION reject_key_audit_${suffix}()`)
        const register = yield* request({
          path: "/auth/sso/register",
          method: "POST",
          cookie: alice.cookie,
          body: {
            organizationId: org,
            providerId: `enterprise-${suffix}`,
            domain: "example.com",
            issuer: origin,
            oidcConfig: { clientId: "test", clientSecret: "test" },
          },
        })
        expect(register.status).toBe(403)
        expect(
          yield* sql`SELECT id FROM "ssoProvider" WHERE "providerId" = ${`enterprise-${suffix}`}`,
        ).toHaveLength(0)
        const removeTeam = yield* request({
          path: "/auth/organization/remove-team",
          method: "POST",
          cookie: alice.cookie,
          body: { teamId: team.id },
        })
        expect(removeTeam.status).toBe(200)
        expect(yield* sql`SELECT id FROM team WHERE id = ${team.id}`).toHaveLength(0)
        const revoked = yield* request({
          path: `/api/organizations/${org}/api-keys/${credential.key.id}`,
          method: "DELETE",
          cookie: alice.cookie,
        })
        expect(revoked.status).toBe(204)
        expect(
          (yield* request({ path: `/api/organizations/${org}/projects`, key: credential.secret }))
            .status,
        ).toBe(401)
        const auditResponse = yield* request({
          path: `/api/organizations/${org}/audit-log?limit=100`,
          cookie: alice.cookie,
        })
        expect(auditResponse.status).toBe(200)
        const log = yield* read(
          auditResponse,
          Schema.Struct({
            items: Schema.Array(Cloud.AuditEntry),
            nextCursor: Schema.NullOr(Schema.String),
          }),
        )
        expect(
          log.items.some(
            (entry) => entry.action === "api-key.revoke" && entry.target.id === credential.key.id,
          ),
        ).toBe(true)
        const pending = yield* request({
          path: `/api/organizations/${org}/billing`,
          cookie: alice.cookie,
        })
        expect(pending.status).toBe(501)
        expect((yield* read(pending, Cloud.NotImplemented)).operation).toBe("billing.get")
        const blockedAuthMutation = yield* request({
          path: "/auth/organization/create",
          method: "POST",
          cookie: alice.cookie,
          body: { name: "Bypass", slug: `bypass-${suffix}` },
        })
        expect(blockedAuthMutation.status).toBe(404)
        expect(origin).toContain("127.0.0.1")
      }),
    { timeout: 60000 },
  )

  it.effect(
    "audits every single sign-on provider change an owner makes and refuses everyone else",
    () =>
      Effect.gen(function* () {
        const { request } = yield* testServer
        const sql = yield* SqlClient.SqlClient
        const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
        const signup = signupWith(request, sql, suffix)
        const owner = yield* signup("sso-owner")
        const outsider = yield* signup("sso-outsider")
        const created = yield* request({
          path: "/api/organizations",
          method: "POST",
          cookie: owner.cookie,
          body: { name: "SSO organization", slug: `sso-${suffix}` },
        })
        const org = (yield* read(created, Cloud.OrganizationMembership)).organization.id
        enterpriseOrganizations.push(org)
        const providerId = `provider-${suffix}`
        yield* sql`INSERT INTO "ssoProvider" (id, issuer, "userId", "providerId", "organizationId", domain, "domainVerified")
          VALUES (${`sso-${suffix}`}, 'https://idp.example', ${owner.id}, ${providerId}, ${org}, 'example.com', false)`

        const refused = yield* request({
          path: "/auth/sso/delete-provider",
          method: "POST",
          cookie: outsider.cookie,
          body: { providerId },
        })
        expect(refused.status).toBe(403)
        const deleted = yield* request({
          path: "/auth/sso/delete-provider",
          method: "POST",
          cookie: owner.cookie,
          body: { providerId },
        })

        expect(deleted.status).toBe(200)
        const entries = yield* sql<{
          action: string
          actor_id: string
          target_id: string
        }>`SELECT action, actor_id, target_id FROM cloud_audit WHERE organization_id = ${org} AND action LIKE 'sso.%' ORDER BY id`
        expect(entries).toEqual([
          { action: "sso.delete-provider.requested", actor_id: owner.id, target_id: providerId },
          { action: "sso.delete-provider", actor_id: owner.id, target_id: providerId },
        ])
      }),
    { timeout: 60000 },
  )

  it.effect(
    "authorizes sending a command before the runner proxy exists",
    () =>
      Effect.gen(function* () {
        const { request } = yield* testServer
        const sql = yield* SqlClient.SqlClient
        const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
        const signup = signupWith(request, sql, suffix)
        const owner = yield* signup("send-owner")
        const outsider = yield* signup("send-outsider")
        const created = yield* request({
          path: "/api/organizations",
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Send organization", slug: `send-${suffix}` },
        })
        const org = (yield* read(created, Cloud.OrganizationMembership)).organization.id
        const projectResponse = yield* request({
          path: `/api/organizations/${org}/projects`,
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Sender", slug: "sender", homeRegion: "us-west-2" },
        })
        const project = yield* read(projectResponse, Cloud.Project)
        const readKey = yield* read(
          yield* request({
            path: `/api/organizations/${org}/api-keys`,
            method: "POST",
            cookie: owner.cookie,
            body: { name: "reader", permission: "read" },
          }),
          Cloud.CreatedApiKey,
        )
        const send = (input: { readonly cookie?: string; readonly key?: string }) =>
          request({
            path: `/api/projects/${project.id}/environments/dev/runtime/commands`,
            method: "POST",
            body: { address: "Counter/room-1", command: "Increment", payload: { by: 1 } },
            ...input,
          })

        const anonymous = yield* send({})
        const stranger = yield* send({ cookie: outsider.cookie })
        const reader = yield* send({ key: readKey.secret })
        const allowed = yield* send({ cookie: owner.cookie })

        expect([anonymous.status, stranger.status, reader.status]).toEqual([401, 403, 403])
        expect(allowed.status).toBe(404)
        expect((yield* read(allowed, Cloud.NotFound)).resource).toBe("live deployment")
        const series = (
          suffix: string,
          input: { readonly cookie?: string; readonly key?: string },
        ) =>
          request({
            path: `/api/projects/${project.id}/environments/dev/runtime/actor-types/Counter/${suffix}`,
            ...input,
          })
        const seriesStatuses = yield* Effect.forEach(["activity", "latency"], (suffix) =>
          Effect.all([
            series(suffix, {}),
            series(suffix, { cookie: outsider.cookie }),
            series(suffix, { key: readKey.secret }),
          ]).pipe(Effect.map((all) => all.map((response) => response.status))),
        )
        expect(seriesStatuses).toEqual([
          [401, 403, 501],
          [401, 403, 501],
        ])
      }),
    { timeout: 60000 },
  )
})
