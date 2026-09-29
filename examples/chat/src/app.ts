import { User } from "@durable-actors/core"
import { Actors } from "@durable-actors/core/runtime"
import { Effect, Layer, Schema } from "effect"
import { RoomLive } from "./room/layer.ts"
import { ModerationApi, Moderators } from "./room/moderation.ts"
import { routes } from "./server.ts"

/**
 * The chat server with its actors and runtime, needing only a database and
 * crypto: `main.ts` gives it Postgres, `durable dev --entry` gives it PGlite or Postgres.
 */
export const actors = RoomLive.pipe(
  Layer.provide([ModerationApi.layer, Moderators.layer]),
  Layer.provideMerge(
    Actors.layer({
      authorize: ({ caller, ref }) =>
        Effect.succeed(Schema.is(User)(caller) && ref.tenant === "chat-demo"),
    }),
  ),
)

export const app = routes.pipe(Layer.provide(actors))
