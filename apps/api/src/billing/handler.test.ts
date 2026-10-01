import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Context, Effect } from "effect"
import { HttpRouter } from "effect/http"
import { webhookRoute } from "./handler.ts"
import type { Config } from "../config.ts"

const config = {
  polar: {
    accessToken: "token",
    productId: "product",
    webhookSecret: "secret",
    sandbox: true,
    origin: "http://localhost:3000",
  },
} as Config

const request = Effect.fn(function* (body: string, value: Config = config) {
  const app = HttpRouter.toWebHandler(webhookRoute(value), { disableLogger: true })

  return yield* Effect.acquireUseRelease(
    Effect.succeed(app),
    (web) =>
      Effect.promise(() =>
        web.handler(
          new Request("http://localhost/api/billing/webhook", { method: "POST", body }),
          Context.empty() as never,
        ),
      ),
    (web) => Effect.promise(() => web.dispose()),
  )
})

describe("billing webhook handler", () => {
  it.effect("fails closed when billing is disabled", () =>
    Effect.gen(function* () {
      expect(yield* request("{}", { ...config, polar: undefined })).toHaveProperty("status", 503)
    }),
  )

  it.effect("rejects an oversized raw body before signature verification", () =>
    Effect.gen(function* () {
      expect(yield* request("x".repeat(1_048_577))).toHaveProperty("status", 413)
    }),
  )
})
