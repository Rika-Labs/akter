import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { PgClient } from "@effect/sql-pg"
import { processWebhook } from "./service.ts"

const polar = {
  accessToken: "token",
  productId: "product-pro",
  webhookSecret: `whsec_${Buffer.from("test-only-webhook-key-with-entropy").toString("base64")}`,
  sandbox: true,
  origin: "http://localhost:3000",
}

describe("billing service", () => {
  it.effect("rejects an invalid signature through the real webhook verifier", () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.flip(
          processWebhook("{}", new Headers(), polar).pipe(
            Effect.provideService(PgClient.PgClient, {} as never),
          ),
        ))._tag,
      ).toBe("InvalidWebhook")
    }),
  )
})
