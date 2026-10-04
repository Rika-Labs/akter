import { Effect, Option, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConsoleError } from "../api/client.ts"
import { AppRoute } from "../navigation/routes.ts"
import { slugify } from "./model.ts"
import { accessFor, guardRoute, makeAuth, makeAuthClient, type SessionUser } from "./session.ts"

const person: SessionUser = { id: "u_1", name: "Ada", email: "ada@acme.dev", emailVerified: true }
const unverified: SessionUser = { ...person, emailVerified: false }

const signedOut = Option.none<SessionUser>()
const signedIn = Option.some(person)

interface Seen {
  readonly method: string
  readonly url: string
  readonly body: Schema.Json | undefined
}

const origin = "https://console.test"

const parseBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const backend = (answer: (url: URL) => Response) => {
  const seen: Array<Seen> = []
  const fetch = (input: Request | string | URL, init?: RequestInit): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const request = new Request(input, init)
        const text = yield* Effect.promise(() => request.text())
        seen.push({
          method: request.method,
          url: request.url,
          body: text === "" ? undefined : yield* parseBody(text),
        })
        return answer(new URL(request.url))
      }),
    )
  return {
    seen,
    auth: makeAuth({ client: () => makeAuthClient({ origin, fetch }), origin: () => origin }),
  }
}

const json = (body: Schema.Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const path = (seen: Seen | undefined) => new URL(seen?.url ?? origin).pathname

const run = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program)

const rememberReturn = (stored: string) => {
  const items = new Map<string, string>([["console-auth-return", stored]])
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  })
  vi.stubGlobal("location", { origin, pathname: "/sign-in", search: "" })
  return items
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("session access", () => {
  it("sends a signed-out visitor from every protected page to sign in", () => {
    const protectedRoutes = [
      AppRoute.Overview(),
      AppRoute.Actors(),
      AppRoute.SettingsBilling(),
      AppRoute.Onboarding({ step: "project" }),
      AppRoute.AcceptInvitation({ invitation: "inv_1" }),
      AppRoute.Device({ user_code: "WDJBMJHT" }),
    ]
    expect(protectedRoutes.map((route) => accessFor({ route, session: signedOut }))).toEqual(
      protectedRoutes.map(() => "sign-in"),
    )
    expect(protectedRoutes.map((route) => accessFor({ route, session: signedIn }))).toEqual(
      protectedRoutes.map(() => "allow"),
    )
  })

  it("keeps a signed-in person off the sign-in, sign-up and forgot-password screens", () => {
    const guestRoutes = [AppRoute.SignIn(), AppRoute.SignUp(), AppRoute.ForgotPassword()]
    expect(guestRoutes.map((route) => accessFor({ route, session: signedIn }))).toEqual(
      guestRoutes.map(() => "overview"),
    )
    expect(guestRoutes.map((route) => accessFor({ route, session: signedOut }))).toEqual(
      guestRoutes.map(() => "allow"),
    )
  })

  it("lets an unverified person reach the verify screen but not a verified one, and anyone reset a password", () => {
    expect(accessFor({ route: AppRoute.VerifyEmail(), session: signedOut })).toBe("allow")
    expect(accessFor({ route: AppRoute.VerifyEmail(), session: Option.some(unverified) })).toBe(
      "allow",
    )
    expect(accessFor({ route: AppRoute.VerifyEmail(), session: signedIn })).toBe("overview")
    expect(accessFor({ route: AppRoute.ResetPassword(), session: signedIn })).toBe("allow")
    expect(accessFor({ route: AppRoute.ResetPassword(), session: signedOut })).toBe("allow")
  })

  it("treats an unreadable session as signed out: protected routes redirect, sign-in still shows", () => {
    const unreadable = Effect.fail(ConsoleError.make({ kind: "Unavailable", message: "down" }))
    return run(
      Effect.gen(function* () {
        const redirected = yield* Effect.flip(
          guardRoute({ route: AppRoute.Overview(), read: unreadable }),
        )
        expect(redirected.kind).toBe("Unauthorized")
        const shown = yield* Effect.exit(guardRoute({ route: AppRoute.SignIn(), read: unreadable }))
        expect(shown._tag).toBe("Success")
      }),
    )
  })

  it("opens sign-in for a signed-in visitor only when the API just refused the session", () =>
    run(
      Effect.gen(function* () {
        const read = Effect.succeed(signedIn)
        const looped = yield* Effect.flip(guardRoute({ route: AppRoute.SignIn(), read }))
        expect(looped.kind).toBe("SignedIn")
        const allowed = yield* Effect.exit(
          guardRoute({ route: AppRoute.SignIn(), read, allowSignIn: true }),
        )
        expect(allowed._tag).toBe("Success")
        const signUp = yield* Effect.flip(
          guardRoute({ route: AppRoute.SignUp(), read, allowSignIn: true }),
        )
        expect(signUp.kind).toBe("SignedIn")
        const protectedRoute = yield* Effect.flip(
          guardRoute({
            route: AppRoute.Overview(),
            read: Effect.succeed(signedOut),
            allowSignIn: true,
          }),
        )
        expect(protectedRoute.kind).toBe("Unauthorized")
      }),
    ))

  it("names the redirect a signed-in visitor on an auth screen gets", () =>
    run(
      Effect.gen(function* () {
        const result = yield* Effect.flip(
          guardRoute({ route: AppRoute.SignUp(), read: Effect.succeed(signedIn) }),
        )
        expect(result.kind).toBe("SignedIn")
      }),
    ))
})

describe("Better Auth wire contract", () => {
  it("rejects a 200 HTML answer from a host that serves its app for /auth", () => {
    const api = backend(
      () =>
        new Response("<!doctype html><title>Akter</title>", {
          headers: { "content-type": "text/html" },
        }),
    )
    return run(
      Effect.gen(function* () {
        const session = yield* Effect.flip(api.auth.session)
        expect(session.kind).toBe("Unavailable")
        const signIn = yield* Effect.flip(
          api.auth.signInEmail({ email: "ada@acme.dev", password: "correct-password" }),
        )
        expect(signIn.kind).toBe("Unavailable")
      }),
    )
  })

  it("reads no session as signed out and a session as its person", () => {
    const none = backend(() => json(null))
    const some = backend(() =>
      json({
        user: { id: "u_1", name: "Ada", email: "ada@acme.dev", emailVerified: true },
        session: { id: "s_1", token: "t", userId: "u_1" },
      }),
    )
    return run(
      Effect.gen(function* () {
        expect(yield* none.auth.session).toEqual(Option.none())
        expect(none.seen[0]?.method).toBe("GET")
        expect(path(none.seen[0])).toBe("/auth/get-session")
        expect(yield* some.auth.session).toEqual(Option.some(person))
      }),
    )
  })

  it("posts sign-in credentials under /auth and reads a wrong password as a readable error", () => {
    const api = backend(() =>
      json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, 401),
    )
    return run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          api.auth.signInEmail({ email: "ada@acme.dev", password: "wrong-password" }),
        )
        expect(error.kind).toBe("INVALID_EMAIL_OR_PASSWORD")
        expect(error.message).toBe("That email and password don’t match an account.")
        expect(api.seen).toHaveLength(1)
        expect(api.seen[0]?.method).toBe("POST")
        expect(api.seen[0]?.body).toEqual({ email: "ada@acme.dev", password: "wrong-password" })
        expect(path(api.seen[0])).toBe("/auth/sign-in/email")
      }),
    )
  })

  it("keeps an unverified address distinguishable from a wrong password", () => {
    const api = backend(() =>
      json({ code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }, 403),
    )
    return run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          api.auth.signInEmail({ email: "ada@acme.dev", password: "correct-password" }),
        )
        expect(error.kind).toBe("EMAIL_NOT_VERIFIED")
      }),
    )
  })

  it("registers an account whose verification link returns to the console", () => {
    const api = backend(() =>
      json({
        token: null,
        user: { id: "u_1", name: "Ada", email: "ada@acme.dev", emailVerified: false },
      }),
    )
    return run(
      Effect.gen(function* () {
        const created = yield* api.auth.signUpEmail({
          name: "Ada",
          email: "ada@acme.dev",
          password: "correct horse battery",
        })
        expect(created.user.emailVerified).toBe(false)
        expect(path(api.seen[0])).toBe("/auth/sign-up/email")
        expect(api.seen[0]?.body).toEqual({
          name: "Ada",
          email: "ada@acme.dev",
          password: "correct horse battery",
          callbackURL: "https://console.test/onboarding",
        })
      }),
    )
  })

  it("asks for the provider's authorization page without following it", () => {
    const api = backend(() =>
      json({ url: "https://github.com/login/oauth/authorize?x=1", redirect: false }),
    )
    return run(
      Effect.gen(function* () {
        const url = yield* api.auth.signInSocial("github")
        expect(url).toBe("https://github.com/login/oauth/authorize?x=1")
        expect(path(api.seen[0])).toBe("/auth/sign-in/social")
        expect(api.seen[0]?.body).toMatchObject({
          provider: "github",
          disableRedirect: true,
          callbackURL: "https://console.test/",
          newUserCallbackURL: "https://console.test/onboarding",
          errorCallbackURL: "https://console.test/sign-in",
        })
      }),
    )
  })

  it("sends verification, reset request, reset and sign-out to their Better Auth routes", () => {
    const api = backend((url) =>
      url.pathname === "/auth/sign-out" ? json({ success: true }) : json({ status: true }),
    )
    return run(
      Effect.gen(function* () {
        yield* api.auth.sendVerificationEmail("ada@acme.dev")
        yield* api.auth.requestPasswordReset("ada@acme.dev")
        yield* api.auth.resetPassword({ newPassword: "a brand new passphrase", token: "tok_1" })
        yield* api.auth.signOut
        expect(api.seen.map((request) => [request.method, path(request)])).toEqual([
          ["POST", "/auth/send-verification-email"],
          ["POST", "/auth/request-password-reset"],
          ["POST", "/auth/reset-password"],
          ["POST", "/auth/sign-out"],
        ])
        expect(api.seen[0]?.body).toEqual({
          email: "ada@acme.dev",
          callbackURL: "https://console.test/onboarding",
        })
        expect(api.seen[1]?.body).toEqual({
          email: "ada@acme.dev",
          redirectTo: "https://console.test/reset-password",
        })
        expect(api.seen[2]?.body).toEqual({
          newPassword: "a brand new passphrase",
          token: "tok_1",
        })
      }),
    )
  })

  it("reports an unreachable service as a readable error instead of a defect", () => {
    const down = makeAuth({
      client: () =>
        makeAuthClient({ origin, fetch: () => Promise.reject(new TypeError("network")) }),
      origin: () => origin,
    })
    return run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(down.signInEmail({ email: "ada@acme.dev", password: "x" }))
        expect(error.kind).toBe("Unavailable")
      }),
    )
  })
})

describe("device authorization wire contract", () => {
  it("looks a code up with GET /auth/device and reads the status and client it answers", () => {
    const api = backend(() =>
      json({ user_code: "WDJBMJHT", status: "pending", client_id: "akter-cli" }),
    )
    return run(
      Effect.gen(function* () {
        expect(yield* api.auth.lookUpDevice("WDJBMJHT")).toEqual({
          status: "pending",
          client_id: "akter-cli",
        })
        expect(api.seen[0]?.method).toBe("GET")
        expect(path(api.seen[0])).toBe("/auth/device")
        expect(new URL(api.seen[0]?.url ?? origin).searchParams.get("user_code")).toBe("WDJBMJHT")
      }),
    )
  })

  it("approves and denies with the code in the body of POST /auth/device/approve and /deny", () => {
    const api = backend(() => json({ success: true }))
    return run(
      Effect.gen(function* () {
        yield* api.auth.approveDevice("WDJBMJHT")
        yield* api.auth.denyDevice("KPLQ7RST")
        expect(api.seen.map((seen) => [seen.method, path(seen), seen.body])).toEqual([
          ["POST", "/auth/device/approve", { userCode: "WDJBMJHT" }],
          ["POST", "/auth/device/deny", { userCode: "KPLQ7RST" }],
        ])
      }),
    )
  })

  it("keeps a refusal's status and OAuth error, and reads a lost or unreadable answer as status 0", () => {
    const expired = backend(() =>
      json({ error: "expired_token", error_description: "User code has expired" }, 400),
    )
    const html = backend(
      () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    )
    const lost = makeAuth({
      client: () =>
        makeAuthClient({ origin, fetch: () => Promise.reject(new TypeError("offline")) }),
      origin: () => origin,
    })
    return run(
      Effect.gen(function* () {
        expect(yield* Effect.flip(expired.auth.lookUpDevice("WDJBMJHT"))).toEqual({
          status: 400,
          error: "expired_token",
        })
        expect(yield* Effect.flip(html.auth.approveDevice("WDJBMJHT"))).toEqual({ status: 0 })
        expect(yield* Effect.flip(lost.lookUpDevice("WDJBMJHT"))).toEqual({ status: 0 })
      }),
    )
  })
})

describe("return path after sign-in", () => {
  it("keeps the remembered page when sign-up or social sign-in fails, and uses it in the callback", () => {
    const items = rememberReturn("/invitations/inv_9?ref=mail")
    const failing = backend(() => json({ code: "USER_ALREADY_EXISTS", message: "exists" }, 422))
    return run(
      Effect.gen(function* () {
        yield* Effect.flip(
          failing.auth.signUpEmail({ name: "Ada", email: "ada@acme.dev", password: "pw" }),
        )
        yield* Effect.flip(failing.auth.signInSocial("github"))
        expect(items.get("console-auth-return")).toBe("/invitations/inv_9?ref=mail")
        expect(failing.seen[0]?.body).toMatchObject({
          callbackURL: "https://console.test/invitations/inv_9?ref=mail",
        })
        expect(failing.seen[1]?.body).toMatchObject({
          callbackURL: "https://console.test/invitations/inv_9?ref=mail",
        })
      }),
    )
  })

  it("consumes the remembered page once sign-up or social sign-in succeeds", () => {
    const items = rememberReturn("/invitations/inv_9")
    const signedUp = backend(() =>
      json({ user: { id: "u_1", name: "Ada", email: "ada@acme.dev", emailVerified: false } }),
    )
    const social = backend(() => json({ url: "https://github.com/login/oauth/authorize" }))
    return run(
      Effect.gen(function* () {
        yield* signedUp.auth.signUpEmail({ name: "Ada", email: "ada@acme.dev", password: "pw" })
        expect(items.has("console-auth-return")).toBe(false)
        items.set("console-auth-return", "/invitations/inv_9")
        yield* social.auth.signInSocial("github")
        expect(items.has("console-auth-return")).toBe(false)
      }),
    )
  })
})

describe("onboarding slugs", () => {
  it("derives a slug the contract accepts from a display name", () => {
    expect(slugify("  Acme Robotics, Inc.  ")).toBe("acme-robotics-inc")
    expect(slugify("x".repeat(60))).toHaveLength(40)
    expect(slugify(`${"a".repeat(39)} b`)).toBe("a".repeat(39))
    expect(slugify("---")).toBe("")
  })
})
