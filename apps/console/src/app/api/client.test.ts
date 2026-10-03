import { Conflict, Me, NotImplemented, Forbidden, NotFound, Unauthorized } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
  apiOrigin,
  cloud,
  consoleError,
  load,
  rememberAuthReturn,
  signInDestination,
} from "./client.ts"

const fetch = vi.spyOn(globalThis, "fetch")

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fetch.mockReset()
})

afterAll(() => fetch.mockRestore())

describe("cloud client", () => {
  it("applies the contract prefix exactly once and includes session cookies", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(Me)))({
          user: null,
          identityKind: "api-key",
          activeOrganizationId: null,
          organizations: [],
        })
        fetch.mockResolvedValue(
          new Response(body, { headers: { "content-type": "application/json" } }),
        )
        const api = yield* cloud
        const result = yield* api.account.me()
        expect(result.identityKind).toBe("api-key")
        expect(fetch.mock.calls[0]?.[0]).toEqual(new URL("http://localhost/api/me"))
        expect(fetch.mock.calls[0]?.[1]?.credentials).toBe("include")
      }),
    ))

  it("resolves same-origin and explicit API mounts without repeating /api", () => {
    expect(apiOrigin("/api", "https://console.akter.dev")).toBe("https://console.akter.dev")
    expect(apiOrigin("https://api.akter.dev/api/", "https://console.akter.dev")).toBe(
      "https://api.akter.dev",
    )
    expect(apiOrigin("/cloud/api", "https://console.akter.dev")).toBe(
      "https://console.akter.dev/cloud",
    )
  })

  it("decodes NotImplemented from the contract before choosing a route fixture", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(NotImplemented))(
          NotImplemented.make({ operation: "account.me" }),
        )
        fetch.mockResolvedValue(
          new Response(body, { status: 501, headers: { "content-type": "application/json" } }),
        )
        const fixture = vi.fn(() => Promise.resolve("sample"))
        const effect = Effect.gen(function* () {
          const api = yield* cloud
          yield* api.account.me()
          return "real"
        })
        expect(yield* load(effect, fixture)).toBe("sample")
        expect(fixture).toHaveBeenCalledOnce()
      }),
    ))
})

describe("route fallback", () => {
  it("never imports fixture data for a successful endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = vi.fn(() => Promise.resolve("sample"))
        expect(yield* load(Effect.succeed("real"), fixture)).toBe("real")
        expect(fixture).not.toHaveBeenCalled()
      }),
    ))

  it("falls back only on NotImplemented, not denied or conflicted requests", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = vi.fn(() => Promise.resolve("sample"))
        expect(
          yield* load(Effect.fail(NotImplemented.make({ operation: "billing.summary" })), fixture),
        ).toBe("sample")
        fixture.mockClear()
        for (const error of [
          Forbidden.make({ message: "denied" }),
          Conflict.make({ message: "Taken slug." }),
          NotFound.make({ resource: "project", id: "p_8" }),
        ]) {
          const result = yield* load(Effect.fail(error), fixture).pipe(Effect.result)
          expect(result._tag).toBe("Failure")
        }
        expect(fixture).not.toHaveBeenCalled()
      }),
    ))

  it("keeps missing credentials distinct from transport errors", () => {
    expect(
      consoleError(Unauthorized.make({ code: "expired", message: "Expired session." })),
    ).toMatchObject({ kind: "Unauthorized", message: "Sign in to continue." })
    expect(consoleError(new TypeError("Failed to fetch"))).toMatchObject({ kind: "Unavailable" })
  })

  it("forced fixture mode never executes a live request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
        const live = vi.fn(() => "real")
        expect(yield* load(Effect.sync(live), () => Promise.resolve("sample"))).toBe("sample")
        expect(live).not.toHaveBeenCalled()
      }),
    ))
})

it("preserves a protected return path once without accepting external or auth redirects", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  })
  vi.stubGlobal("location", { pathname: "/invitations/inv_9", search: "" })
  rememberAuthReturn()
  expect(signInDestination("/")).toBe("/invitations/inv_9")
  expect(signInDestination("/")).toBe("/")
  for (const rejected of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "/sign-in?next=loop",
  ]) {
    items.set("console-auth-return", rejected)
    expect(signInDestination("/")).toBe("/")
  }
})
