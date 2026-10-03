import { Clock, Effect, Schema, type Scope } from "effect"

/** A person the test identity provider can authenticate. */
export interface IdpUser {
  readonly sub: string
  readonly email: string
  readonly name: string
  readonly emailVerified: boolean
}

/** One way the next token exchange is made to misbehave. */
export type TokenFault =
  | "bad-signature"
  | "wrong-audience"
  | "wrong-issuer"
  | "expired"
  | "alg-none"
  | "userinfo-subject-mismatch"

/** What the provider saw, for asserting that a request was or was not forwarded to it. */
export interface IdpStats {
  readonly authorizations: Array<URLSearchParams>
  tokenRequests: number
  userinfoRequests: number
}

/** A running loopback OpenID Connect provider. */
export interface Idp {
  readonly origin: string
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  readonly kid: string
  readonly stats: IdpStats
  /** Routes every request outside the provider's own `/idp` prefix to `handler`, so the provider and the service under test share one origin. */
  readonly mount: (handler: (request: Request) => Promise<Response>) => void
  readonly allowRedirect: (uri: string) => void
  readonly addUser: (user: IdpUser) => void
  /** Makes the next token exchange misbehave once. */
  readonly injectFault: (fault: TokenFault) => void
}

interface Mount {
  handler: ((request: Request) => Promise<Response>) | undefined
}

type JwtHeader = { readonly alg: string; readonly kid: string; readonly typ: string }

type JwtClaims = {
  readonly iss: string
  readonly sub: string
  readonly aud: string
  readonly iat: number
  readonly exp: number
  readonly email: string
  readonly email_verified: boolean
  readonly name: string
}

type Grant = {
  readonly redirectUri: string
  readonly user: IdpUser
  readonly challenge: string
  readonly expiresAt: number
}

type Session = { readonly user: IdpUser; readonly subjectMismatch: boolean }

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const base64url = (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) =>
  Buffer.from(new Uint8Array(bytes)).toString("base64url")

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(24)))

const generateKeyPair = Effect.promise(() =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
)

const CODE_LIFETIME_MILLIS = 60_000
const TOKEN_LIFETIME_SECONDS = 300

/**
 * Signs a compact JWS with ES256. WebCrypto already emits the raw `r || s`
 * signature JWS requires. The `none` algorithm carries an empty signature.
 */
const sign = Effect.fnUntraced(function* (key: CryptoKey, header: JwtHeader, claims: JwtClaims) {
  const signingInput = `${base64url(new TextEncoder().encode(yield* encodeJson(header)))}.${base64url(new TextEncoder().encode(yield* encodeJson(claims)))}`
  if (header.alg === "none") return `${signingInput}.`
  const signature = yield* Effect.promise(() =>
    crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  )
  return `${signingInput}.${base64url(signature)}`
})

/**
 * Starts a loopback OpenID Connect provider for authorization-code sign-in:
 * discovery, authorization with real redirects, a PKCE-enforcing token
 * endpoint with client authentication, a JWKS and userinfo. ID tokens are
 * ES256 JWTs. The provider closes with the scope.
 */
export const startIdp: Effect.Effect<Idp, never, Scope.Scope> = Effect.gen(function* () {
  const signingKey = yield* generateKeyPair
  const rogueKey = yield* generateKeyPair
  const publicJwk = yield* Effect.promise(() =>
    crypto.subtle.exportKey("jwk", signingKey.publicKey),
  )
  const kid = `idp-${randomToken().slice(0, 8)}`
  const clientId = `client-${randomToken().slice(0, 8)}`
  const clientSecret = randomToken()
  const redirects = new Set<string>()
  const users = new Map<string, IdpUser>()
  const grants = new Map<string, Grant>()
  const sessions = new Map<string, Session>()
  const faults: Array<TokenFault> = []
  const stats: IdpStats = { authorizations: [], tokenRequests: 0, userinfoRequests: 0 }
  const mounted: Mount = { handler: undefined }
  const origins = { origin: "" }
  const context = yield* Effect.context<never>()

  const issuer = () => `${origins.origin}/idp`
  const redirectTo = (uri: string, params: Record<string, string>) => {
    const target = new URL(uri)
    for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value)
    return Response.redirect(target.href, 302)
  }
  const failure = (status: number, error: string) => Response.json({ error }, { status })

  const discovery = () =>
    Response.json({
      issuer: issuer(),
      authorization_endpoint: `${issuer()}/authorize`,
      token_endpoint: `${issuer()}/token`,
      jwks_uri: `${issuer()}/jwks`,
      userinfo_endpoint: `${issuer()}/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "email", "profile"],
    })

  const authorize = (url: URL) => {
    const query = url.searchParams
    stats.authorizations.push(query)
    const redirectUri = query.get("redirect_uri") ?? ""
    if (query.get("client_id") !== clientId || !redirects.has(redirectUri)) {
      return Effect.succeed(failure(400, "invalid_request"))
    }
    const state = query.get("state") ?? ""
    const deny = (error: string) => Effect.succeed(redirectTo(redirectUri, { error, state }))
    const challenge = query.get("code_challenge") ?? ""
    if (query.get("response_type") !== "code") return deny("unsupported_response_type")
    if (challenge === "" || query.get("code_challenge_method") !== "S256")
      return deny("invalid_request")
    const user = users.get(query.get("login_hint") ?? "")
    if (user === undefined) return deny("access_denied")
    return Effect.gen(function* () {
      const code = randomToken()
      grants.set(code, {
        redirectUri,
        user,
        challenge,
        expiresAt: (yield* Clock.currentTimeMillis) + CODE_LIFETIME_MILLIS,
      })
      return redirectTo(redirectUri, { code, state })
    })
  }

  const clientAuthenticated = (request: Request) => {
    const header = request.headers.get("authorization") ?? ""
    if (!header.startsWith("Basic ")) return false
    return Buffer.from(header.slice(6), "base64").toString() === `${clientId}:${clientSecret}`
  }

  const token = Effect.fnUntraced(function* (request: Request) {
    stats.tokenRequests += 1
    if (!clientAuthenticated(request)) return failure(401, "invalid_client")
    const form = new URLSearchParams(yield* Effect.promise(() => request.text()))
    const code = form.get("code") ?? ""
    const grant = grants.get(code)
    grants.delete(code)
    const now = yield* Clock.currentTimeMillis
    if (
      form.get("grant_type") !== "authorization_code" ||
      grant === undefined ||
      grant.expiresAt < now
    ) {
      return failure(400, "invalid_grant")
    }
    if (form.get("redirect_uri") !== grant.redirectUri) return failure(400, "invalid_grant")
    const verifier = form.get("code_verifier") ?? ""
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    )
    if (verifier === "" || base64url(digest) !== grant.challenge)
      return failure(400, "invalid_grant")

    const fault = faults.shift()
    const seconds = Math.floor(now / 1000)
    const accessToken = randomToken()
    sessions.set(accessToken, {
      user: grant.user,
      subjectMismatch: fault === "userinfo-subject-mismatch",
    })
    const idToken = yield* sign(
      fault === "bad-signature" ? rogueKey.privateKey : signingKey.privateKey,
      { alg: fault === "alg-none" ? "none" : "ES256", kid, typ: "JWT" },
      {
        iss: fault === "wrong-issuer" ? "https://evil.example" : issuer(),
        sub: grant.user.sub,
        aud: fault === "wrong-audience" ? "another-client" : clientId,
        iat: fault === "expired" ? seconds - 7200 : seconds,
        exp: fault === "expired" ? seconds - 3600 : seconds + TOKEN_LIFETIME_SECONDS,
        email: grant.user.email,
        email_verified: grant.user.emailVerified,
        name: grant.user.name,
      },
    )
    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: TOKEN_LIFETIME_SECONDS,
        id_token: idToken,
        scope: "openid email profile",
      },
      { headers: { "cache-control": "no-store" } },
    )
  })

  const userinfo = (request: Request) => {
    stats.userinfoRequests += 1
    const session = sessions.get(
      (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
    )
    if (session === undefined) return failure(401, "invalid_token")
    return Response.json({
      sub: session.subjectMismatch ? "someone-else" : session.user.sub,
      email: session.user.email,
      email_verified: session.user.emailVerified,
      name: session.user.name,
    })
  }

  const route = Effect.fnUntraced(function* (request: Request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/idp/")) {
      if (mounted.handler === undefined) return new Response("not found", { status: 404 })
      return yield* Effect.promise(() => mounted.handler!(request))
    }
    const path = url.pathname.slice("/idp".length)
    if (request.method === "GET" && path === "/.well-known/openid-configuration") return discovery()
    if (request.method === "GET" && path === "/authorize") return yield* authorize(url)
    if (request.method === "POST" && path === "/token") return yield* token(request)
    if (request.method === "GET" && path === "/jwks")
      return Response.json({ keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] })
    if (request.method === "GET" && path === "/userinfo") return userinfo(request)
    return new Response("not found", { status: 404 })
  })

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => Effect.runPromiseWith(context)(route(request)),
      }),
    ),
    (running) => Effect.promise(() => running.stop(true)),
  )
  origins.origin = `http://127.0.0.1:${server.port}`

  return {
    origin: origins.origin,
    issuer: issuer(),
    clientId,
    clientSecret,
    kid,
    stats,
    mount: (handler) => {
      mounted.handler = handler
    },
    allowRedirect: (uri) => {
      redirects.add(uri)
    },
    addUser: (user) => {
      users.set(user.email, user)
    },
    injectFault: (fault) => {
      faults.push(fault)
    },
  } satisfies Idp
})
