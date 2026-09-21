// Contract file: safe to import from clients. Commands, queries, streams and a live connection.
import { Schedule, Schema } from "effect"
import { Actor, Delivery, Effects, Events, Hibernate, Mailbox } from "../framework/Actor.ts"

export const RoomId = Schema.String.pipe(Schema.brand("RoomId"))
export type RoomId = typeof RoomId.Type

export class Message extends Schema.Class<Message>("Message")({
  id: Schema.String,
  authorId: Schema.String,
  body: Schema.String,
  sentAt: Schema.DateTimeUtc
}) {}

// declared errors are yieldable and tagged; no `httpApiStatus` means 422 on HTTP
export class InvalidMessage extends Schema.TaggedError<InvalidMessage>()("InvalidMessage", {
  reason: Schema.Literals(["empty", "too_long"])
}) {
  override get message(): string {
    return `message rejected: ${this.reason}`
  }
}
export class NotAMember extends Schema.TaggedError<NotAMember>()("NotAMember", { userId: Schema.String }, { httpApiStatus: 403 }) {
  override get message(): string {
    return `${this.userId} is not a member of this room`
  }
}

export class MessageAdded extends Schema.TaggedClass<MessageAdded>()("MessageAdded", { message: Message }) {}
export class EmailDelivered extends Schema.TaggedClass<EmailDelivered>()("EmailDelivered", { messageId: Schema.String }) {}

// declared effect: executed after commit by the executor in Chat.server.ts
export class SendEmail extends Schema.TaggedClass<SendEmail>()("SendEmail", {
  messageId: Schema.String,
  to: Schema.String,
  body: Schema.String
}) {}

// a connection frame: ephemeral in both directions, never persisted
export class Typing extends Schema.TaggedClass<Typing>()("Typing", { userId: Schema.String }) {}

// `Actor.table` adds tenant_id, actor_id and the composite index to the drizzle table
export const messages = Actor.table("chat_messages", {
  id: "text",
  author_id: "text",
  body: "text",
  sent_at: "timestamptz"
})

// struct input (object arg)
export const SendMessage = Actor.command("SendMessage", {
  description: "Append a message to the room. The caller must be a member; empty or >4000 character bodies are rejected.",
  input: { body: Schema.String },
  output: Message,
  errors: [InvalidMessage, NotAMember]
})
export const MarkDelivered = Actor.command("MarkDelivered", {
  description: "Executor callback: the email for a message was delivered. Internal; not reachable from outside.",
  input: { messageId: Schema.String }
})
export const Recent = Actor.query("Recent", {
  description: "The last `limit` messages of the room, newest first. Fails with NotAMember for non-members.",
  input: { limit: Schema.Number },
  output: Schema.Array(Message),
  errors: [NotAMember]
})
export const Transcript = Actor.stream("Transcript", {
  description: "Live feed of messages from now on. Fails with NotAMember for non-members.",
  output: Message,
  errors: [NotAMember]
})
// fourth contract kind: a typed bidirectional session on the activation
export const Live = Actor.connection("Live", {
  description: "Live room session: message and typing frames out, typing signals in. Fails with NotAMember.",
  params: { since: Schema.optionalKey(Schema.Number) },
  server: Schema.Union([Message, Typing]),
  client: Typing,
  state: { typingSince: Schema.optionalKey(Schema.DateTimeUtc) }, // per-connection, in memory
  errors: [NotAMember]
})

export const Chat = Actor.make("Chat", {
  description: "A chat room. One actor per room; messages are rows, membership is checked per call.",
  id: RoomId,
  commands: [SendMessage, MarkDelivered],
  internal: [MarkDelivered], // reachable from executors / turns only
  queries: [Recent],
  streams: [Transcript],
  connections: [Live],
  events: [MessageAdded, EmailDelivered],
  effects: [SendEmail],
  tables: [messages],
  lifecycle: [
    Hibernate.after("5 minutes"),
    Events.keep("30 days"),
    Mailbox.capacity(500),
    Delivery.retry(Schedule.exponential("100 millis")),
    Effects.retry(Schedule.spaced("1 second"))
  ]
})
