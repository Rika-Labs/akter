import { describe, expect, it } from "@effect/vitest"
import { afterAll } from "vitest"
import * as Cloud from "@akter/cloud-api"
import { migrate, statements } from "@akter/postgres/migrate"
import { liveNeki, nekiDatabase } from "@akter/postgres/neki"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Database } from "@rikalabs/akter/runtime"
import {
  Crypto,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { Cookies, FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { CLI_CLIENT_ID } from "./device.ts"
import {
  baseOrigin,
  enterpriseOrganizations,
  isolatedLive,
  options,
  read,
  signupWith,
  stalledRequest,
  TestLive,
  testServer,
} from "./fixtures.ts"
import { infrastructure } from "./server.ts"

const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Finite,
  interval: Schema.Finite,
})

const DeviceToken = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Finite,
})

const DeviceError = Schema.Struct({ error: Schema.String })

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

it.layer(TestLive, { excludeTestServices: true })(
  "cloud API over real Postgres and Bun HTTP",
  (it) => {
    it.effect(
      "scopes deployment records, serializes creation, and releases the environment after a recorded build failure",
      () =>
        Effect.gen(function* () {
          const { request } = yield* testServer
          const sql = yield* SqlClient.SqlClient
          const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
          const signup = signupWith({ request, sql, suffix })
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
          expect(
            concurrent.map((response) => response.status).sort((left, right) => left - right),
          ).toEqual([200, 409, 409, 409, 409, 409, 409, 409])
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
          const signup = signupWith({ request, sql, suffix })
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
          }>`SELECT subject FROM cloud_email_outbox WHERE recipient = ${bob.email} AND subject LIKE 'Join %'`.pipe(
            Effect.filterOrFail((rows) => rows.length > 0),
            Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
            Effect.orDie,
          )
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
          expect(environments.map((env) => env.name).sort()).toEqual([
            "dev",
            "production",
            "staging",
          ])
          expect(
            (yield* request({ path: `/api/projects/${project.id}`, cookie: outsider.cookie }))
              .status,
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
            (yield* read(yield* request({ path: "/api/me", key: credential.secret }), Cloud.Me))
              .user,
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
          const otherOrg = (yield* read(otherOrgResponse, Cloud.OrganizationMembership))
            .organization.id
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
          const billing = yield* request({
            path: `/api/organizations/${org}/billing`,
            cookie: alice.cookie,
          })
          expect(billing.status).toBe(200)
          expect((yield* read(billing, Cloud.BillingSummary)).plan).toMatchObject({ id: "free" })
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
          const signup = signupWith({ request, sql, suffix })
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
          const signup = signupWith({ request, sql, suffix })
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
            ]).pipe(
              Effect.flatMap((all) =>
                Effect.map(read(all[2]!, Cloud.NotFound), (missing) => [
                  ...all.map((response) => response.status),
                  missing.resource,
                ]),
              ),
            ),
          )
          expect(seriesStatuses).toEqual([
            [401, 403, 404, "live deployment"],
            [401, 403, 404, "live deployment"],
          ])
        }),
      { timeout: 60000 },
    )

    it.effect(
      "signs a CLI in through the device grant: the viewer claims a code, another account is refused it, approval yields a session in the approver's active organization, and denial and expiry yield none",
      () =>
        Effect.gen(function* () {
          const { request } = yield* testServer
          const sql = yield* SqlClient.SqlClient
          const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
          const signup = signupWith({ request, sql, suffix })
          const alice = yield* signup("device-alice")
          const bob = yield* signup("device-bob")
          const start = (body: Schema.Json) =>
            request({ path: "/auth/device/code", method: "POST", body })
          const code = Effect.gen(function* () {
            const response = yield* start({ client_id: CLI_CLIENT_ID })
            expect(response.status).toBe(200)
            return yield* read(response, DeviceCode)
          })
          const errorOf = Effect.fn(function* (response: Parameters<typeof read>[0], status = 400) {
            expect(response.status).toBe(status)
            return (yield* read(response, DeviceError)).error
          })
          const poll = (deviceCode: string) =>
            request({
              path: "/auth/device/token",
              method: "POST",
              body: { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLI_CLIENT_ID },
            })
          const settled = (deviceCode: string) =>
            poll(deviceCode).pipe(
              Effect.flatMap((response) =>
                Effect.map(
                  response.status === 200 ? Effect.succeed("granted") : errorOf(response),
                  (error) => ({ response, error }),
                ),
              ),
              Effect.filterOrFail(
                ({ error }) => error !== "slow_down" && error !== "authorization_pending",
              ),
              Effect.retry({ times: 20, schedule: Schedule.spaced("1 second") }),
              Effect.map(({ response }) => response),
              Effect.orDie,
            )
          const lookup = (userCode: string, cookie?: string) =>
            request({ path: `/auth/device?user_code=${encodeURIComponent(userCode)}`, cookie })
          const decide = (decision: "approve" | "deny", userCode: string, cookie: string) =>
            request({
              path: `/auth/device/${decision}`,
              method: "POST",
              cookie,
              body: { userCode },
            })
          const boundTo = (deviceCode: string) =>
            sql<{
              userId: string | null
            }>`SELECT "userId" FROM "deviceCode" WHERE "deviceCode" = ${deviceCode}`.pipe(
              Effect.map((rows) => rows[0]?.userId ?? null),
            )
          const me = (token: string) =>
            request({ path: "/api/me", headers: { authorization: `Bearer ${token}` } })

          expect(yield* errorOf(yield* start({ client_id: "someone-else" }))).toBe("invalid_client")
          expect(
            yield* errorOf(yield* start({ client_id: CLI_CLIENT_ID, user_id: alice.id })),
            "nobody binds a code to an account before that account looks it up",
          ).toBe("invalid_request")
          expect(
            (yield* request({
              path: "/auth/device/code",
              method: "POST",
              raw: `client_id=${CLI_CLIENT_ID}&user_id=${alice.id}`,
              headers: { "content-type": "application/x-www-form-urlencoded" },
            })).status,
          ).toBe(400)
          expect(yield* sql`SELECT 1 FROM "deviceCode" WHERE "userId" = ${alice.id}`).toEqual([])

          const organization = yield* read(
            yield* request({
              path: "/api/organizations",
              method: "POST",
              cookie: alice.cookie,
              body: { name: "Device organization", slug: `device-${suffix}` },
            }),
            Cloud.OrganizationMembership,
          )
          expect(
            (yield* request({
              path: "/api/me/active-organization",
              method: "PUT",
              cookie: alice.cookie,
              body: { organizationId: organization.organization.id },
            })).status,
          ).toBe(200)

          const approved = yield* code
          expect(approved.user_code).toMatch(/^[A-Z2-9]{8}$/u)
          expect(approved.verification_uri).toBe(`${baseOrigin}/device`)
          expect(yield* errorOf(yield* poll(approved.device_code))).toBe("authorization_pending")
          expect((yield* lookup(approved.user_code)).status).toBe(200)
          expect(
            yield* boundTo(approved.device_code),
            "an anonymous lookup binds nobody",
          ).toBeNull()
          const dashed = `${approved.user_code.slice(0, 4)}-${approved.user_code.slice(4)}`
          expect((yield* lookup(dashed, alice.cookie)).status).toBe(200)
          expect(yield* boundTo(approved.device_code)).toBe(alice.id)
          expect(
            yield* errorOf(yield* lookup(approved.user_code, bob.cookie), 403),
            "a pending code another account claimed is refused, not described",
          ).toBe("access_denied")
          expect(yield* boundTo(approved.device_code)).toBe(alice.id)
          expect((yield* decide("approve", approved.user_code, bob.cookie)).status).toBe(403)
          expect((yield* decide("approve", approved.user_code, alice.cookie)).status).toBe(200)
          const granted = yield* settled(approved.device_code)
          expect(granted.status).toBe(200)
          const token = yield* read(granted, DeviceToken)
          expect(token.token_type).toBe("Bearer")
          expect(token.expires_in).toBeGreaterThan(0)

          const signedIn = yield* read(yield* me(token.access_token), Cloud.Me)
          expect(signedIn.user?.email).toBe(alice.email)
          expect(signedIn.identityKind).toBe("session")
          expect(
            signedIn.activeOrganizationId,
            "the device session starts in the approver's active organization",
          ).toBe(organization.organization.id)
          expect((yield* me(`${token.access_token}x`)).status).toBe(401)
          expect(
            yield* errorOf(yield* settled(approved.device_code)),
            "a redeemed device code grants no second session",
          ).toBe("invalid_grant")

          const elsewhere = yield* code
          expect((yield* lookup(elsewhere.user_code, bob.cookie)).status).toBe(200)
          expect((yield* decide("approve", elsewhere.user_code, bob.cookie)).status).toBe(200)
          const bobToken = yield* read(yield* settled(elsewhere.device_code), DeviceToken)
          expect(
            (yield* read(yield* me(bobToken.access_token), Cloud.Me)).activeOrganizationId,
            "an approver with no active organization gives none",
          ).toBeNull()

          const denied = yield* code
          expect((yield* lookup(denied.user_code, bob.cookie)).status).toBe(200)
          expect((yield* decide("deny", denied.user_code, bob.cookie)).status).toBe(200)
          expect(yield* errorOf(yield* settled(denied.device_code))).toBe("access_denied")

          const expired = yield* code
          expect((yield* lookup(expired.user_code, alice.cookie)).status).toBe(200)
          yield* sql`UPDATE "deviceCode" SET "expiresAt" = now() - interval '1 second' WHERE "deviceCode" = ${expired.device_code}`
          expect(yield* errorOf(yield* lookup(expired.user_code, alice.cookie))).toBe(
            "expired_token",
          )
          expect(yield* errorOf(yield* decide("approve", expired.user_code, alice.cookie))).toBe(
            "expired_token",
          )
          expect(yield* errorOf(yield* settled(expired.device_code))).toBe("expired_token")

          const browserSignIn = yield* request({
            path: "/auth/sign-in/email",
            method: "POST",
            body: { email: alice.email, password: "correct-horse-battery-staple-42" },
          })
          expect(browserSignIn.status).toBe(200)
          expect(browserSignIn.headers["set-auth-token"]).toBeUndefined()

          const signedOut = yield* request({
            path: "/auth/sign-out",
            method: "POST",
            headers: { authorization: `Bearer ${token.access_token}` },
            body: {},
          })
          expect(signedOut.status).toBe(200)
          expect((yield* me(token.access_token)).status).toBe(401)
          expect((yield* request({ path: "/api/me", cookie: alice.cookie })).status).toBe(200)
        }),
      { timeout: 120000 },
    )

    it.effect(
      "lets a bearer token alone authenticate a request that carries one, so neither a cookie nor an API key beside it can stand in for it",
      () =>
        Effect.gen(function* () {
          const { request } = yield* testServer
          const sql = yield* SqlClient.SqlClient
          const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
          const signup = signupWith({ request, sql, suffix })
          const alice = yield* signup("bearer-alice")
          const bob = yield* signup("bearer-bob")
          const code = yield* read(
            yield* request({
              path: "/auth/device/code",
              method: "POST",
              body: { client_id: CLI_CLIENT_ID },
            }),
            DeviceCode,
          )
          yield* request({ path: `/auth/device?user_code=${code.user_code}`, cookie: bob.cookie })
          yield* request({
            path: "/auth/device/approve",
            method: "POST",
            cookie: bob.cookie,
            body: { userCode: code.user_code },
          })
          const bobToken = (yield* read(
            yield* request({
              path: "/auth/device/token",
              method: "POST",
              body: {
                grant_type: DEVICE_GRANT,
                device_code: code.device_code,
                client_id: CLI_CLIENT_ID,
              },
            }),
            DeviceToken,
          )).access_token
          const org = (yield* read(
            yield* request({
              path: "/api/organizations",
              method: "POST",
              cookie: alice.cookie,
              body: { name: "Bearer organization", slug: `bearer-${suffix}` },
            }),
            Cloud.OrganizationMembership,
          )).organization.id
          const key = (yield* read(
            yield* request({
              path: `/api/organizations/${org}/api-keys`,
              method: "POST",
              cookie: alice.cookie,
              body: { name: "Bearer test", permission: "read" },
            }),
            Cloud.CreatedApiKey,
          )).secret
          const whoIs = (headers: Readonly<Record<string, string>>) =>
            request({ path: "/api/me", headers }).pipe(
              Effect.flatMap((response) =>
                response.status === 200
                  ? read(response, Cloud.Me).pipe(
                      Effect.map((me): string | number => me.user?.email ?? "api-key"),
                    )
                  : Effect.succeed<string | number>(response.status),
              ),
            )

          const bearer = (token: string) => `Bearer ${token}`

          expect(yield* whoIs({ cookie: alice.cookie })).toBe(alice.email)
          expect(yield* whoIs({ authorization: bearer(bobToken) })).toBe(bob.email)
          expect(
            yield* whoIs({ cookie: alice.cookie, authorization: bearer("garbage.garbage") }),
            "an invalid bearer never falls back to the cookie beside it",
          ).toBe(401)
          expect(yield* whoIs({ cookie: alice.cookie, authorization: bearer("garbage") })).toBe(401)
          expect(
            yield* whoIs({ cookie: alice.cookie, authorization: bearer(bobToken) }),
            "a valid bearer is the request's only credential",
          ).toBe(bob.email)
          expect(yield* whoIs({ "x-api-key": key })).toBe("api-key")
          expect(
            yield* whoIs({ "x-api-key": key, authorization: bearer(bobToken) }),
            "an API key beside a bearer token is refused",
          ).toBe(401)
        }),
      { timeout: 60000 },
    )

    it.effect(
      "refuses a source upload to a control plane without a builder before reading its body",
      () =>
        Effect.gen(function* () {
          const { request, origin } = yield* testServer
          const sql = yield* SqlClient.SqlClient
          const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
          const owner = yield* signupWith({ request, sql, suffix })("upload-owner")
          const org = (yield* read(
            yield* request({
              path: "/api/organizations",
              method: "POST",
              cookie: owner.cookie,
              body: { name: "Upload organization", slug: `upload-${suffix}` },
            }),
            Cloud.OrganizationMembership,
          )).organization.id
          const project = yield* read(
            yield* request({
              path: `/api/organizations/${org}/projects`,
              method: "POST",
              cookie: owner.cookie,
              body: { name: "Upload project", slug: "upload", homeRegion: "us-east-1" },
            }),
            Cloud.Project,
          )
          const stalled = yield* stalledRequest({
            origin,
            head: `POST /api/projects/${project.id}/sources HTTP/1.1\r\nhost: localhost\r\ncookie: ${owner.cookie}\r\ncontent-type: application/gzip\r\ntransfer-encoding: chunked\r\n\r\n`,
            body: new TextEncoder().encode("4\r\nabcd\r\n"),
          }).pipe(Effect.timeout("10 seconds"))
          expect(stalled.status).toBe(501)
          expect(stalled.elapsedMs).toBeLessThan(5_000)
          expect(
            (yield* request({
              path: `/api/projects/${project.id}/deployments`,
              method: "POST",
              cookie: owner.cookie,
              body: {
                environment: "production",
                commitSha: "abcdef1",
                source: { digest: `sha256:${"d".repeat(64)}`, dockerfile: "Dockerfile" },
              },
            })).status,
          ).toBe(501)
        }),
      { timeout: 60000 },
    )
  },
)

it.layer(
  isolatedLive({ localBuild: { context: "/nonexistent-build-context", dockerfile: "Dockerfile" } }),
  { excludeTestServices: true },
)("source uploads on a control plane that builds", (it) => {
  it.effect(
    "answers an over-limit or stalled upload at once, checking access before any byte is read, and stores what fits under its digest",
    () =>
      Effect.gen(function* () {
        const { request, origin } = yield* testServer
        const sql = yield* SqlClient.SqlClient
        const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
        const signup = signupWith({ request, sql, suffix })
        const owner = yield* signup("builder-owner")
        const outsider = yield* signup("builder-outsider")
        const org = (yield* read(
          yield* request({
            path: "/api/organizations",
            method: "POST",
            cookie: owner.cookie,
            body: { name: "Builder organization", slug: `builder-${suffix}` },
          }),
          Cloud.OrganizationMembership,
        )).organization.id
        const project = yield* read(
          yield* request({
            path: `/api/organizations/${org}/projects`,
            method: "POST",
            cookie: owner.cookie,
            body: { name: "Builder project", slug: "builder", homeRegion: "us-east-1" },
          }),
          Cloud.Project,
        )
        const head = (input: {
          readonly cookie: string
          readonly framing: string
          readonly projectId?: string
        }) =>
          `POST /api/projects/${input.projectId ?? project.id}/sources HTTP/1.1\r\nhost: localhost\r\ncookie: ${input.cookie}\r\ncontent-type: application/gzip\r\n${input.framing}\r\n\r\n`
        const chunked = (bytes: number) => {
          const size = 1024 * 1024
          const parts: Array<Uint8Array> = []
          for (let sent = 0; sent < bytes; sent += size)
            parts.push(
              new TextEncoder().encode(`${size.toString(16)}\r\n`),
              new Uint8Array(size),
              new TextEncoder().encode("\r\n"),
            )
          const body = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
          let offset = 0
          for (const part of parts) {
            body.set(part, offset)
            offset += part.byteLength
          }
          return body
        }
        const send = (input: Parameters<typeof head>[0], body: Uint8Array) =>
          stalledRequest({ origin, head: head(input), body }).pipe(Effect.timeout("20 seconds"))

        const declared = yield* send(
          { cookie: owner.cookie, framing: `content-length: ${Cloud.MAX_SOURCE_BYTES + 1}` },
          new Uint8Array(1024),
        )
        expect(declared.status, "a declared length over the limit is refused unread").toBe(413)
        expect(declared.elapsedMs).toBeLessThan(5_000)

        const streamed = yield* send(
          { cookie: owner.cookie, framing: "transfer-encoding: chunked" },
          chunked(Cloud.MAX_SOURCE_BYTES + 1024 * 1024),
        )
        expect(streamed.status, "a streamed body is cut off once it passes the limit").toBe(413)
        expect(streamed.elapsedMs).toBeLessThan(15_000)

        for (const [input, status] of [
          [{ cookie: outsider.cookie, framing: "transfer-encoding: chunked" }, 403],
          [
            {
              cookie: owner.cookie,
              framing: "transfer-encoding: chunked",
              projectId: "prj_does_not_exist",
            },
            403,
          ],
        ] as const) {
          const refused = yield* send(input, new TextEncoder().encode("4\r\nabcd\r\n"))
          expect(refused.status, "access is decided before the body is read").toBe(status)
          expect(refused.elapsedMs).toBeLessThan(5_000)
        }

        const archive = new TextEncoder().encode("a small archive's bytes")
        const stored = yield* read(
          yield* request({
            path: `/api/projects/${project.id}/sources`,
            method: "POST",
            cookie: owner.cookie,
            raw: new TextDecoder().decode(archive),
            headers: { "content-type": "application/gzip" },
          }),
          Cloud.SourceArchive,
        )
        expect(stored).toEqual({
          digest: `sha256:${new Bun.CryptoHasher("sha256").update(archive).digest("hex")}`,
          sizeBytes: archive.byteLength,
        })
        expect(
          yield* sql`SELECT size_bytes FROM cloud_source_archive WHERE project_id = ${project.id}`,
        ).toEqual([{ size_bytes: archive.byteLength }])
      }),
    { timeout: 120000 },
  )
})

/** Builds the API's whole database setup, serves its routes, and signs a user up through Better Auth. */
const bootNeki = (url: Redacted.Redacted<string>, suffix: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.provideMerge(
          Layer.provideMerge(
            infrastructure({ ...options(url), databaseEngine: "neki" }),
            FetchHttpClient.layer,
          ),
          BunCrypto.layer,
        ),
      )
      yield* Effect.gen(function* () {
        const { request } = yield* testServer
        const sql = yield* SqlClient.SqlClient
        yield* signupWith({ request, sql, suffix })("neki")
        const ready = yield* request({ path: "/ready" })
        expect(ready.status).toBe(200)
      }).pipe(Effect.provideContext(context))
    }),
  )

const nekiTables = [
  "actor_migrations",
  "actor_migration_steps",
  "apikey",
  "cloud_api_key",
  "cloud_audit",
  "cloud_billing_account",
  "cloud_billing_customer",
  "cloud_email_outbox",
  "cloud_meter_tenant",
  "cloud_project",
  "cloud_source_archive",
  "deployment",
  "deployment_rollout_build_log",
  "deployment_runner",
  "member",
  "organization",
  "project_migration",
  "runner_wake",
  "session",
  "tenant_directory",
  "user",
]

const inspectNeki = (url: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: Redacted.value(url), max: 1 })),
      (pool) => Effect.promise(() => pool.end()),
    )
    const rows = <A>(text: string) =>
      Effect.promise(() => pool.query(text)).pipe(Effect.map(({ rows }) => rows as Array<A>))
    return {
      tables: (yield* rows<{ name: string }>(
        `SELECT relname AS name FROM pg_class WHERE relkind = 'r' AND relname = ANY('{${nekiTables.join(",")}}')`,
      ))
        .map(({ name }) => name)
        .sort(),
      files: (yield* rows<{ name: string }>(
        "SELECT name FROM project_migration ORDER BY name",
      )).map(({ name }) => name),
      columns: (yield* rows<{ name: string }>(
        `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
          WHERE table_name IN ('deployment', 'deployment_runner')
            AND column_name IN ('tier', 'image', 'serving', 'provider_id') ORDER BY 1`,
      )).map(({ name }) => name),
      barriers:
        liveNeki === undefined
          ? (yield* rows<{ calls: number }>("SELECT calls FROM neki_barriers"))[0]!.calls
          : undefined,
      guarded:
        liveNeki === undefined
          ? (yield* rows("SELECT 1 FROM pg_event_trigger WHERE evtname = 'neki_autocommit_ddl'"))
              .length
          : undefined,
    }
  }).pipe(Effect.scoped)

const nekiFiles = [
  "0002_tenant_directory.sql",
  "0003_edge.sql",
  "0004_scale_to_zero.sql",
  "0005_runner_provider.sql",
]

const nekiHarness = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => nekiHarness.dispose())

const runNeki = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  nekiHarness.runPromise(Effect.scoped(effect))

describe(
  liveNeki === undefined ? "API schema on the Neki stand-in" : "API schema on a live Neki router",
  () => {
    it(
      "boots on a fresh database, boots again, and reapplies every control-plane statement over its own result",
      () =>
        runNeki(
          Effect.gen(function* () {
            const url = yield* nekiDatabase("cp")
            yield* bootNeki(url, "fresh")
            const first = yield* inspectNeki(url)

            expect(first.tables).toEqual([...nekiTables].sort())
            expect(first.files).toEqual(nekiFiles)
            expect(first.columns).toEqual([
              "deployment.image",
              "deployment.serving",
              "deployment.tier",
              "deployment_runner.provider_id",
            ])
            if (liveNeki === undefined) {
              expect(first.guarded).toBe(1)
              expect(first.barriers).toBeGreaterThan(200)
            }

            yield* bootNeki(url, "restart")
            expect((yield* inspectNeki(url)).files).toEqual(nekiFiles)

            const pool = new Pool({ connectionString: Redacted.value(url), max: 1 })
            yield* Effect.promise(() => pool.query("DELETE FROM project_migration")).pipe(
              Effect.ensuring(Effect.promise(() => pool.end())),
            )
            yield* Effect.promise(() =>
              migrate(Redacted.value(url), { startAt: "0002_", neki: true }),
            )
            expect((yield* inspectNeki(url)).files).toEqual(nekiFiles)
          }),
        ),
      900_000,
    )

    it(
      "finishes the control-plane files a previous release left part way through a file",
      () =>
        runNeki(
          Effect.gen(function* () {
            const url = yield* nekiDatabase("cp")
            const directory = new URL("../../../packages/postgres/migrations/", import.meta.url)
            const [interrupted, ...rest] = statements(
              yield* Effect.promise(() => Bun.file(new URL(nekiFiles[3]!, directory)).text()),
            )
            expect(rest.length).toBeGreaterThan(0)
            yield* Database.schemaChange(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                yield* sql`create table if not exists project_migration (name text primary key, applied_at timestamptz not null default now())`
                for (const name of nekiFiles.slice(0, 3)) {
                  for (const statement of statements(
                    yield* Effect.promise(() => Bun.file(new URL(name, directory)).text()),
                  ))
                    yield* sql.unsafe(statement)
                  yield* sql`insert into project_migration(name) values (${name})`
                }
                yield* sql.unsafe(interrupted!)
              }),
              741902113,
            ).pipe(
              Effect.provideContext(
                yield* Layer.build(
                  Layer.mergeAll(
                    PgClient.layer({ url, maxConnections: 1 }),
                    Layer.succeed(Database.Neki, true),
                  ),
                ),
              ),
              Effect.orDie,
            )
            const before = yield* inspectNeki(url)
            expect(before.files).toEqual(nekiFiles.slice(0, 3))
            expect(before.columns).toEqual(["deployment.tier"])

            yield* bootNeki(url, "upgrade")
            const after = yield* inspectNeki(url)

            expect(after.files).toEqual(nekiFiles)
            expect(after.columns).toEqual([
              "deployment.image",
              "deployment.serving",
              "deployment.tier",
              "deployment_runner.provider_id",
            ])
            expect(after.tables).toEqual([...nekiTables].sort())
          }),
        ),
      900_000,
    )
  },
)
