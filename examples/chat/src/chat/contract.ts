import { Actor } from "durable-actors"
import { Effect, Schema } from "effect"

export class RoomFull extends Schema.TaggedError<RoomFull>()(
  "RoomFull",
  { limit: Schema.Int },
  { httpApiStatus: 422 },
) {}

export const Message = Schema.Struct({ author: Schema.String, text: Schema.String })

export const Post = Actor.command("Post", {
  input: Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(2000)) }),
  output: Schema.Int,
  errors: [RoomFull],
})

export const History = Actor.query("History", { output: Schema.Array(Message) })

export const LIMIT = 1000

/** A chat room keyed by name; each post is one durable, receipted turn. */
export const Chat = Actor.make("Chat", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    messages: Schema.Array(Message).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  api: { Post, History },
})
