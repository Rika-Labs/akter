import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Context, Effect } from "effect"
import { APIError } from "better-auth/api"
import { Auth } from "@durable-actors/accounts"
import { Unavailable } from "@durable-actors/contracts"
import { authenticated, createOrganization, session } from "./service.ts"

interface SessionValue {
  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
    readonly emailVerified: boolean
  }
  readonly session: { readonly activeOrganizationId: string | null }
}

const auth = (value: SessionValue | null) => ({ getSession: () => Effect.succeed(value) }) as never

const provideRequestServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Context.empty() as Context.Context<R>))

describe("account service", () => {
  it.effect("rejects anonymous and unverified sessions", () =>
    Effect.gen(function* () {
      for (const value of [
        null,
        {
          user: { id: "user-1", name: "User", email: "user@example.com", emailVerified: false },
          session: { activeOrganizationId: null },
        },
      ]) {
        expect(
          (yield* Effect.flip(
            provideRequestServices(authenticated().pipe(Effect.provideService(Auth, auth(value)))),
          )).message,
        ).toBe("Sign in with a verified email")
      }
    }),
  )

  it.effect("returns the public session shape for a verified session", () => {
    const value = {
      user: { id: "user-1", name: "User", email: "user@example.com", emailVerified: true },
      session: { activeOrganizationId: "org-1" },
    }

    return Effect.gen(function* () {
      expect(
        yield* provideRequestServices(session().pipe(Effect.provideService(Auth, auth(value)))),
      ).toEqual({
        user: { id: "user-1", name: "User", email: "user@example.com" },
        activeOrganizationId: "org-1",
      })
    })
  })

  it.effect("reports a failed session lookup as unavailable, not invalid credentials", () =>
    Effect.gen(function* () {
      const failingAuth = {
        getSession: () => Effect.fail(Unavailable.make({ message: "database offline" })),
      } as never

      const error = yield* Effect.flip(
        provideRequestServices(authenticated().pipe(Effect.provideService(Auth, failingAuth))),
      )

      expect(error._tag).toBe("Unavailable")
      expect(error.message).toBe("Session lookup unavailable")
    }),
  )

  it.effect("distinguishes duplicate slugs from organization creation outages", () =>
    Effect.gen(function* () {
      const value = {
        user: { id: "user-1", name: "User", email: "user@example.com", emailVerified: true },
        session: { activeOrganizationId: null },
      }

      const payload = { name: "Acme", slug: "acme" }

      for (const [cause, tag] of [
        [
          new APIError("BAD_REQUEST", {
            code: "ORGANIZATION_ALREADY_EXISTS",
            message: "Organization already exists",
          }),
          "Conflict",
        ],
        [
          new APIError("BAD_REQUEST", {
            code: "ORGANIZATION_NOT_FOUND",
            message: "Organization not found",
          }),
          "Unavailable",
        ],
        [new APIError("INTERNAL_SERVER_ERROR", { message: "database offline" }), "Unavailable"],
        [new Error("database offline"), "Unavailable"],
      ] as const) {
        const failingAuth = {
          getSession: () => Effect.succeed(value),
          auth: Effect.succeed({
            api: { createOrganization: () => Promise.reject(cause) },
          }),
        } as never

        const error = yield* Effect.flip(
          provideRequestServices(
            createOrganization(payload, new Headers()).pipe(
              Effect.provideService(Auth, failingAuth),
            ),
          ),
        )

        expect(error._tag).toBe(tag)
      }
    }),
  )

  it.effect("does not report activation failures as slug conflicts after creation", () =>
    Effect.gen(function* () {
      const failingAuth = {
        getSession: () =>
          Effect.succeed({
            user: { id: "user-1", name: "User", email: "user@example.com", emailVerified: true },
            session: { activeOrganizationId: null },
          }),
        auth: Effect.succeed({
          api: {
            createOrganization: () =>
              Promise.resolve({
                response: { id: "org-1", name: "Acme", slug: "acme" },
                headers: new Headers(),
              }),
            setActiveOrganization: () => Promise.reject(new Error("database offline")),
          },
        }),
      } as never

      const error = yield* Effect.flip(
        provideRequestServices(
          createOrganization({ name: "Acme", slug: "acme" }, new Headers()).pipe(
            Effect.provideService(Auth, failingAuth),
          ),
        ),
      )

      expect(error._tag).toBe("Unavailable")
      expect(error.message).toBe("Organization created; select it to continue")
    }),
  )
})
