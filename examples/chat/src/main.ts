import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actor, User } from "durable-actors"
import { Actors, Database } from "durable-actors/runtime"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { Room, RoomId } from "./room/contract.ts"
import { RoomLive } from "./room/layer.ts"
import { ModerationApi } from "./room/moderation.ts"

const live = Layer.unwrap(
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

const program = Effect.gen(function* () {
  const room = yield* Room.get(RoomId.make("lobby")).pipe(
    Actor.tenant("chat-demo"),
    Actor.as(User.make({ subject: "ada" })),
  )

  yield* room.Post({ body: "hello" })
  yield* room.React(1)
  const history = yield* room.History({})
  yield* Console.log(
    history.map(({ cursor, message }) => `${cursor} ${message.author}: ${message.body}`),
  )
})

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
