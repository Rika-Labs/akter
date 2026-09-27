// Chat over HTTP. `bun run client alice "hi"` posts through the Promise client in src/client.ts.
// Without it, post with an Idempotency-Key minted from POST /command-ids and retry with the same key:
//   curl -X POST localhost:3000/command-ids -H 'authorization: Bearer alice'
//   curl -X POST localhost:3000/actors/Room/lobby/Post -H 'authorization: Bearer alice' \
//     -H 'idempotency-key: <commandId>' -H 'content-type: application/json' -d '{"body":"hi"}'
//   curl -X POST localhost:3000/actors/Room/lobby/History -H 'authorization: Bearer alice' \
//     -H 'content-type: application/json' -d '{}'
//   curl localhost:3000/openapi.json
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Actor, Unauthorized, User } from "durable-actors"
import { Actors, Database } from "durable-actors/runtime"
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Headers, HttpRouter } from "effect/unstable/http"
import { Room } from "./room/contract.ts"
import { RoomLive } from "./room/layer.ts"
import { ModerationApi } from "./room/moderation.ts"

// A stand-in for a real identity provider: the bearer token is the user's name. Use Actor.auth.jwt in production.
const demoAuth = Actor.auth.make((request) =>
  Option.match(Headers.get(request.headers, "authorization"), {
    onNone: () => Effect.fail(Unauthorized.make({ code: "missing_credentials" })),
    onSome: (header) => {
      const match = /^Bearer ([a-z0-9-]{1,64})$/.exec(header)

      return match === null
        ? Effect.fail(Unauthorized.make({ code: "invalid_credentials" }))
        : Effect.succeed({ tenant: "chat-demo", caller: User.make({ subject: match[1]! }) })
    },
  }),
)

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Config.String("DATABASE_URL")

    return RoomLive.pipe(
      Layer.provide(ModerationApi.layer),
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

const routes = Actor.serve({
  actors: [Room],
  auth: demoAuth,
  openapi: { path: "/openapi.json", title: "Chat" },
})

HttpRouter.serve(routes).pipe(
  Layer.provide(runtime),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.launch,
  BunRuntime.runMain,
)
