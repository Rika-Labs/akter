import { User } from "durable-actors"
import { Effect, Layer, Schema } from "effect"
import { Chat, LIMIT, RoomFull } from "./contract.ts"

export const ChatLive = Layer.mergeAll(
  Chat.toLayer(
    Effect.succeed({
      Post: Effect.fnUntraced(function* ({ text }: { readonly text: string }) {
        const turn = yield* Chat.Turn

        if (turn.state.messages.length >= LIMIT) return yield* RoomFull.make({ limit: LIMIT })

        const author = Schema.is(User)(turn.caller) ? turn.caller.subject : "anonymous"
        yield* turn.state.set({ messages: [...turn.state.messages, { author, text }] })

        return turn.state.messages.length
      }),
    }),
  ),
  Chat.toQueryLayer(
    Effect.succeed({
      History: Effect.fnUntraced(function* () {
        return (yield* Chat.Read).state.messages
      }),
    }),
  ),
)
