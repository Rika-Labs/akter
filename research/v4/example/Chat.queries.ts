// Query layer: reads committed rows on the caller's node, so it needs Database, not Actors.
import { Effect } from "effect"
import { Chat, Message } from "./Chat.ts"
import { RoomAccess } from "./Chat.server.ts"

export const ChatReads = Chat.queries(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    return Chat.ofQueries({
      Recent: Effect.fn(function*(ctx, _input) {
        yield* access.requireMember(ctx.caller, ctx.address)
        return [] as Array<Message>
      })
    })
  })
)
