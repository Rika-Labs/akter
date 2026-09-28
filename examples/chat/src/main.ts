// Chat over HTTP. Post with an Idempotency-Key minted from POST /command-ids and retry with the same key:
//   curl -X POST localhost:3000/command-ids -H 'authorization: Bearer ada'
//   curl -X POST localhost:3000/actors/Room/lobby/Post -H 'authorization: Bearer ada' \
//     -H 'idempotency-key: <commandId>' -H 'content-type: application/json' -d '{"body":"hello"}'
//   curl -X POST localhost:3000/actors/Room/lobby/History -H 'authorization: Bearer ada' \
//     -H 'content-type: application/json' -d '{}'
//   curl localhost:3000/openapi.json
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { User } from "@durable-actors/core"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RoomLive } from "./room/layer.ts"
import { ModerationApi, Moderators } from "./room/moderation.ts"
import { routes } from "./server.ts"

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Config.String("DATABASE_URL")

    return RoomLive.pipe(
      Layer.provide([ModerationApi.layer, Moderators.layer]),
      Layer.provideMerge(
        Actors.layer({
          authorize: ({ caller, ref }) =>
            Effect.succeed(Schema.is(User)(caller) && ref.tenant === "chat-demo"),
        }),
      ),
      Layer.provide(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

HttpRouter.serve(routes).pipe(
  Layer.provide(runtime),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.launch,
  BunRuntime.runMain,
)
