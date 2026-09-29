import { Crypto, Effect, Option, Result, Schema } from "effect"
import { renderPage, Page, type PageModel } from "./pages.js"
import { ApiError, BillingLink, Dashboard, Organizations } from "./http.js"

interface Config {
  apiOrigin: string
  appOrigin?: string
  stylesheet: string
  fetch?: (input: URL, init?: RequestInit) => Promise<Response>
}

interface PageOptions extends Partial<Omit<PageModel, "path" | "csrf" | "theme">> {
  status?: number
  upstream?: Headers
}

interface FormAction {
  path: string
  payload: Record<string, string>
  page: Page
  redirect: Page
  notice?: string
}

interface FormActions {
  readonly [action: string]: FormAction | undefined
}

const isPage = Schema.is(Page)

const encoder = new TextEncoder()

const csrfMessage = encoder.encode("forma-csrf-verification")

const webCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise(() => crypto.subtle.digest(algorithm, Uint8Array.from(data))).pipe(
      Effect.map((value) => new Uint8Array(value)),
      Effect.orDie,
    ),
})

const secureEqual = Effect.fnUntraced(function* (expected: string, candidate: string) {
  const algorithm = {
    name: "HMAC",
    hash: "SHA-256",
  }

  const expectedKey = yield* Effect.tryPromise(() =>
    crypto.subtle.importKey("raw", encoder.encode(expected), algorithm, false, ["sign"]),
  )

  const signature = yield* Effect.tryPromise(() =>
    crypto.subtle.sign(algorithm, expectedKey, csrfMessage),
  )

  const candidateKey = yield* Effect.tryPromise(() =>
    crypto.subtle.importKey("raw", encoder.encode(candidate), algorithm, false, ["verify"]),
  )

  return yield* Effect.tryPromise(() =>
    crypto.subtle.verify(algorithm, candidateKey, signature, csrfMessage),
  )
})

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

const requestHeaders = [
  "accept",
  "content-type",
  "cookie",
  "authorization",
  "origin",
  "referer",
  "if-none-match",
]

const responseHeaders = [
  "content-type",
  "location",
  "cache-control",
  "vary",
  "retry-after",
  "www-authenticate",
  "etag",
  "content-disposition",
]

function cookies(request: Request) {
  const result = new Map<string, string>()

  for (const entry of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = entry.indexOf("=")

    if (separator >= 0) result.set(entry.slice(0, separator).trim(), entry.slice(separator + 1))
  }

  return result
}

function cookieHeaders(source: Headers, target: Headers) {
  for (const cookie of source.getSetCookie()) target.append("set-cookie", cookie)
}

/**
 * Assign the pathname separately: //host and encoded slashes never choose a
 * new origin.
 */
export function createHandler(config: Config) {
  const api = new URL(config.apiOrigin)

  if (
    !["http:", "https:"].includes(api.protocol) ||
    api.username !== "" ||
    api.password !== "" ||
    api.pathname !== "/" ||
    api.search !== "" ||
    api.hash !== ""
  )
    throw new Error("API_ORIGIN must be an HTTP(S) origin.")
  const send = config.fetch ?? fetch

  return function handle(request: Request): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(request.url)

        const origin =
          config.appOrigin !== undefined ? new URL(config.appOrigin).origin : url.origin

        const secure = origin.startsWith("https:") ? "; Secure" : ""
        const jar = cookies(request)
        const csrfCookie = jar.get("forma-csrf")

        const csrf =
          csrfCookie !== undefined && /^[a-f0-9]{64}$/.test(csrfCookie)
            ? csrfCookie
            : Array.from(yield* webCrypto.randomBytes(32), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join("")

        const theme = jar.get("forma-theme") === "dark" ? "dark" : "light"

        const baseHeaders = () =>
          new Headers({
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "same-origin",
            "content-security-policy":
              "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://polar.sh https://sandbox.polar.sh; base-uri 'none'; frame-ancestors 'none'",
          })

        const page = Effect.fnUntraced(function* (path: Page, options: PageOptions = {}) {
          const headers = baseHeaders()
          headers.set("content-type", "text/html; charset=utf-8")
          headers.append(
            "set-cookie",
            `forma-csrf=${csrf}; Path=/; HttpOnly; SameSite=Lax${secure}`,
          )

          if (options.upstream !== undefined) cookieHeaders(options.upstream, headers)
          const returnTo = url.pathname.startsWith("/forms/") ? path : url.pathname + url.search

          const html = yield* Effect.tryPromise(() =>
            renderPage({
              path,
              theme,
              csrf,
              returnTo,
              ...options,
            }),
          )

          return new Response(html, {
            status: options.status ?? 200,
            headers,
          })
        })

        const upstream = Effect.fnUntraced(function* (
          path: string,
          method: string,
          body?: BodyInit | null,
          json: boolean = false,
        ) {
          const headers = new Headers()

          for (const key of requestHeaders) {
            const value = request.headers.get(key)

            if (value !== null) headers.set(key, value)
          }

          if (headers.has("cookie"))
            headers.set(
              "cookie",
              headers
                .get("cookie")!
                .split(";")
                .filter((v) => !/^\s*forma-(theme|csrf)=/.test(v))
                .join(";"),
            )

          if (json) {
            headers.set("content-type", "application/json")
            headers.set("accept", "application/json")
            headers.set("origin", origin)
            headers.delete("if-none-match")
          }

          const target = new URL(api)
          const incoming = new URL(path, "http://internal.invalid")
          target.pathname = incoming.pathname
          target.search = incoming.search

          return yield* Effect.tryPromise(() =>
            send(target, {
              method,
              headers,
              body,
              redirect: "manual",
              signal: AbortSignal.timeout(8000),
            }),
          )
        })

        if (url.pathname === "/health")
          return Response.json({
            status: "ok",
            service: "web",
          })

        if (url.pathname === "/styles.css" && request.method === "GET")
          return new Response(config.stylesheet, {
            headers: {
              "content-type": "text/css; charset=utf-8",
              "cache-control": "public, max-age=0, must-revalidate",
            },
          })

        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
          if (!safeMethods.has(request.method) && request.headers.get("origin") !== origin)
            return new Response("Cross-origin request rejected.", {
              status: 403,
            })

          return yield* Effect.gen(function* () {
            const body = safeMethods.has(request.method)
              ? undefined
              : yield* Effect.tryPromise(() => request.arrayBuffer())

            const result = yield* upstream(url.pathname + url.search, request.method, body)
            const headers = baseHeaders()

            for (const key of responseHeaders) {
              const value = result.headers.get(key)

              if (value !== null) headers.set(key, value)
            }

            const location = headers.get("location")

            if (location !== null) {
              const target = new URL(location, api)

              if (target.origin === api.origin)
                headers.set("location", `${origin}${target.pathname}${target.search}${target.hash}`)
            }

            cookieHeaders(result.headers, headers)

            return new Response(result.body, {
              status: result.status,
              statusText: result.statusText,
              headers,
            })
          }).pipe(
            Effect.orElseSucceed(() =>
              Response.json(
                {
                  error: "API_UNAVAILABLE",
                  message: "The account service is unavailable. Please retry.",
                },
                {
                  status: 502,
                  headers: baseHeaders(),
                },
              ),
            ),
          )
        }

        if (url.pathname.startsWith("/forms/")) {
          if (request.method !== "POST")
            return new Response("Method not allowed", {
              status: 405,
              headers: {
                allow: "POST",
              },
            })

          if (request.headers.get("origin") !== origin)
            return new Response("Cross-origin form rejected.", {
              status: 403,
            })
          const parsedForm = yield* Effect.result(Effect.tryPromise(() => request.formData()))

          if (Result.isFailure(parsedForm))
            return new Response("Invalid form.", {
              status: 400,
            })
          const data = parsedForm.success
          const token = data.get("csrf")

          if (
            !Schema.is(Schema.String)(token) ||
            csrfCookie === undefined ||
            !/^[a-f0-9]{64}$/.test(token) ||
            !(yield* secureEqual(csrf, token))
          )
            return new Response("This form has expired. Reload the page and try again.", {
              status: 403,
            })

          const value = (key: string) => {
            const entry = data.get(key)

            return Schema.is(Schema.String)(entry) ? entry : ""
          }

          const action = url.pathname.slice("/forms/".length)

          if (action === "theme") {
            if (!["light", "dark"].includes(value("theme")))
              return new Response("Invalid theme.", {
                status: 400,
              })
            const headers = baseHeaders()
            const destination = URL.parse(value("returnTo"), origin)
            headers.set(
              "location",
              destination !== null && destination.origin === origin && isPage(destination.pathname)
                ? destination.pathname + destination.search
                : "/dashboard",
            )
            headers.append(
              "set-cookie",
              `forma-theme=${value("theme")}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
            )

            return new Response(null, {
              status: 303,
              headers,
            })
          }

          const actions: FormActions = {
            "sign-in": {
              path: "/auth/sign-in/email",
              payload: {
                email: value("email"),
                password: value("password"),
              },
              page: "/sign-in",
              redirect: "/dashboard",
            },
            "sign-up": {
              path: "/auth/sign-up/email",
              payload: {
                name: value("name"),
                email: value("email"),
                password: value("password"),
                callbackURL: `${origin}/dashboard`,
              },
              page: "/sign-up",
              redirect: "/verify-email",
              notice:
                "Your account was created. Check your email and verify your address before signing in.",
            },
            "forgot-password": {
              path: "/auth/request-password-reset",
              payload: {
                email: value("email"),
                redirectTo: `${origin}/reset-password`,
              },
              page: "/forgot-password",
              redirect: "/forgot-password",
              notice:
                "Request accepted. If this email belongs to an account, password reset instructions will be sent.",
            },
            "reset-password": {
              path: "/auth/reset-password",
              payload: {
                newPassword: value("newPassword"),
                token: value("token"),
              },
              page: "/reset-password",
              redirect: "/sign-in",
              notice: "Your password was reset. You can now sign in with your new password.",
            },
            "verify-email": {
              path: "/auth/send-verification-email",
              payload: {
                email: value("email"),
                callbackURL: `${origin}/dashboard`,
              },
              page: "/verify-email",
              redirect: "/verify-email",
              notice:
                "Request accepted. Check your inbox for a verification link if your account is eligible.",
            },
            "invite-member": {
              path: "/auth/organization/invite-member",
              payload: {
                email: value("email"),
                organizationId: value("organizationId"),
                role: "member",
              },
              page: "/settings",
              redirect: "/settings",
            },
            "switch-organization": {
              path: "/auth/organization/set-active",
              payload: {
                organizationId: value("organizationId"),
              },
              page: "/settings",
              redirect: "/dashboard",
            },
            "accept-invitation": {
              path: "/auth/organization/accept-invitation",
              payload: {
                invitationId: value("invitationId"),
              },
              page: "/accept-invitation",
              redirect: "/settings",
            },
            "sign-out": {
              path: "/auth/sign-out",
              payload: {},
              page: "/dashboard",
              redirect: "/sign-in",
            },
            organization: {
              path: "/api/organization",
              payload: {
                name: value("name"),
                slug: value("slug"),
              },
              page: "/settings",
              redirect: "/dashboard",
            },
            checkout: {
              path: "/api/billing/checkout",
              payload: {
                plan: "pro",
              },
              page: "/billing",
              redirect: "/billing",
            },
            portal: {
              path: "/api/billing/portal",
              payload: {},
              page: "/billing",
              redirect: "/billing",
            },
          }

          const selected = Object.hasOwn(actions, action) ? actions[action] : undefined

          if (selected === undefined)
            return new Response("Not found", {
              status: 404,
            })

          return yield* Effect.gen(function* () {
            const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              selected.payload,
            )

            const result = yield* upstream(selected.path, "POST", payload, true)

            if (!result.ok) {
              const error = Schema.decodeUnknownOption(ApiError)(
                yield* Effect.tryPromise(() => result.json().catch(() => null)),
              )

              return yield* page(selected.page, {
                error:
                  Option.isSome(error) &&
                  error.value.message !== undefined &&
                  error.value.message !== ""
                    ? error.value.message.slice(0, 500)
                    : `The service returned HTTP ${result.status}. Nothing has been confirmed.`,
                status: result.status >= 400 ? result.status : 502,
                upstream: result.headers,
                token: value("token"),
                invitationId: value("invitationId"),
              })
            }

            if (selected.notice !== undefined)
              return yield* page(selected.redirect, {
                notice: selected.notice,
                upstream: result.headers,
              })
            let location: string = selected.redirect

            if (action === "checkout" || action === "portal") {
              const payload = Schema.decodeUnknownOption(BillingLink)(
                yield* Effect.tryPromise(() => result.json()),
              )

              const target = Option.isSome(payload) ? URL.parse(payload.value.url) : null

              if (
                target === null ||
                target.protocol !== "https:" ||
                target.username !== "" ||
                target.password !== "" ||
                !["https://polar.sh", "https://sandbox.polar.sh"].includes(target.origin)
              )
                return yield* page("/billing", {
                  error: "The billing service did not return an approved secure checkout address.",
                  status: 502,
                  upstream: result.headers,
                })
              location = target.href
            }

            const headers = baseHeaders()
            headers.set("location", location)
            cookieHeaders(result.headers, headers)

            return new Response(null, {
              status: 303,
              headers,
            })
          }).pipe(
            Effect.catch(() =>
              page(selected.page, {
                error:
                  "The account service is unavailable. Your request has not been confirmed; please try again.",
                status: 502,
              }),
            ),
          )
        }

        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", {
            status: 405,
            headers: {
              allow: "GET, HEAD",
            },
          })

        if (url.pathname === "/")
          return new Response(null, {
            status: 303,
            headers: {
              location: "/dashboard",
            },
          })
        const path = url.pathname

        if (!isPage(path))
          return new Response("Page not found", {
            status: 404,
          })

        if (!["/dashboard", "/settings", "/billing"].includes(path)) {
          const options: PageOptions = {
            token: url.searchParams.get("token") ?? undefined,
            invitationId: url.searchParams.get("invitationId") ?? undefined,
          }

          if (url.searchParams.has("error"))
            options.error = "This link could not be verified. Request a fresh email and try again."

          return yield* page(path, options)
        }

        return yield* Effect.gen(function* () {
          const result = yield* upstream("/api/dashboard", "GET")

          if (result.status === 401) {
            const headers = baseHeaders()
            headers.set("location", "/sign-in")
            cookieHeaders(result.headers, headers)

            return new Response(null, {
              status: 303,
              headers,
            })
          }

          if (!result.ok)
            return yield* page(path, {
              error: `The account service returned HTTP ${result.status}. Your workspace data is not available.`,
              status: result.status >= 400 ? result.status : 502,
              upstream: result.headers,
            })

          const decoded = Schema.decodeUnknownOption(Dashboard)(
            yield* Effect.tryPromise(() => result.json()),
          )

          if (Option.isNone(decoded))
            return yield* page(path, {
              error:
                "The account service returned an unexpected response. No workspace data has been displayed.",
              status: 502,
              upstream: result.headers,
            })
          const headers = new Headers(result.headers)

          const options: PageOptions = {
            data: decoded.value,
            upstream: headers,
          }

          if (path === "/settings") {
            const organizationsResult = yield* Effect.result(
              Effect.gen(function* () {
                const organizations = yield* upstream("/auth/organization/list", "GET")

                if (!organizations.ok) return yield* Effect.fail("Organization list unavailable")

                const decodedOrganizations = Schema.decodeUnknownOption(Organizations)(
                  yield* Effect.tryPromise(() => organizations.json()),
                )

                return { decodedOrganizations, headers: organizations.headers }
              }),
            )

            if (Result.isFailure(organizationsResult))
              options.organizationsError =
                "We couldn’t load your other organizations. Switching is temporarily unavailable."
            else {
              cookieHeaders(organizationsResult.success.headers, headers)

              if (Option.isSome(organizationsResult.success.decodedOrganizations))
                options.organizations = organizationsResult.success.decodedOrganizations.value
              else
                options.organizationsError =
                  "The account service returned an invalid organization list. Switching is temporarily unavailable."
            }
          }

          return yield* page(path, options)
        }).pipe(
          Effect.catch(() =>
            page(path, {
              error: "We couldn’t reach the account service. Check back shortly or try again.",
              status: 502,
            }),
          ),
        )
      }),
    )
  }
}
