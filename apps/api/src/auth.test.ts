import { Postgres } from "@alchemy.run/better-auth/Postgres"
import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context"
import { PgClient } from "@effect/sql-pg"
import {
  Clock,
  Config,
  Context,
  DateTime,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Ref,
  Schedule,
  Schema,
} from "effect"
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type * as AuthModule from "./auth.ts"
import type { ApiOptions } from "./config.ts"
import { Email, localEmail } from "./email.ts"
import { type Idp, startIdp, type TokenFault } from "./idp.ts"

type Json = Schema.Json

/**
 * Better Auth switches its origin and CSRF protection off when `NODE_ENV` is
 * `test`, which it reads once as it loads, or when `TEST` is truthy, which
 * Vitest sets. Either would leave those defenses unproven, so the service
 * loads only after both are changed.
 */
vi.stubEnv("NODE_ENV", "development")
vi.stubEnv("TEST", "false")
const { Auth, processRuntimeLayer } = await import("./auth.ts")

const PASSWORD = "correct horse battery staple"
const SESSION_COOKIE = "better-auth.session_token"
const DAY_SECONDS = 24 * 60 * 60

const SessionBody = Schema.NullOr(
  Schema.Struct({
    session: Schema.Struct({ id: Schema.String, userId: Schema.String }),
    user: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }),
  }),
)
const Identified = Schema.Struct({ id: Schema.String })
const SsoStart = Schema.Struct({ url: Schema.String, redirect: Schema.Boolean })
const CreatedKey = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  referenceId: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
})
const ApiError = Schema.Struct({ code: Schema.optional(Schema.String) })

interface Reply {
  readonly status: number
  readonly location: string | undefined
  readonly text: string
}

interface Browser {
  readonly get: (url: string) => Effect.Effect<Reply>
  readonly post: (path: string, body: Json, origin?: string) => Effect.Effect<Reply>
  readonly session: Effect.Effect<typeof SessionBody.Type>
  readonly cookie: (name: string) => Effect.Effect<string | undefined>
}

/** The auth service, the loopback provider and the database a run of these tests shares. */
class Fixture extends Context.Service<
  Fixture,
  {
    readonly origin: string
    readonly idp: Idp
    readonly auth: AuthModule.Auth["Service"]
    readonly sql: SqlClient.SqlClient
    readonly enterpriseOrganizations: Array<string>
    readonly mailStores: Array<unknown>
  }
>()("@akter/api/auth.test/Fixture") {}

const createDatabase = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `auth_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )
  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`
  return base.href
})

const FixtureLive = Layer.effect(
  Fixture,
  Effect.gen(function* () {
    const url = yield* createDatabase
    const idp = yield* startIdp
    const enterpriseOrganizations: Array<string> = []
    const options: ApiOptions = {
      enterpriseOrganizations,
      databaseUrl: Redacted.make(url),
      secret: Redacted.make("a-local-test-signing-secret-long-enough"),
      origin: idp.origin,
      consoleOrigin: "https://console.akter.test",
      port: 0,
      production: false,
      emailMode: "local",
      emailFrom: "Akter <auth@localhost>",
    }
    const sqlLayer = PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })
    const mailStores: Array<unknown> = []
    const recordingEmail = Layer.effect(
      Email,
      Effect.gen(function* () {
        const inner = yield* Email
        const store = yield* Effect.promise(getCurrentDBAdapterAsyncLocalStorage)
        return Email.of({
          send: (message) =>
            Effect.sync(() => mailStores.push(store.getStore())).pipe(
              Effect.andThen(inner.send(message)),
            ),
        })
      }),
    )
    const emailLayer = recordingEmail.pipe(Layer.provide(localEmail.pipe(Layer.provide(sqlLayer))))
    const services = yield* Layer.build(
      Auth.layer(options).pipe(
        Layer.provideMerge(
          Layer.mergeAll(emailLayer, Postgres(url), sqlLayer, processRuntimeLayer),
        ),
      ),
    )
    const auth = Context.get(services, Auth)
    idp.mount((request) => auth.handler(request))
    return Fixture.of({
      origin: idp.origin,
      idp,
      auth,
      sql: Context.get(services, SqlClient.SqlClient),
      enterpriseOrganizations,
      mailStores,
    })
  }).pipe(Effect.orDie),
)

const harness = ManagedRuntime.make(
  Layer.mergeAll(
    FixtureLive,
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
    ),
  ),
)

const run = <A, E>(effect: Effect.Effect<A, E, Fixture | HttpClient.HttpClient>) =>
  harness.runPromise(effect)

beforeAll(() => harness.runPromise(Effect.asVoid(Effect.service(Fixture))), 60_000)
/** Dropping the isolated database waits for cluster-wide checkpoints from concurrent integration suites. */
afterAll(() => harness.dispose().then(() => vi.unstubAllEnvs()), 60_000)

const sequence = { value: 0 }
const next = () => {
  sequence.value += 1
  return sequence.value
}

const decode = <S extends Schema.Top>(schema: S) => {
  const parse = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
  return (reply: Reply) => Effect.orDie(parse(reply.text))
}

const single = <A>(rows: ReadonlyArray<A>) =>
  rows.length === 1
    ? Effect.succeed(rows[0] as A)
    : Effect.die(`expected one row, found ${rows.length}`)

/** A cookie-keeping client that never follows a redirect, so each hop of a flow is observable. */
const newBrowser = Effect.gen(function* () {
  const { origin } = yield* Fixture
  const jar = yield* Ref.make(Cookies.empty)
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withCookiesRef(jar))
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (text): Reply => ({
          status: response.status,
          location: response.headers["location"],
          text,
        })),
      ),
      Effect.orDie,
    )
  const get: Browser["get"] = (url) =>
    send(
      HttpClientRequest.get(new URL(url, origin).href).pipe(
        HttpClientRequest.setHeader("origin", origin),
      ),
    )
  return {
    get,
    post: (path, body, from = origin) =>
      send(
        HttpClientRequest.post(new URL(path, origin).href).pipe(
          HttpClientRequest.setHeader("origin", from),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      ),
    session: get("/auth/get-session").pipe(Effect.flatMap(decode(SessionBody))),
    cookie: (name) => Effect.map(Ref.get(jar), (cookies) => Cookies.toRecord(cookies)[name]),
  } satisfies Browser
})

/**
 * The link of the verification email sent to `email`. Better Auth sends mail
 * as background work, so the outbox row may land after the sign-up response.
 */
const verificationLink = Effect.fnUntraced(function* (email: string) {
  const { sql } = yield* Fixture
  const rows = yield* sql<{
    readonly body: string
  }>`SELECT body FROM cloud_email_outbox WHERE recipient = ${email} AND subject = 'Verify your email'`.pipe(
    Effect.orDie,
    Effect.filterOrFail((found) => found.length > 0),
    Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
    Effect.orDie,
  )
  return (yield* single(rows)).body
})

/** A person who signed up with a password and proved their address through the emailed link. */
const verifiedUser = Effect.fnUntraced(function* (label: string, domain = "example.test") {
  const { origin } = yield* Fixture
  const browser = yield* newBrowser
  const email = `${label}-${next()}@${domain}`
  const signUp = yield* browser.post("/auth/sign-up/email", {
    name: label,
    email,
    password: PASSWORD,
    callbackURL: `${origin}/welcome`,
  })
  expect(signUp.status).toBe(200)
  expect(yield* browser.session).toBeNull()
  const verified = yield* browser.get(yield* verificationLink(email))
  expect(verified.status).toBe(302)
  const session = yield* browser.session
  expect(session?.user.email).toBe(email)
  return { browser, email, userId: session?.user.id ?? "" }
})

const createOrganization = Effect.fnUntraced(function* (owner: Browser, label: string) {
  const slug = `${label}-${next()}`
  const created = yield* owner.post("/auth/organization/create", { name: label, slug })
  expect(created.status).toBe(200)
  return { id: (yield* decode(Identified)(created)).id, slug }
})

const registerProvider = Effect.fnUntraced(function* (
  owner: Browser,
  provider: {
    readonly organizationId: string
    readonly providerId: string
    readonly domain: string
    readonly clientSecret?: string
    readonly domainVerified?: boolean
    readonly enterprise?: boolean
  },
) {
  const { idp, origin, sql, enterpriseOrganizations } = yield* Fixture
  idp.allowRedirect(`${origin}/auth/sso/callback/${provider.providerId}`)
  const registered = yield* owner.post("/auth/sso/register", {
    providerId: provider.providerId,
    issuer: idp.issuer,
    domain: provider.domain,
    organizationId: provider.organizationId,
    oidcConfig: {
      clientId: idp.clientId,
      clientSecret: provider.clientSecret ?? idp.clientSecret,
      pkce: true,
      scopes: ["openid", "email", "profile"],
    },
  })
  if (registered.status !== 200) return registered
  if (provider.enterprise !== false) enterpriseOrganizations.push(provider.organizationId)
  if (provider.domainVerified !== false) {
    yield* sql`UPDATE "ssoProvider" SET "domainVerified" = true WHERE "providerId" = ${provider.providerId}`.pipe(
      Effect.orDie,
    )
  }
  return registered
})

/**
 * An organization whose owner has registered the loopback provider for one
 * email domain. The provider's domain is marked verified directly in the
 * database and the organization is listed as an enterprise organization,
 * standing in for a trusted, pre-provisioned provider; no DNS ownership proof
 * is performed.
 */
const ssoTenant = Effect.fnUntraced(function* (
  label: string,
  trust: { readonly domainVerified?: boolean; readonly enterprise?: boolean } = {},
) {
  const owner = yield* verifiedUser(`${label}-owner`)
  const organization = yield* createOrganization(owner.browser, label)
  const domain = `${label}-${next()}.test`
  const providerId = `${label}-oidc-${next()}`
  const registered = yield* registerProvider(owner.browser, {
    organizationId: organization.id,
    providerId,
    domain,
    ...trust,
  })
  expect(registered.status).toBe(200)
  return { owner, organization, domain, providerId }
})

/** Someone the provider will authenticate, with a subject the service has never seen. */
const idpPerson = Effect.fnUntraced(function* (name: string, domain: string, emailVerified = true) {
  const { idp } = yield* Fixture
  const person = { sub: `sub-${next()}`, email: `${name}@${domain}`, name, emailVerified }
  idp.addUser(person)
  return person
})

type Selector =
  | { readonly providerId: string; readonly loginHint: string }
  | { readonly organizationSlug: string; readonly email: string }
  | { readonly email: string }

const beginSso = Effect.fnUntraced(function* (browser: Browser, selector: Selector) {
  const { origin } = yield* Fixture
  const started = yield* browser.post("/auth/sign-in/sso", {
    callbackURL: `${origin}/dashboard`,
    newUserCallbackURL: `${origin}/welcome`,
    errorCallbackURL: `${origin}/login-error`,
    ...selector,
  })
  expect(started.status).toBe(200)
  return (yield* decode(SsoStart)(started)).url
})

/** Drives sign-in hop by hop: the service's authorization URL, the provider's redirect, then the service's callback. */
const ssoSignIn = Effect.fnUntraced(function* (browser: Browser, selector: Selector) {
  const authorizeUrl = yield* beginSso(browser, selector)
  const authorized = yield* browser.get(authorizeUrl)
  const callback = yield* browser.get(authorized.location ?? "")
  return { authorizeUrl, authorized, callback }
})

const target = (reply: Reply) => new URL(reply.location ?? "http://no-redirect.invalid")

const count = Effect.fnUntraced(function* (email: string) {
  const { sql } = yield* Fixture
  const row = yield* single(
    yield* sql<{
      readonly n: number
    }>`SELECT count(*)::int AS n FROM "user" WHERE email = ${email}`.pipe(Effect.orDie),
  )
  return row.n
})

/** Asserts that a sign-in attempt for a new address ended with an error and no user, session or cookie. */
const expectRefused = Effect.fnUntraced(function* (
  browser: Browser,
  email: string,
  callback: Reply,
) {
  expect(callback.status).toBe(302)
  expect(target(callback).searchParams.get("error")).not.toBeNull()
  expect(yield* browser.cookie(SESSION_COOKIE)).toBeUndefined()
  expect(yield* browser.session).toBeNull()
  expect(yield* count(email)).toBe(0)
})

describe("OIDC single sign-on", () => {
  it("signs a new person in through the authorization-code flow and recognizes them next time", () =>
    run(
      Effect.gen(function* () {
        const { idp, origin, sql } = yield* Fixture
        const tenant = yield* ssoTenant("acme")
        const alice = yield* idpPerson("alice", tenant.domain)
        const browser = yield* newBrowser

        const first = yield* ssoSignIn(browser, {
          providerId: tenant.providerId,
          loginHint: alice.email,
        })

        const authorization = new URL(first.authorizeUrl)
        expect(authorization.origin + authorization.pathname).toBe(`${idp.issuer}/authorize`)
        expect(authorization.searchParams.get("client_id")).toBe(idp.clientId)
        expect(authorization.searchParams.get("response_type")).toBe("code")
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
        expect(authorization.searchParams.get("redirect_uri")).toBe(
          `${origin}/auth/sso/callback/${tenant.providerId}`,
        )
        expect(authorization.searchParams.get("scope")).toBe("openid email profile")
        expect(first.authorized.status).toBe(302)
        expect(target(first.authorized).searchParams.get("state")).toBe(
          authorization.searchParams.get("state"),
        )
        expect(first.callback.status).toBe(302)
        expect(first.callback.location).toBe(`${origin}/welcome`)
        expect(idp.stats.tokenRequests).toBeGreaterThan(0)

        const session = yield* browser.session
        expect(session?.user).toMatchObject({ email: alice.email, name: "alice" })
        const stored = yield* single(
          yield* sql<{
            readonly emailVerified: boolean
          }>`SELECT "emailVerified" FROM "user" WHERE id = ${session?.user.id ?? ""}`.pipe(
            Effect.orDie,
          ),
        )
        expect(stored.emailVerified).toBe(true)
        const account = yield* single(
          yield* sql<{
            readonly providerId: string
            readonly accountId: string
            readonly userId: string
          }>`SELECT "providerId", "accountId", "userId" FROM account WHERE "userId" = ${session?.user.id ?? ""}`.pipe(
            Effect.orDie,
          ),
        )
        expect(account).toEqual({
          providerId: tenant.providerId,
          accountId: alice.sub,
          userId: session?.user.id,
        })

        const returning = yield* newBrowser
        const second = yield* ssoSignIn(returning, {
          organizationSlug: tenant.organization.slug,
          email: alice.email,
        })

        expect(second.callback.location).toBe(`${origin}/dashboard`)
        expect((yield* returning.session)?.user.id).toBe(session?.user.id)
        expect(yield* count(alice.email)).toBe(1)
      }),
    ))

  it("resolves the provider from the email domain alone", () =>
    run(
      Effect.gen(function* () {
        const tenant = yield* ssoTenant("domain")
        const bob = yield* idpPerson("bob", tenant.domain)
        const browser = yield* newBrowser

        const flow = yield* ssoSignIn(browser, { email: bob.email })

        expect(flow.callback.status).toBe(302)
        expect((yield* browser.session)?.user.email).toBe(bob.email)
      }),
    ))

  it("refuses a callback whose state was never issued, before spending the authorization code", () =>
    run(
      Effect.gen(function* () {
        const { idp } = yield* Fixture
        const tenant = yield* ssoTenant("forged")
        const mallory = yield* idpPerson("mallory", tenant.domain)
        const browser = yield* newBrowser
        const authorizeUrl = yield* beginSso(browser, {
          providerId: tenant.providerId,
          loginHint: mallory.email,
        })
        const callback = target(yield* browser.get(authorizeUrl))
        const exchanged = idp.stats.tokenRequests

        callback.searchParams.set("state", "forged-state-value")
        const refused = yield* browser.get(callback.href)

        expect(refused.status).toBe(302)
        expect(target(refused).searchParams.get("error")).toBe("state_mismatch")
        expect(idp.stats.tokenRequests).toBe(exchanged)
        yield* expectRefused(browser, mallory.email, refused)
      }),
    ))

  it("refuses a callback that carries a code but no state", () =>
    run(
      Effect.gen(function* () {
        const { idp } = yield* Fixture
        const tenant = yield* ssoTenant("stateless")
        const eve = yield* idpPerson("eve", tenant.domain)
        const browser = yield* newBrowser
        const callback = target(
          yield* browser.get(
            yield* beginSso(browser, { providerId: tenant.providerId, loginHint: eve.email }),
          ),
        )
        const exchanged = idp.stats.tokenRequests

        callback.searchParams.delete("state")
        const refused = yield* browser.get(callback.href)

        expect(target(refused).searchParams.get("error")).toBe("state_not_found")
        expect(idp.stats.tokenRequests).toBe(exchanged)
        yield* expectRefused(browser, eve.email, refused)
      }),
    ))

  it("refuses a callback completed in a browser that did not start the sign-in", () =>
    run(
      Effect.gen(function* () {
        const { idp } = yield* Fixture
        const tenant = yield* ssoTenant("fixation")
        const attacker = yield* idpPerson("attacker", tenant.domain)
        const attackerBrowser = yield* newBrowser
        const victimBrowser = yield* newBrowser
        const callback = yield* attackerBrowser.get(
          yield* beginSso(attackerBrowser, {
            providerId: tenant.providerId,
            loginHint: attacker.email,
          }),
        )
        const exchanged = idp.stats.tokenRequests

        const refused = yield* victimBrowser.get(callback.location ?? "")

        expect(target(refused).searchParams.get("error")).toBe("state_mismatch")
        expect(idp.stats.tokenRequests).toBe(exchanged)
        yield* expectRefused(victimBrowser, attacker.email, refused)
      }),
    ))

  it("refuses to replay a finished callback", () =>
    run(
      Effect.gen(function* () {
        const { idp } = yield* Fixture
        const tenant = yield* ssoTenant("replay")
        const carol = yield* idpPerson("carol", tenant.domain)
        const browser = yield* newBrowser
        const authorizeUrl = yield* beginSso(browser, {
          providerId: tenant.providerId,
          loginHint: carol.email,
        })
        const callbackUrl = (yield* browser.get(authorizeUrl)).location ?? ""
        const done = yield* browser.get(callbackUrl)
        expect(done.status).toBe(302)
        expect(target(done).searchParams.get("error")).toBeNull()
        const exchanged = idp.stats.tokenRequests

        const thief = yield* newBrowser
        const replayed = yield* thief.get(callbackUrl)

        expect(target(replayed).searchParams.get("error")).toBe("state_mismatch")
        expect(idp.stats.tokenRequests).toBe(exchanged)
        expect(yield* thief.cookie(SESSION_COOKIE)).toBeUndefined()
        expect(yield* count(carol.email)).toBe(1)
      }),
    ))

  it("refuses a callback whose state expired while the person was at the provider", () =>
    run(
      Effect.gen(function* () {
        const { idp, sql } = yield* Fixture
        const tenant = yield* ssoTenant("expired")
        const heidi = yield* idpPerson("heidi", tenant.domain)
        const browser = yield* newBrowser
        const callback = target(
          yield* browser.get(
            yield* beginSso(browser, { providerId: tenant.providerId, loginHint: heidi.email }),
          ),
        )
        const exchanged = idp.stats.tokenRequests
        const lapsed = yield* sql<{
          readonly identifier: string
        }>`UPDATE verification
          SET value = jsonb_set(value::jsonb, '{expiresAt}', to_jsonb((extract(epoch FROM now()) * 1000)::bigint - 60000))::text
          WHERE identifier = ${`auth-state:${callback.searchParams.get("state")}`}
          RETURNING identifier`.pipe(Effect.orDie)
        expect(lapsed).toHaveLength(1)

        const refused = yield* browser.get(callback.href)

        expect(target(refused).searchParams.get("error")).toBe("state_mismatch")
        expect(idp.stats.tokenRequests).toBe(exchanged)
        yield* expectRefused(browser, heidi.email, refused)
      }),
    ))

  it("refuses to finish one provider's sign-in at another provider's callback", () =>
    run(
      Effect.gen(function* () {
        const { idp } = yield* Fixture
        const first = yield* ssoTenant("first")
        const second = yield* ssoTenant("second")
        const ivan = yield* idpPerson("ivan", first.domain)
        const browser = yield* newBrowser
        const callback = target(
          yield* browser.get(
            yield* beginSso(browser, { providerId: first.providerId, loginHint: ivan.email }),
          ),
        )
        const exchanged = idp.stats.tokenRequests

        callback.pathname = `/auth/sso/callback/${second.providerId}`
        const refused = yield* browser.get(callback.href)

        expect(target(refused).searchParams.get("error")).toBe("invalid_state")
        expect(idp.stats.tokenRequests).toBe(exchanged)
        yield* expectRefused(browser, ivan.email, refused)
      }),
    ))

  it("does not sign anyone in when the provider denies the request", () =>
    run(
      Effect.gen(function* () {
        const { idp, origin } = yield* Fixture
        const tenant = yield* ssoTenant("denied")
        const browser = yield* newBrowser
        const stranger = `stranger@${tenant.domain}`
        const exchanged = idp.stats.tokenRequests

        const flow = yield* ssoSignIn(browser, {
          providerId: tenant.providerId,
          loginHint: stranger,
        })

        expect(`${target(flow.callback).origin}${target(flow.callback).pathname}`).toBe(
          `${origin}/login-error`,
        )
        expect(target(flow.callback).searchParams.get("error")).toBe("access_denied")
        expect(idp.stats.tokenRequests).toBe(exchanged)
        yield* expectRefused(browser, stranger, flow.callback)
      }),
    ))

  const faults: ReadonlyArray<readonly [TokenFault, string]> = [
    ["bad-signature", "token_not_verified"],
    ["wrong-audience", "token_not_verified"],
    ["wrong-issuer", "token_not_verified"],
    ["expired", "token_not_verified"],
    ["alg-none", "token_not_verified"],
    ["userinfo-subject-mismatch", "id_token_userinfo_subject_mismatch"],
  ]

  it.each(faults)("rejects an ID token that fails validation: %s", (fault, description) =>
    run(
      Effect.gen(function* () {
        const { idp, origin } = yield* Fixture
        const tenant = yield* ssoTenant("token")
        const dave = yield* idpPerson("dave", tenant.domain)
        const browser = yield* newBrowser
        const exchanged = idp.stats.tokenRequests
        idp.injectFault(fault)

        const flow = yield* ssoSignIn(browser, {
          providerId: tenant.providerId,
          loginHint: dave.email,
        })

        expect(idp.stats.tokenRequests).toBe(exchanged + 1)
        expect(`${target(flow.callback).origin}${target(flow.callback).pathname}`).toBe(
          `${origin}/login-error`,
        )
        expect(target(flow.callback).searchParams.get("error")).toBe("invalid_provider")
        expect(target(flow.callback).searchParams.get("error_description")).toBe(description)
        yield* expectRefused(browser, dave.email, flow.callback)
      }),
    ),
  )

  it("accepts the same flow once the fault is gone, so the rejections above are about the token alone", () =>
    run(
      Effect.gen(function* () {
        const tenant = yield* ssoTenant("control")
        const erin = yield* idpPerson("erin", tenant.domain)
        const browser = yield* newBrowser

        const flow = yield* ssoSignIn(browser, {
          providerId: tenant.providerId,
          loginHint: erin.email,
        })

        expect(target(flow.callback).searchParams.get("error")).toBeNull()
        expect((yield* browser.session)?.user.email).toBe(erin.email)
      }),
    ))

  it("rejects a token response when the registered client secret is wrong", () =>
    run(
      Effect.gen(function* () {
        const { idp } = yield* Fixture
        const owner = yield* verifiedUser("secret-owner")
        const organization = yield* createOrganization(owner.browser, "secret")
        const domain = `secret-${next()}.test`
        const providerId = `secret-oidc-${next()}`
        const registered = yield* registerProvider(owner.browser, {
          organizationId: organization.id,
          providerId,
          domain,
          clientSecret: "not-the-secret",
        })
        expect(registered.status).toBe(200)
        const frank = yield* idpPerson("frank", domain)
        const browser = yield* newBrowser
        const exchanged = idp.stats.tokenRequests

        const flow = yield* ssoSignIn(browser, { providerId, loginHint: frank.email })

        expect(idp.stats.tokenRequests).toBe(exchanged + 1)
        expect(target(flow.callback).searchParams.get("error")).toBe("invalid_provider")
        yield* expectRefused(browser, frank.email, flow.callback)
      }),
    ))

  it("does not link a provider identity to a password account that shares its email address on the provider's own domain", () =>
    run(
      Effect.gen(function* () {
        const { sql, idp } = yield* Fixture
        const tenant = yield* ssoTenant("takeover")
        const victim = yield* verifiedUser("victim", tenant.domain)
        idp.addUser({
          sub: `sub-${next()}`,
          email: victim.email,
          name: "impostor",
          emailVerified: true,
        })
        const browser = yield* newBrowser

        const flow = yield* ssoSignIn(browser, {
          providerId: tenant.providerId,
          loginHint: victim.email,
        })

        expect(flow.callback.status).toBe(302)
        expect(target(flow.callback).searchParams.get("error")).toBe("account not linked")
        expect(yield* browser.cookie(SESSION_COOKIE)).toBeUndefined()
        expect(yield* browser.session).toBeNull()
        const linked = yield* sql<{
          readonly n: number
        }>`SELECT count(*)::int AS n FROM account WHERE "userId" = ${victim.userId} AND "providerId" = ${tenant.providerId}`.pipe(
          Effect.orDie,
        )
        expect(linked[0]?.n).toBe(0)
        expect(yield* count(victim.email)).toBe(1)
        expect((yield* victim.browser.session)?.user.id).toBe(victim.userId)
      }),
    ))

  it("rejects an identity whose email is outside the provider's verified domain, even when it matches a password account", () =>
    run(
      Effect.gen(function* () {
        const { sql, idp } = yield* Fixture
        const tenant = yield* ssoTenant("outside")
        const victim = yield* verifiedUser("outside-victim")
        idp.addUser({
          sub: `sub-${next()}`,
          email: victim.email,
          name: "impostor",
          emailVerified: true,
        })
        const stranger = yield* idpPerson("stranger", "elsewhere.test")
        const browser = yield* newBrowser

        const takeover = yield* ssoSignIn(browser, {
          providerId: tenant.providerId,
          loginHint: victim.email,
        })
        const unrelated = yield* ssoSignIn(browser, {
          providerId: tenant.providerId,
          loginHint: stranger.email,
        })

        expect(target(takeover.callback).searchParams.get("error")).toBe("SSO_DOMAIN_MISMATCH")
        expect(target(unrelated.callback).searchParams.get("error")).toBe("SSO_DOMAIN_MISMATCH")
        expect(yield* browser.session).toBeNull()
        const linked = yield* sql<{
          readonly n: number
        }>`SELECT count(*)::int AS n FROM account WHERE "userId" = ${victim.userId} AND "providerId" = ${tenant.providerId}`.pipe(
          Effect.orDie,
        )
        expect(linked[0]?.n).toBe(0)
        expect(yield* count(stranger.email)).toBe(0)
      }),
    ))

  it("refuses to start a sign-in with a provider whose domain is not verified", () =>
    run(
      Effect.gen(function* () {
        const { idp, origin } = yield* Fixture
        const tenant = yield* ssoTenant("unverified", { domainVerified: false })
        const judy = yield* idpPerson("judy", tenant.domain)
        const browser = yield* newBrowser
        const authorizations = idp.stats.authorizations.length

        const refused = yield* browser.post("/auth/sign-in/sso", {
          providerId: tenant.providerId,
          loginHint: judy.email,
          callbackURL: `${origin}/dashboard`,
        })

        expect(refused.status).toBe(401)
        expect(idp.stats.authorizations).toHaveLength(authorizations)
        expect(yield* count(judy.email)).toBe(0)
      }),
    ))

  it("refuses a sign-in through a provider whose organization is not an enterprise organization", () =>
    run(
      Effect.gen(function* () {
        const tenant = yield* ssoTenant("ordinary", { enterprise: false })
        const ken = yield* idpPerson("ken", tenant.domain)
        const browser = yield* newBrowser

        const flow = yield* ssoSignIn(browser, {
          providerId: tenant.providerId,
          loginHint: ken.email,
        })

        expect(target(flow.callback).searchParams.get("error")).toBe("SSO_ENTERPRISE_REQUIRED")
        yield* expectRefused(browser, ken.email, flow.callback)
      }),
    ))

  it("only lets an organization owner or admin register a provider for it", () =>
    run(
      Effect.gen(function* () {
        const { sql, idp } = yield* Fixture
        const tenant = yield* ssoTenant("guard")
        const outsider = yield* verifiedUser("outsider")
        const anonymous = yield* newBrowser
        const body = (providerId: string): Json => ({
          providerId,
          issuer: idp.issuer,
          domain: `${providerId}.test`,
          organizationId: tenant.organization.id,
          oidcConfig: { clientId: idp.clientId, clientSecret: idp.clientSecret },
        })

        const unauthenticated = yield* anonymous.post("/auth/sso/register", body(`anon-${next()}`))
        const notMember = yield* registerProvider(outsider.browser, {
          organizationId: tenant.organization.id,
          providerId: `outsider-${next()}`,
          domain: `outsider-${next()}.test`,
        })
        const reserved = yield* tenant.owner.browser.post("/auth/sso/register", body("github"))

        expect(unauthenticated.status).toBe(401)
        expect(notMember.status).toBe(400)
        expect(reserved.status).toBe(422)
        const rows = yield* sql<{
          readonly n: number
        }>`SELECT count(*)::int AS n FROM "ssoProvider" WHERE "organizationId" = ${tenant.organization.id}`.pipe(
          Effect.orDie,
        )
        expect(rows[0]?.n).toBe(1)
      }),
    ))

  it("refuses to register a provider on an origin the service does not trust", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const { sql } = yield* Fixture
          const foreign = yield* startIdp
          const owner = yield* verifiedUser("ssrf-owner")
          const organization = yield* createOrganization(owner.browser, "ssrf")
          const providerId = `ssrf-${next()}`

          const refused = yield* owner.browser.post("/auth/sso/register", {
            providerId,
            issuer: foreign.issuer,
            domain: `${providerId}.test`,
            organizationId: organization.id,
            oidcConfig: { clientId: foreign.clientId, clientSecret: foreign.clientSecret },
          })

          expect(refused.status).toBe(400)
          expect(foreign.stats.tokenRequests + foreign.stats.userinfoRequests).toBe(0)
          const rows = yield* sql<{
            readonly n: number
          }>`SELECT count(*)::int AS n FROM "ssoProvider" WHERE "providerId" = ${providerId}`.pipe(
            Effect.orDie,
          )
          expect(rows[0]?.n).toBe(0)
        }),
      ),
    ))
  it("refuses a sign-in started from another origin or with an open-redirect callback", () =>
    run(
      Effect.gen(function* () {
        const tenant = yield* ssoTenant("origin")
        const grace = yield* idpPerson("grace", tenant.domain)
        const signedIn = tenant.owner.browser
        const selector = { providerId: tenant.providerId, loginHint: grace.email }

        const foreignOrigin = yield* signedIn.post(
          "/auth/sign-in/sso",
          { callbackURL: "/dashboard", ...selector },
          "https://evil.example",
        )
        const openRedirect = yield* signedIn.post("/auth/sign-in/sso", {
          callbackURL: "https://evil.example/steal",
          ...selector,
        })

        expect(foreignOrigin.status).toBe(403)
        expect(openRedirect.status).toBe(403)
        expect(yield* count(grace.email)).toBe(0)
      }),
    ))
})

describe("password sign-up", () => {
  it("does not sign in an unverified address and rejects a tampered verification token", () =>
    run(
      Effect.gen(function* () {
        const { sql, origin } = yield* Fixture
        const browser = yield* newBrowser
        const email = `unverified-${next()}@example.test`
        yield* browser.post("/auth/sign-up/email", {
          name: "unverified",
          email,
          password: PASSWORD,
          callbackURL: `${origin}/welcome`,
        })

        const signIn = yield* browser.post("/auth/sign-in/email", { email, password: PASSWORD })
        const link = new URL(yield* verificationLink(email))
        const token = link.searchParams.get("token") ?? ""
        const at = token.length - 10
        link.searchParams.set(
          "token",
          `${token.slice(0, at)}${token[at] === "a" ? "b" : "a"}${token.slice(at + 1)}`,
        )
        const tampered = yield* browser.get(link.href)

        expect(signIn.status).toBe(403)
        expect(tampered.status).not.toBe(200)
        expect(yield* browser.session).toBeNull()
        const rows = yield* sql<{
          readonly emailVerified: boolean
        }>`SELECT "emailVerified" FROM "user" WHERE email = ${email}`.pipe(Effect.orDie)
        expect(rows[0]?.emailVerified).toBe(false)
      }),
    ))
})

describe("outgoing mail", () => {
  const invite = Effect.fnUntraced(function* (label: string) {
    const user = yield* verifiedUser(label)
    const organization = yield* createOrganization(user.browser, label)
    const invitee = `invitee-${next()}@example.test`
    const invited = yield* user.browser.post("/auth/organization/invite-member", {
      email: invitee,
      role: "member",
      organizationId: organization.id,
    })
    expect(invited.status).toBe(200)
    return { invitee, invitation: yield* decode(Identified)(invited) }
  })

  it("is sent outside Better Auth's transaction store, so later sessions never read a committed transaction", () =>
    run(
      Effect.gen(function* () {
        const { mailStores } = yield* Fixture

        yield* invite("mailer")

        expect(mailStores.length).toBeGreaterThanOrEqual(2)
        expect(mailStores.every((store) => store === undefined)).toBe(true)
      }),
    ))

  it("links verification and password-reset mail to the console, keeping a callback the caller chose", () =>
    run(
      Effect.gen(function* () {
        const { sql } = yield* Fixture
        const browser = yield* newBrowser
        const email = `linked-${next()}@example.test`
        const chosen = `https://console.akter.test/welcome`
        yield* browser.post("/auth/sign-up/email", { name: "linked", email, password: PASSWORD })
        const defaulted = new URL(yield* verificationLink(email))
        const verified = yield* browser.get(defaulted.href)
        yield* browser.post("/auth/request-password-reset", { email })
        const [reset] = yield* sql<{
          readonly body: string
        }>`SELECT body FROM cloud_email_outbox WHERE recipient = ${email} AND subject = 'Reset your password'`.pipe(
          Effect.orDie,
          Effect.filterOrFail((found) => found.length > 0),
          Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
          Effect.orDie,
        )
        const resetLink = new URL(reset?.body ?? "")
        const other = yield* newBrowser
        const otherEmail = `chosen-${next()}@example.test`
        yield* other.post("/auth/sign-up/email", {
          name: "chosen",
          email: otherEmail,
          password: PASSWORD,
          callbackURL: chosen,
        })
        const kept = new URL(yield* verificationLink(otherEmail))

        expect(defaulted.searchParams.get("callbackURL")).toBe("https://console.akter.test/")
        expect(target(verified).origin).toBe("https://console.akter.test")
        expect(resetLink.searchParams.get("callbackURL")).toBe(
          "https://console.akter.test/reset-password",
        )
        expect(kept.searchParams.get("callbackURL")).toBe(chosen)
      }),
    ))

  it("links an invitation to the console's invitation page", () =>
    run(
      Effect.gen(function* () {
        const { sql } = yield* Fixture

        const { invitee, invitation } = yield* invite("linker")

        const [mail] = yield* sql<{
          readonly body: string
        }>`SELECT body FROM cloud_email_outbox WHERE recipient = ${invitee} AND subject LIKE 'Join %'`.pipe(
          Effect.orDie,
          Effect.filterOrFail((found) => found.length > 0),
          Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
          Effect.orDie,
        )
        expect(mail?.body).toBe(`https://console.akter.test/invitations/${invitation.id}`)
      }),
    ))
})

describe("production rate limiting", () => {
  it.each([
    { production: true, throttled: true },
    { production: false, throttled: false },
  ])(
    "throttles repeated password guesses only when production is $production",
    ({ production, throttled }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* createDatabase
          const origin = "https://api.akter.test"
          const sqlLayer = PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })
          const services = yield* Layer.build(
            Auth.layer({
              databaseUrl: Redacted.make(url),
              secret: Redacted.make("a-local-test-signing-secret-long-enough"),
              origin,
              port: 0,
              production,
              emailMode: "local",
              emailFrom: "Akter <auth@localhost>",
            }).pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  localEmail.pipe(Layer.provide(sqlLayer)),
                  Postgres(url),
                  sqlLayer,
                  processRuntimeLayer,
                ),
              ),
            ),
          )
          const auth = Context.get(services, Auth)
          const guess = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            email: "nobody@example.test",
            password: "a-wrong-password-guess",
          }).pipe(Effect.orDie)
          const statuses: Array<number> = []
          for (let attempt = 0; attempt < 8; attempt++) {
            const response = yield* Effect.promise(() =>
              auth.handler(
                new Request(`${origin}/auth/sign-in/email`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    origin,
                    "x-forwarded-for": "203.0.113.7",
                  },
                  body: guess,
                }),
              ),
            )
            statuses.push(response.status)
          }

          expect(statuses.includes(429)).toBe(throttled)
          expect(statuses[0]).toBe(401)
        }),
      ).pipe(Effect.runPromise),
    60_000,
  )
})

describe("organization teams", () => {
  it("lets a member create a team and keeps non-members out", () =>
    run(
      Effect.gen(function* () {
        const { sql } = yield* Fixture
        const owner = yield* verifiedUser("team-owner")
        const outsider = yield* verifiedUser("team-outsider")
        const organization = yield* createOrganization(owner.browser, "teams")

        const created = yield* owner.browser.post("/auth/organization/create-team", {
          name: "platform",
          organizationId: organization.id,
        })
        const refused = yield* outsider.browser.post("/auth/organization/create-team", {
          name: "intruders",
          organizationId: organization.id,
        })

        expect(created.status).toBe(200)
        expect(refused.status).toBeGreaterThanOrEqual(400)
        const teams = yield* sql<{
          readonly name: string
        }>`SELECT name FROM team WHERE "organizationId" = ${organization.id}`.pipe(Effect.orDie)
        expect(teams.map((team) => team.name)).toContain("platform")
        expect(teams.map((team) => team.name)).not.toContain("intruders")
      }),
    ))
})

describe("organization API keys", () => {
  const verify = Effect.fnUntraced(function* (key: string) {
    const { auth } = yield* Fixture
    return yield* Effect.promise(() => auth.api.verifyApiKey({ body: { key } }))
  })

  const issueKey = Effect.fnUntraced(function* (expiresIn: number) {
    const owner = yield* verifiedUser("key-owner")
    const organization = yield* createOrganization(owner.browser, "keys")
    const created = yield* owner.browser.post("/auth/api-key/create", {
      name: "ci",
      organizationId: organization.id,
      expiresIn,
    })
    return { owner, organization, created }
  })

  it("issues a hashed, prefixed key that expires when asked and authenticates until then", () =>
    run(
      Effect.gen(function* () {
        const { sql } = yield* Fixture
        const issued = yield* issueKey(2 * DAY_SECONDS)
        expect(issued.created.status).toBe(200)
        const key = yield* decode(CreatedKey)(issued.created)
        const now = yield* Clock.currentTimeMillis

        expect(key.key.startsWith("akter_")).toBe(true)
        expect(key.referenceId).toBe(issued.organization.id)
        const expiresAt = DateTime.toEpochMillis(DateTime.makeUnsafe(key.expiresAt ?? ""))
        expect(Math.abs(expiresAt - (now + 2 * DAY_SECONDS * 1000))).toBeLessThan(60_000)
        const stored = yield* single(
          yield* sql<{
            readonly key: string
          }>`SELECT key FROM apikey WHERE id = ${key.id}`.pipe(Effect.orDie),
        )
        expect(stored.key).not.toBe(key.key)
        expect(stored.key).not.toContain(key.key)

        const accepted = yield* verify(key.key)
        expect(accepted.valid).toBe(true)
        expect(accepted.key?.id).toBe(key.id)
        expect(accepted.key?.referenceId).toBe(issued.organization.id)

        yield* sql`UPDATE apikey SET "expiresAt" = now() + interval '1 minute' WHERE id = ${key.id}`.pipe(
          Effect.orDie,
        )
        expect((yield* verify(key.key)).valid).toBe(true)
      }),
    ))

  it("rejects a key the moment it expires and deletes it", () =>
    run(
      Effect.gen(function* () {
        const { sql } = yield* Fixture
        const issued = yield* issueKey(DAY_SECONDS)
        const key = yield* decode(CreatedKey)(issued.created)
        yield* sql`UPDATE apikey SET "expiresAt" = now() + interval '2 seconds' WHERE id = ${key.id}`.pipe(
          Effect.orDie,
        )
        expect((yield* verify(key.key)).valid).toBe(true)

        yield* Effect.sleep("2500 millis")
        const expired = yield* verify(key.key)

        expect(expired.valid).toBe(false)
        expect(expired.key).toBeNull()
        expect(expired.error?.code).toBe("KEY_EXPIRED")
        const rows = yield* sql<{
          readonly n: number
        }>`SELECT count(*)::int AS n FROM apikey WHERE id = ${key.id}`.pipe(Effect.orDie)
        expect(rows[0]?.n).toBe(0)
        const again = yield* verify(key.key)
        expect(again.valid).toBe(false)
        expect(again.error?.code).toBe("INVALID_API_KEY")
      }),
    ))

  it("rejects a key whose expiry passed long before it was presented", () =>
    run(
      Effect.gen(function* () {
        const { sql } = yield* Fixture
        const issued = yield* issueKey(DAY_SECONDS)
        const key = yield* decode(CreatedKey)(issued.created)
        yield* sql`UPDATE apikey SET "expiresAt" = now() - interval '30 days' WHERE id = ${key.id}`.pipe(
          Effect.orDie,
        )

        const expired = yield* verify(key.key)

        expect(expired.valid).toBe(false)
        expect(expired.error?.code).toBe("KEY_EXPIRED")
      }),
    ))

  it("rejects unknown and altered keys", () =>
    run(
      Effect.gen(function* () {
        const issued = yield* issueKey(DAY_SECONDS)
        const key = yield* decode(CreatedKey)(issued.created)
        const altered = `${key.key.slice(0, -1)}${key.key.endsWith("a") ? "b" : "a"}`

        expect((yield* verify(altered)).valid).toBe(false)
        expect((yield* verify("akter_never-issued")).valid).toBe(false)
        expect((yield* verify(key.key)).valid).toBe(true)
      }),
    ))

  it("holds expiry to the configured bounds over HTTP", () =>
    run(
      Effect.gen(function* () {
        const tooShort = yield* issueKey(3600)
        const tooLong = yield* issueKey(400 * DAY_SECONDS)

        expect(tooShort.created.status).toBe(400)
        expect((yield* decode(ApiError)(tooShort.created)).code).toBe("EXPIRES_IN_IS_TOO_SMALL")
        expect(tooLong.created.status).toBe(400)
        expect((yield* decode(ApiError)(tooLong.created)).code).toBe("EXPIRES_IN_IS_TOO_LARGE")
      }),
    ))

  it("issues keys only to members of the organization", () =>
    run(
      Effect.gen(function* () {
        const { sql } = yield* Fixture
        const owner = yield* verifiedUser("owner")
        const outsider = yield* verifiedUser("outsider")
        const organization = yield* createOrganization(owner.browser, "guarded")
        const anonymous = yield* newBrowser
        const body: Json = {
          name: "stolen",
          organizationId: organization.id,
          expiresIn: DAY_SECONDS,
        }

        const byOutsider = yield* outsider.browser.post("/auth/api-key/create", body)
        const byAnonymous = yield* anonymous.post("/auth/api-key/create", body)

        expect(byOutsider.status).toBe(403)
        expect(byAnonymous.status).toBe(401)
        const rows = yield* sql<{
          readonly n: number
        }>`SELECT count(*)::int AS n FROM apikey WHERE "referenceId" = ${organization.id}`.pipe(
          Effect.orDie,
        )
        expect(rows[0]?.n).toBe(0)
      }),
    ))
})

describe("device authorization rate limits", () => {
  it(
    "lets one address look up twenty device codes in ten minutes, more than the plugin's five, and refuses the twenty-first",
    () =>
      Effect.gen(function* () {
        const url = yield* createDatabase
        const sqlLayer = PgClient.layer({ url: Redacted.make(url), maxConnections: 2 })
        const services = yield* Layer.build(
          Auth.layer({
            databaseUrl: Redacted.make(url),
            secret: Redacted.make("a-local-test-signing-secret-long-enough"),
            origin: "https://api.akter.test",
            port: 0,
            production: true,
            emailMode: "local",
            emailFrom: "Akter <auth@localhost>",
          }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                localEmail.pipe(Layer.provide(sqlLayer)),
                Postgres(url),
                sqlLayer,
                processRuntimeLayer,
              ),
            ),
          ),
        )
        const auth = Context.get(services, Auth)
        const statuses: Array<number> = []

        for (let attempt = 0; attempt < 21; attempt++)
          statuses.push(
            (yield* Effect.promise(() =>
              auth.handler(
                new Request("https://api.akter.test/auth/device?user_code=NOPE2345", {
                  headers: { "x-forwarded-for": "203.0.113.7" },
                }),
              ),
            )).status,
          )

        expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 400))
        expect(statuses[20]).toBe(429)
      }).pipe(Effect.scoped, Effect.runPromise),
    60_000,
  )
})
