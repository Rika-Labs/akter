import { Actor, RetentionGap, UnknownCursor } from "@durable-actors/core"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { Effect, Result, Schema } from "effect"

export const RoomId = Schema.NonEmptyString.pipe(Schema.brand("RoomId"))

/** An owned table: the framework adds and scopes routing_key, tenant_id, and actor_id. */
export const messages = Actor.table(
  pgTable("chat_messages", {
    id: text("id").primaryKey(),
    author: text("author").notNull(),
    body: text("body").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  }),
)

/** What drizzle-kit generates for `messages`; the runtime checks its primary key at startup. */
export const messagesDdl = `CREATE TABLE IF NOT EXISTS chat_messages (
  routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
  id text NOT NULL, author text NOT NULL, body text NOT NULL,
  sent_at timestamp with time zone NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_id, id))`

export class MessagePosted extends Actor.Event<MessagePosted>()("MessagePosted", {
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
}) {}

export class RoomClosed extends Schema.TaggedError<RoomClosed>()("RoomClosed", {}) {}

export const RoomState = Actor.state({
  closed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  reactions: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

/** A pure transition with no server handler. */
export const React = Actor.reducer("React", {
  state: RoomState,
  input: Schema.Int,
  reduce: (state, n) => Result.succeed({ ...state, reactions: state.reactions + n }),
})

export const Post = Actor.command("Post", {
  input: Schema.Struct({ body: Schema.String }),
  output: Schema.String,
  errors: [RoomClosed],
})

export const Close = Actor.command("Close")

export const Recent = Actor.query("Recent", {
  input: Schema.Struct({ limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })) }),
  output: Schema.Array(
    Schema.Struct({ id: Schema.String, author: Schema.String, body: Schema.String }),
  ),
})

/** One page of posted messages after an exclusive cursor, with each message's cursor. */
export const History = Actor.query("History", {
  input: Schema.Struct({
    after: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  }),
  output: Schema.Array(Schema.Struct({ cursor: Schema.String, message: MessagePosted })),
  errors: [UnknownCursor, RetentionGap],
})

export const Room = Actor.make("Room", {
  key: RoomId,
  state: RoomState,
  tables: [messages],
  events: [MessagePosted],
  api: { Post, Close, Recent, History, React },
  policy: { keepReceipts: "7 days", keepEvents: "30 days" },
})
