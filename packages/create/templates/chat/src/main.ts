import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actor, User } from "@durable-actors/core"
import { Actors } from "@durable-actors/core/runtime"
import { Console, Effect, Layer } from "effect"
import { DatabaseLive } from "./database.ts"
import { Room, RoomId } from "./room/contract.ts"
import { RoomLive } from "./room/layer.ts"

const live = RoomLive.pipe(
  Layer.provideMerge(Actors.layer()),
  Layer.provide(DatabaseLive),
  Layer.provide(BunCrypto.layer),
)

const program = Effect.gen(function* () {
  const room = yield* Room.get(RoomId.make("lobby")).pipe(Actor.as(User.make({ subject: "ada" })))

  yield* room.Post({ body: "hello" })

  let after: string | undefined

  while (true) {
    const page = yield* room.History({ after })

    if (page.length === 0) return

    for (const { cursor, message } of page)
      yield* Console.log(`${cursor} ${message.author}: ${message.body}`)

    after = page[page.length - 1]?.cursor
  }
})

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
