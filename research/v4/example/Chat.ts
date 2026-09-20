// Contract file: safe to import from clients.
import { Schedule, Schema } from "effect"
import type { OwnedTable } from "../framework/Actor.ts"
import { Actor, Delivery, Effects, Events, Hibernate } from "../framework/Actor.ts"

export const RoomId = Schema.String.pipe(Schema.brand("RoomId"))
export type RoomId = typeof RoomId.Type

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
// declared effect: executed after commit by the executor in Chat.server.ts
export class SendEmail extends Schema.TaggedClass<SendEmail>()("SendEmail", { to: Schema.String, body: Schema.String }) {}

// placeholder for a drizzle table with (tenant_id, actor_id) columns
export const messages = {} as OwnedTable

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
export const Transcript = Actor.stream("Transcript", { output: Message, errors: [NotAMember] })

export const Chat = Actor.make("Chat", {
  id: RoomId,
  commands: [SendMessage],
  queries: [Recent],
  streams: [Transcript],
  events: [MessageAdded],
  effects: [SendEmail],
  tables: [messages],
  memory: () => ({ typing: new Set<string>() }),
  lifecycle: [
    Hibernate.after("5 minutes"),
    Events.keep("30 days"),
    Delivery.retry(Schedule.exponential("100 millis")),
    Effects.retry(Schedule.spaced("1 second"))
  ]
})
