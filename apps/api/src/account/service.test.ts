import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Context, Effect } from "effect"
import { Auth } from "@durable-actors/accounts"
import { authenticated, session } from "./service.ts"

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
})
