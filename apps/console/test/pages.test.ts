import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { renderPage, type Page } from "../src/pages.js"
import { dashboard } from "./fixtures.js"

describe("FoldKit static pages", () => {
  it.each([
    "/sign-in",
    "/sign-up",
    "/dashboard",
    "/settings",
    "/billing",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
    "/accept-invitation",
  ] satisfies Page[])("renders %s without hydration or inline styling", (path) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const html = yield* Effect.tryPromise(() =>
          renderPage({
            path,
            csrf: "test",
            theme: "light",
            data: dashboard,
          }),
        )

        expect(html).toContain("<!doctype html>")
        expect(html).toContain('href="/styles.css"')
        expect(html).not.toMatch(/<script|style=|data-foldkit|onClick|onSubmit/)
      }),
    ),
  )
  it("escapes hostile account content and derives unequal metrics from real data", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const html = yield* Effect.tryPromise(() =>
          renderPage({
            path: "/dashboard",
            csrf: "test",
            theme: "dark",
            data: {
              ...dashboard,
              user: {
                name: '<img src=x onerror="alert(1)">',
                email: "x@example.test",
              },
            },
          }),
        )

        expect(html).not.toContain("<img")
        expect(html).toContain("&lt;img")
        expect(html).toContain('data-theme="dark"')
        expect(html).toContain("2 total")
        expect(html).toContain("Website refresh")
      }),
    ))
  it.each(["/sign-up", "/reset-password"] satisfies Page[])(
    "requires 12 characters for new passwords on %s",
    (path) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const html = yield* Effect.tryPromise(() =>
            renderPage({
              path,
              csrf: "test",
              theme: "light",
            }),
          )

          expect(html).toMatch(/<input[^>]*minlength="12"[^>]*>/)
          expect(html).not.toContain('minlength="8"')
        }),
      ),
  )
  it("offers org creation for no membership and hides billing actions for members", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const html = yield* Effect.tryPromise(() =>
          renderPage({
            path: "/settings",
            csrf: "test",
            theme: "light",
            data: {
              ...dashboard,
              organization: null,
              members: [],
              projects: [],
            },
          }),
        )

        expect(html).toContain('action="/forms/organization"')

        const billing = yield* Effect.tryPromise(() =>
          renderPage({
            path: "/billing",
            csrf: "test",
            theme: "light",
            data: {
              ...dashboard,
              organization: {
                ...dashboard.organization!,
                role: "member",
              },
            },
          }),
        )

        expect(billing).not.toContain('action="/forms/checkout"')
        expect(billing).toContain("Only organization owners and admins")
      }),
    ))
})
