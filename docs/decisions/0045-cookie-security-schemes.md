# ADR 0045: Cookie credentials in `Actor.auth.make` and OpenAPI

**Status:** proposed (2026-09-28, issue #122); the review of its pull request decides it. It amends [ADR 0027](0027-served-protocol.md) section 3, where `Actor.auth.make` providers "declare `cookies: true`" to receive cookies, and section 6, where "the auth provider contributes its security scheme", one per provider.

**Responsibility:** decide how a custom auth provider says which cookie carries its credential, and how the served OpenAPI document describes it.

**Authority:** design decision record.

**Owner role:** API/SDK.

**Change policy:** supersede through a new ADR.

## Context

M3.2 (#108) shipped `Actor.auth.make({ authenticate, cookies: true })`. The flag gives the provider the request's cookies, but it names no cookie, so the OpenAPI document can't describe the credential. Every custom provider was documented as `http` `bearer`, so a generated client for a cookie-only provider sent `authorization` and got `401 missing_credentials`. OpenAPI 3.1 describes a cookie credential as an `apiKey` security scheme with `in: cookie` and the cookie's `name`.

## Decision

- **A provider names its cookie.** `Actor.auth.make({ authenticate, cookies: { name } })` replaces `cookies: true`. `name` must be an RFC 9110 token, as RFC 6265 requires of a cookie name; `Actor.auth.make` throws otherwise. The provider still receives every request cookie, since sessions often need more than one; `name` is the one that carries the credential.
- **Bearer is the default only without a cookie.** `Actor.auth.make(authenticate)` and `Actor.auth.make({ authenticate })` read `authorization: Bearer`. A provider that names a cookie reads only that cookie unless it also sets `bearer: true`. The options type rejects `bearer: false` without a cookie, which would leave nothing to document.
- **Providers carry credentials, not a scheme and a flag.** `AuthProvider` has `credentials`, a list of `{ _tag: "Bearer", format? }` and `{ _tag: "Cookie", name }`, empty for `Actor.auth.none`. `Actor.serve` hands cookies to `authenticate` exactly when the list has a cookie, and applies `limits.credentialBytes` to the `cookie` header only then, as before.
- **One credential per scheme.** `Actor.serve` fails at startup when a provider's `credentials` has two entries documented as the same scheme (two cookies, or `Bearer` and `Jwt`), since the document could name only one of them. `Actor.auth.make` and `Actor.auth.jwt` can't produce such a list; only a hand-built `AuthProvider` can.
- **The document lists each credential as an alternative.** `components.securitySchemes` has `bearer` (`http`, `scheme: bearer`, plus `bearerFormat: JWT` for `Actor.auth.jwt`) and `cookie` (`apiKey`, `in: cookie`, `name`) for the credentials the provider has. Every authenticated operation's `security` is one requirement per credential, `[{ bearer: [] }, { cookie: [] }]` for a provider that reads both, so a client may send either. `durable.protocol` stays unauthenticated.

```ts
const sessions = Actor.auth.make({
  authenticate: (request) => lookupSession(request.cookies["__Host-sid"]),
  cookies: { name: "__Host-sid" },
})
// securitySchemes: { cookie: { type: "apiKey", in: "cookie", name: "__Host-sid" } }
```

## Alternatives

- **A free-form `security` descriptor on `Actor.auth.make`** (for example `security: [{ type: "apiKey", in: "header", name: "x-api-key" }]`). It would also cover header API keys, but it lets a provider document credentials the framework neither size-limits nor gates cookie access on. Header API keys can be added as another `credentials` variant when a user needs one.
- **Keep `cookies: true` and add a separate `cookieName`.** Two fields that must agree, and `cookies: true` without a name would still be documented wrongly.
- **Document a cookie provider as both bearer and cookie.** Wrong for the common cookie-only session provider, which is the case #122 reported.

## Consequences

- `cookies: true` no longer compiles. The package is still alpha ([ADR 0029](0029-licence-package-name-and-release-policy.md)), so there is no migration path; a provider changes to `cookies: { name }`, and adds `bearer: true` if it also reads `authorization`.
- A `401` still carries `www-authenticate: Bearer` for every provider. No registered HTTP authentication scheme describes a cookie, and RFC 9110 requires the header on a `401`.
- The chat example's snapshot doesn't change: its provider reads only `authorization`.

## Evidence

- `documents a cookie provider's cookie as an apiKey scheme and authenticates by it` in [`conformance/http.ts`](../../packages/durable-actors/src/testing/conformance/http.ts), on PGlite and Postgres: the cookie-only, cookie-or-bearer, and bearer-only documents; a cookie-only provider authenticating from the cookie and refusing a bearer token with `missing_credentials`; and a bearer provider never seeing cookies.
- [`serve/auth.test.ts`](../../packages/durable-actors/src/serve/auth.test.ts): the credentials each form of `Actor.auth.make` produces, and the cookie-name check.

## Revisit when

- A user needs a header API key or another credential location in the document.
- The AsyncAPI question (ADR 0027 Q10) is reopened: an AsyncAPI document would need the same schemes. WebSocket upgrades and SSE feed requests already go through the same authentication, so a cookie provider gets their cookies, and their operations carry the same `security` as other authenticated operations.
