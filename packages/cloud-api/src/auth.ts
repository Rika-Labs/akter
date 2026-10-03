import { Context, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"

import { Forbidden, Unauthorized } from "./errors.ts"
import { ApiKeyId, OrganizationId, UserId } from "./primitives.ts"

/** The cookie that carries the Better Auth session token over plain HTTP. */
export const sessionCookieName = "better-auth.session_token"

/** The same cookie as Better Auth names it when served over HTTPS. */
export const secureSessionCookieName = "__Secure-better-auth.session_token"

/** The request header that carries an organization API key. */
export const apiKeyHeaderName = "x-api-key"

/** A signed-in person, resolved from the session cookie. */
export const SessionIdentity = Schema.TaggedStruct("session", {
  userId: UserId,
  sessionId: Schema.String,
  activeOrganizationId: Schema.NullOr(OrganizationId),
})

/** An organization-owned key; the key, never a person, is the actor. */
export const ApiKeyIdentity = Schema.TaggedStruct("api-key", {
  keyId: ApiKeyId,
  organizationId: OrganizationId,
  permission: Schema.Literals(["read", "write", "admin"]),
})

export const Identity = Schema.Union([SessionIdentity, ApiKeyIdentity])
export type Identity = typeof Identity.Type

/** The verified caller of the current request, provided by `Authentication`. */
export class CurrentIdentity extends Context.Service<CurrentIdentity, Identity>()(
  "@akter/cloud-api/auth/CurrentIdentity",
) {}

/**
 * Resolves who is calling. The server implements one handler per security
 * scheme and fails `Unauthorized` when a scheme's credential is missing or
 * invalid; the first scheme that succeeds provides `CurrentIdentity`. A cookie
 * browser client sends credentials automatically, so no client implementation
 * is required.
 *
 * @effect-expect-leaking HttpServerRequest | ParsedSearchParams | RouteContext
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentIdentity; requires: never }
>()("@akter/cloud-api/Authentication", {
  security: {
    session: HttpApiSecurity.apiKey({ key: sessionCookieName, in: "cookie" }),
    secureSession: HttpApiSecurity.apiKey({ key: secureSessionCookieName, in: "cookie" }),
    apiKey: HttpApiSecurity.apiKey({ key: apiKeyHeaderName, in: "header" }),
  },
  error: [Unauthorized, Forbidden],
}) {}
