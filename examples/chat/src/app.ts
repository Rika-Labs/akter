import { Actors } from "@durable-actors/core/runtime"
import { Layer } from "effect"
import { RoomLive } from "./room/layer.ts"
import { ModerationApi, Moderators } from "./room/moderation.ts"
import { routes } from "./server.ts"

/**
 * The chat server with its actors and runtime, needing only a database and
 * crypto: `main.ts` gives it Postgres, `durable dev --entry` gives it PGlite or Postgres.
 */
export const actors = RoomLive.pipe(
  Layer.provide([ModerationApi.layer, Moderators.layer]),
  Layer.provideMerge(Actors.layer()),
)

/** The chat routes served over `actors`. */
export const app = routes.pipe(Layer.provide(actors))
