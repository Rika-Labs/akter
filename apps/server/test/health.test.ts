import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpApiTest } from "effect/unstable/httpapi"
import { BunHttpServer } from "@effect/platform-bun"
import { Api } from "@project/contracts"
import { HealthLive } from "../src/health.ts"

it.effect("health contract round-trips through the generated HttpApi client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.merge(HealthLive, BunHttpServer.layerHttpServices))
      const client = yield* HttpApiTest.groups(Api, ["health"]).pipe(Effect.provideContext(context))
      expect(yield* client.health.health()).toEqual({ status: "ok" })
    }),
  ),
)
