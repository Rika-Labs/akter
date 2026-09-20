// Contract file: safe to import from clients.
import { Schema } from "effect"
import { Actor, Events, Hibernate } from "../framework/Actor.ts"

export class Message extends Schema.Class<Message>("Message")({
  id: Schema.String,
  authorId: Schema.String,
  body: Schema.String,
  sentAt: Schema.DateTimeUtc
}) {}
export class InvalidMessage extends Schema.TaggedError<InvalidMessage>()("InvalidMessage", {
  reason: Schema.Literals(["empty", "too_long"])
}, { httpApiStatus: 422 }) {}
export class NotAMember extends Schema.TaggedError<NotAMember>()("NotAMember", { userId: Schema.String }, { httpApiStatus: 403 }) {}
export class MessageAdded extends Schema.TaggedClass<MessageAdded>()("MessageAdded", { message: Message }) {}

// struct input (object arg)
export const SendMessage = Actor.command("SendMessage", {
  input: { id: Schema.String, body: Schema.String },
  output: Message,
  errors: [InvalidMessage, NotAMember]
})
export const Recent = Actor.query("Recent", {
  input: { limit: Schema.Number },
  output: Schema.Array(Message),
  errors: [NotAMember]
})

export const Chat = Actor.make("Chat", {
  commands: [SendMessage],
  queries: [Recent],
  events: [MessageAdded],
  lifecycle: [Hibernate.after("5 minutes"), Events.keep("30 days")]
})
