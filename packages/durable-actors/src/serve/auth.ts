import { Data, type DateTime, Effect, Option, Predicate, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import type { ActorUnavailable } from "../errors/actor.ts"
import { Unauthorized } from "../errors/actor.ts"
import { Anonymous, User } from "../identity/caller.ts"

/** What a provider may read: headers, cookies when it asks for them, and a frame credential. Never the body. */
export interface AuthRequest {
  readonly headers: Headers.Headers
  /** Empty unless the provider accepts a cookie credential. */
  readonly cookies: Readonly<Record<string, string>>
  /**
   * A credential carried outside the headers, such as a WebSocket `hello`
   * frame's `authorization`; it has the header's form, `Bearer <token>`.
   */
  readonly credential?: string
}

export interface Authenticated {
  readonly caller: typeof User.Type | typeof Anonymous.Type
  readonly tenant: string
  /** The credential's own expiry, which caps live sessions. */
  readonly expiresAt?: DateTime.Utc
}

/** A credential a provider reads, documented as one OpenAPI security scheme. */
export type Credential = Data.TaggedEnum<{
  /** `authorization: Bearer <token>`. */
  Bearer: {}
  /** `authorization: Bearer <jwt>`, documented with `bearerFormat: JWT`. */
  Jwt: {}
  /** The named cookie. */
  Cookie: { readonly name: string }
}>

export const Credential = Data.taggedEnum<Credential>()

/** One way to authenticate every request an `Actor.serve` layer answers. */
export interface AuthProvider<R = never> {
  /**
   * The credentials the provider accepts, any one of which authenticates a
   * request; empty when it reads none. A `Cookie` entry is also what lets
   * `authenticate` see the request's cookies.
   */
  readonly credentials: ReadonlyArray<Credential>
  readonly authenticate: (
    request: AuthRequest,
  ) => Effect.Effect<Authenticated, Unauthorized | ActorUnavailable, R>
}

export const unauthorized = (code: Unauthorized["code"]) => Unauthorized.make({ code })

/**
 * The token of an `authorization: Bearer` header, or of the request's frame
 * credential, which carries the same `Bearer <token>` value.
 */
export const bearerToken = (request: AuthRequest) => {
  const header =
    request.credential === undefined
      ? Headers.get(request.headers, "authorization")
      : Option.some(request.credential)

  if (Option.isNone(header)) return Effect.fail(unauthorized("missing_credentials"))

  const match = /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(header.value)

  return match === null
    ? Effect.fail(unauthorized("invalid_credentials"))
    : Effect.succeed(match[1]!)
}

/** Every request is `Anonymous` in the `"default"` tenant; any credential it carries is ignored. */
export const none: AuthProvider = {
  credentials: [],
  authenticate: () => Effect.succeed({ caller: Anonymous.make({}), tenant: "default" }),
}

export type Authenticate<R> = (
  request: AuthRequest,
) => Effect.Effect<Authenticated, Unauthorized, R>

/**
 * Options of a custom provider. It reads `authorization: Bearer` unless it
 * names a cookie; one that reads both sets `bearer: true` as well.
 */
export type MakeOptions<R> =
  | {
      readonly authenticate: Authenticate<R>
      readonly cookies?: undefined
      readonly bearer?: true
    }
  | {
      readonly authenticate: Authenticate<R>
      /** The cookie that carries the credential; the provider receives every request cookie. */
      readonly cookies: { readonly name: string }
      readonly bearer?: boolean
    }

// RFC 6265's cookie-name: an RFC 9110 token.
const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** A custom provider: an `authenticate` function that reads a bearer token, or options naming a cookie. */
export const make = <R = never>(provider: Authenticate<R> | MakeOptions<R>): AuthProvider<R> => {
  if (Predicate.isFunction(provider))
    return { credentials: [Credential.Bearer()], authenticate: provider }

  if (provider.cookies === undefined)
    return { credentials: [Credential.Bearer()], authenticate: provider.authenticate }

  if (!cookieName.test(provider.cookies.name))
    throw new Error(
      `Actor.auth.make: ${JSON.stringify(provider.cookies.name)} is not a cookie name`,
    )

  const cookie = Credential.Cookie({ name: provider.cookies.name })

  return {
    credentials: provider.bearer === true ? [Credential.Bearer(), cookie] : [cookie],
    authenticate: provider.authenticate,
  }
}

/** Whether the provider accepts a cookie credential, and so receives request cookies. */
export const readsCookies = (provider: AuthProvider<unknown>) =>
  provider.credentials.some(Credential.$is("Cookie"))

const Tenant = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/))

const isTenant = Schema.is(Tenant)

const utf8 = new TextEncoder()

/** Maximum UTF-8 bytes of a `User.subject`. */
export const SUBJECT_BYTES = 512

/** Maximum UTF-8 bytes of the JSON-encoded caller. */
export const CALLER_BYTES = 1024

export const withinLimits = (authenticated: Authenticated) => {
  if (!isTenant(authenticated.tenant)) return false

  if (!Schema.is(User)(authenticated.caller)) return true

  const subject = utf8.encode(authenticated.caller.subject).byteLength

  return (
    subject >= 1 &&
    subject <= SUBJECT_BYTES &&
    utf8.encode(JSON.stringify(authenticated.caller)).byteLength <= CALLER_BYTES
  )
}
