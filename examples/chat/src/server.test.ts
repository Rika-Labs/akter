import { BunCrypto } from "@effect/platform-bun"
import { User } from "durable-actors"
import { ActorTest } from "durable-actors/testing"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { afterAll, expect, it } from "vitest"
import { RoomLive } from "./room/layer.ts"
import { ModerationApi } from "./room/moderation.ts"
import { routes } from "./server.ts"

const web = HttpRouter.toWebHandler(
  routes.pipe(
    Layer.provide(
      RoomLive.pipe(
        Layer.provide(Layer.succeed(ModerationApi, { check: () => Effect.succeed(false) })),
        Layer.provideMerge(ActorTest.layer({ as: User.make({ subject: "ada" }) })),
      ),
    ),
    Layer.provide(BunCrypto.layer),
  ),
  { disableLogger: true },
)

afterAll(() => web.dispose())

it("serves the OpenAPI document recorded in the snapshot", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        web.handler(new Request("http://localhost/openapi.json")),
      )

      const document = yield* Effect.promise(() => response.text())

      expect(response.status).toBe(200)

      yield* Effect.promise(() =>
        expect(document).toMatchFileSnapshot("./__snapshots__/openapi.json.snap"),
      )
    }),
  ))
