import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { createHandler } from "../src/server.js"
import { dashboard } from "./fixtures.js"

const origin = "https://app.example.test"

const token = "a".repeat(64)

const config = {
  apiOrigin: "http://api.internal:3001",
  appOrigin: origin,
  stylesheet: "body{}",
}

function post(action: string, values: Record<string, string> = {}, headers: HeadersInit = {}) {
  const combined = new Headers({
    origin,
    cookie: `forma-csrf=${token}; better-auth.session_token=test`,
  })

  new Headers(headers).forEach((value, key) => combined.set(key, value))

  return new Request(`${origin}/forms/${action}`, {
    method: "POST",
    headers: combined,
    body: new URLSearchParams({
      csrf: token,
      ...values,
    }),
  })
}

describe("SSR web boundary", () => {
  it("serves static auth HTML and health without contacting the API", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const send = vi.fn()

        const handle = createHandler({
          ...config,
          fetch: send,
        })

        const response = yield* Effect.tryPromise(() => handle(new Request(`${origin}/sign-in`)))
        expect(response.status).toBe(200)
        expect(response.headers.getSetCookie()[0]).toMatch(/HttpOnly; SameSite=Lax; Secure/)
        const html = yield* Effect.tryPromise(() => response.text())
        expect(html).toContain('action="/forms/sign-in"')
        expect(html).not.toMatch(/<script|data-foldkit|hydrate/i)
        const health = yield* Effect.tryPromise(() => handle(new Request(`${origin}/health`)))
        expect(yield* Effect.tryPromise(() => health.json())).toEqual({
          status: "ok",
          service: "web",
        })
        expect(send).not.toHaveBeenCalled()
      }),
    ))
  it("returns an honest 502, never fake metrics, when API is unreachable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const handle = createHandler({
          ...config,
          fetch: vi.fn().mockRejectedValue(new Error("offline")),
        })

        const response = yield* Effect.tryPromise(() => handle(new Request(`${origin}/dashboard`)))
        expect(response.status).toBe(502)
        const html = yield* Effect.tryPromise(() => response.text())
        expect(html).toContain("Connection unavailable")
        expect(html).toContain('role="alert"')
        expect(html).not.toContain("Current plan")
        expect(html).not.toContain('action="/forms/checkout"')
      }),
    ))
  it("rejects malformed dashboard responses instead of partially rendering them", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const handle = createHandler({
          ...config,
          fetch: vi.fn().mockResolvedValue(
            Response.json({
              ...dashboard,
              members: [null],
            }),
          ),
        })

        const response = yield* Effect.tryPromise(() => handle(new Request(`${origin}/dashboard`)))
        expect(response.status).toBe(502)
        expect(yield* Effect.tryPromise(() => response.text())).toContain("unexpected response")
      }),
    ))
  it("redirects an expired session to sign in and retains refreshed/deleted cookies", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const headers = new Headers()
        headers.append("set-cookie", "session=; Max-Age=0; Path=/")

        const handle = createHandler({
          ...config,
          fetch: vi.fn().mockResolvedValue(
            new Response(null, {
              status: 401,
              headers,
            }),
          ),
        })

        const response = yield* Effect.tryPromise(() => handle(new Request(`${origin}/dashboard`)))
        expect(response.status).toBe(303)
        expect(response.headers.get("location")).toBe("/sign-in")
        expect(response.headers.getSetCookie()).toEqual(["session=; Max-Age=0; Path=/"])
      }),
    ))
  it("preserves upstream status, raw body, redirects and separate Set-Cookie while filtering trust headers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const headers = new Headers({
          location: "http://api.internal:3001/auth/callback?code=x",
          "content-type": "application/json",
          "retry-after": "19",
        })

        headers.append("set-cookie", "one=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT")
        headers.append("set-cookie", "two=2; Path=/; HttpOnly")

        const send = vi.fn().mockResolvedValue(
          new Response('{"unchanged":true}', {
            status: 307,
            headers,
          }),
        )

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(
            new Request(`${origin}/auth/example?x=1`, {
              headers: {
                cookie: `forma-theme=dark; better-auth.session_token=abc`,
                "x-forwarded-host": "evil.test",
                "x-forwarded-for": "1.2.3.4",
                authorization: "Bearer test",
              },
            }),
          ),
        )

        expect(response.status).toBe(307)
        expect(yield* Effect.tryPromise(() => response.text())).toBe('{"unchanged":true}')
        expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())
        expect(response.headers.get("location")).toBe(`${origin}/auth/callback?code=x`)
        expect(response.headers.get("retry-after")).toBe("19")
        const [target, init] = send.mock.calls[0]!
        expect(String(target)).toBe("http://api.internal:3001/auth/example?x=1")
        expect(init.redirect).toBe("manual")
        expect(init.headers.get("cookie")).toBe("better-auth.session_token=abc")
        expect(init.headers.get("x-forwarded-host")).toBeNull()
        expect(init.headers.get("x-forwarded-for")).toBeNull()
      }),
    ))
  it.each(["https://evil.test", "null", ""])(
    "rejects mutating proxy requests from origin %s",
    (badOrigin) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const send = vi.fn()

          const response = yield* Effect.tryPromise(() =>
            createHandler({
              ...config,
              fetch: send,
            })(
              new Request(`${origin}/api/organization`, {
                method: "POST",
                headers: {
                  origin: badOrigin,
                  "x-forwarded-host": "app.example.test",
                },
                body: "{}",
              }),
            ),
          )

          expect(response.status).toBe(403)
          expect(send).not.toHaveBeenCalled()
        }),
      ),
  )
  it.each(["b".repeat(64), "é".repeat(64), ""])("rejects invalid CSRF token %s", (badToken) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const send = vi.fn()
        expect(
          (yield* Effect.tryPromise(() =>
            createHandler({
              ...config,
              fetch: send,
            })(
              post("sign-in", {
                csrf: badToken,
              }),
            ),
          )).status,
        ).toBe(403)
        expect(send).not.toHaveBeenCalled()
      }),
    ),
  )
  it("changes theme with a secure cookie and prevents return URL injection", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() =>
          createHandler(config)(
            post("theme", {
              theme: "dark",
              returnTo: "https://evil.test",
            }),
          ),
        )

        expect(response.status).toBe(303)
        expect(response.headers.get("location")).toBe("/dashboard")
        expect(response.headers.getSetCookie()).toEqual([
          "forma-theme=dark; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure",
        ])
      }),
    ))
  it("forwards form JSON only after CSRF and preserves auth response cookies", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const headers = new Headers()
        headers.append("set-cookie", "better-auth.session_token=ok; Path=/; HttpOnly")

        const send = vi.fn().mockResolvedValue(
          Response.json(
            {
              token: "ok",
            },
            {
              headers,
            },
          ),
        )

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(
            post("sign-in", {
              email: "a@example.test",
              password: "not-a-real-password",
            }),
          ),
        )

        expect(response.status).toBe(303)
        expect(response.headers.get("location")).toBe("/dashboard")
        expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())

        const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          send.mock.calls[0]![1].body,
        )

        expect(payload).toEqual({
          email: "a@example.test",
          password: "not-a-real-password",
        })
        expect(send.mock.calls[0]![1].headers.get("origin")).toBe(origin)
      }),
    ))
  it("preserves reset and invitation tokens when switching themes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const returnTo = "/reset-password?token=sample%2Btoken"
        const handle = createHandler(config)
        const get = yield* Effect.tryPromise(() => handle(new Request(`${origin}${returnTo}`)))
        expect(yield* Effect.tryPromise(() => get.text())).toContain(
          'value="/reset-password?token=sample%2Btoken"',
        )

        const response = yield* Effect.tryPromise(() =>
          handle(
            post("theme", {
              theme: "dark",
              returnTo,
            }),
          ),
        )

        expect(response.headers.get("location")).toBe(returnTo)
      }),
    ))
  it("signup without a session shows verification instructions, not authenticated success", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const send = vi.fn().mockResolvedValue(
          Response.json({
            token: null,
            user: {
              name: "Alex",
            },
          }),
        )

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(
            post("sign-up", {
              name: "Alex",
              email: "a@example.test",
              password: "not-a-real-password",
            }),
          ),
        )

        expect(response.status).toBe(200)
        expect(response.headers.get("location")).toBeNull()
        expect(yield* Effect.tryPromise(() => response.text())).toContain(
          "verify your address before signing in",
        )
      }),
    ))
  it("does not claim email was sent when reset service fails", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const send = vi.fn().mockResolvedValue(
          Response.json(
            {
              message: "Email delivery unavailable",
            },
            {
              status: 503,
            },
          ),
        )

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(
            post("forgot-password", {
              email: "a@example.test",
              redirectTo: "https://evil.test",
            }),
          ),
        )

        const html = yield* Effect.tryPromise(() => response.text())
        expect(response.status).toBe(503)
        expect(html).toContain("Email delivery unavailable")
        expect(html).not.toContain("Request accepted.")

        const payload = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ redirectTo: Schema.String })),
        )(send.mock.calls[0]![1].body)

        expect(payload.redirectTo).toBe(`${origin}/reset-password`)
      }),
    ))
  it.each(["https://polar.sh/checkout/test", "https://sandbox.polar.sh/team/portal?token=test"])(
    "allows verified provider redirect %s",
    (url) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise(() =>
            createHandler({
              ...config,
              fetch: vi.fn().mockResolvedValue(
                Response.json({
                  url,
                }),
              ),
            })(post("checkout")),
          )

          expect(response.status).toBe(303)
          expect(response.headers.get("location")).toBe(url)
        }),
      ),
  )
  it.each([
    "https://polar.sh.evil.test/checkout",
    "https://polar.sh:444/checkout",
    "http://polar.sh/checkout",
    "https://evil@polar.sh/checkout",
    "https://checkout.stripe.com/session",
  ])("rejects unapproved billing redirect %s", (url) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: vi.fn().mockResolvedValue(
              Response.json({
                url,
              }),
            ),
          })(post("portal")),
        )

        expect(response.status).toBe(502)
        expect(response.headers.get("location")).toBeNull()
      }),
    ),
  )
  it("renders switcher from API organizations and keeps multiple cookie updates", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const send = vi
          .fn()
          .mockResolvedValueOnce(
            Response.json(dashboard, {
              headers: {
                "set-cookie": "one=1",
              },
            }),
          )
          .mockResolvedValueOnce(
            Response.json(
              [
                {
                  id: "org-1",
                  name: "Northstar Studio",
                  slug: "northstar",
                },
                {
                  id: "org-2",
                  name: "Other team",
                  slug: "other",
                },
              ],
              {
                headers: {
                  "set-cookie": "two=2",
                },
              },
            ),
          )

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(new Request(`${origin}/settings`)),
        )

        const html = yield* Effect.tryPromise(() => response.text())
        expect(html).toContain("Other team")
        expect(html).toContain('action="/forms/invite-member"')
        expect(response.headers.getSetCookie()).toContain("two=2")
        expect(response.headers.getSetCookie()).toContain("one=1")
      }),
    ))
  it("does not resolve inherited dictionary names as form actions", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const send = vi.fn()

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(post("constructor")),
        )

        expect(response.status).toBe(404)
        expect(send).not.toHaveBeenCalled()
      }),
    ))
  it("accepts HeadersInit arrays without spreading numeric keys", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() =>
          createHandler(config)(
            post(
              "theme",
              {
                theme: "dark",
              },
              [["origin", "https://evil.test"]],
            ),
          ),
        )

        expect(response.status).toBe(403)
      }),
    ))
  it("rejects a file in the CSRF field rather than stringifying it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const form = new FormData()
        form.set("csrf", new Blob([token]), "token.txt")
        const send = vi.fn()

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(
            new Request(`${origin}/forms/sign-in`, {
              method: "POST",
              headers: {
                origin,
                cookie: `forma-csrf=${token}`,
              },
              body: form,
            }),
          ),
        )

        expect(response.status).toBe(403)
        expect(send).not.toHaveBeenCalled()
      }),
    ))
  it("reports malformed billing JSON as an invalid URL and preserves cookies", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const send = vi.fn().mockResolvedValue(
          Response.json(
            {
              url: 42,
            },
            {
              headers: {
                "set-cookie": "session=updated",
              },
            },
          ),
        )

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(post("portal")),
        )

        expect(response.status).toBe(502)
        expect(yield* Effect.tryPromise(() => response.text())).toContain(
          "approved secure checkout address",
        )
        expect(response.headers.getSetCookie()).toContain("session=updated")
      }),
    ))
  it("keeps valid workspace data visible when the organization list is malformed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const send = vi
          .fn()
          .mockResolvedValueOnce(Response.json(dashboard))
          .mockResolvedValueOnce(
            Response.json([
              {
                id: 42,
              },
            ]),
          )

        const response = yield* Effect.tryPromise(() =>
          createHandler({
            ...config,
            fetch: send,
          })(new Request(`${origin}/settings`)),
        )

        const html = yield* Effect.tryPromise(() => response.text())
        expect(response.status).toBe(200)
        expect(html).toContain("Northstar Studio")
        expect(html).toContain("invalid organization list")
        expect(html).not.toContain('action="/forms/switch-organization"')
      }),
    ))
})
