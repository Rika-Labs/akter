import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { BunHttpServer } from "@effect/platform-bun"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "@durable-actors/contracts"
import { HealthLive } from "../health.ts"
import { accountLive } from "./handler.ts"
import type { Config } from "../config.ts"

const config = { origin: "http://localhost:3000" } as Config

const request = Effect.fn(function* (origin: string, body: { readonly name: string }) {
  const layer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Layer.merge(HealthLive, accountLive(config))),
    Layer.provide(BunHttpServer.layerHttpServices),
  )

  const app = HttpRouter.toWebHandler(layer, { disableLogger: true })
  const encodedBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)

  return yield* Effect.acquireUseRelease(
    Effect.succeed(app),
    (web) =>
      Effect.promise(() =>
        web.handler(
          new Request("http://localhost/api/projects", {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: encodedBody,
          }),
          Context.empty() as never,
        ),
      ),
    (web) => Effect.promise(() => web.dispose()),
  )
})

describe("account handlers", () => {
  it.effect("rejects cross-origin mutations before account services are required", () =>
    Effect.gen(function* () {
      expect(yield* request("https://evil.example", { name: "Hidden" })).toHaveProperty(
        "status",
        403,
      )
    }),
  )

  it.effect("validates request payloads at the real HTTP contract boundary", () =>
    Effect.gen(function* () {
      expect(yield* request(config.origin, { name: " " })).toHaveProperty("status", 400)
    }),
  )
})
