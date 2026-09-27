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
    attachment: text("attachment"),
  }),
)

/** What drizzle-kit generates for `messages`; the runtime checks its primary key at startup. */
export const messagesDdl = `CREATE TABLE IF NOT EXISTS chat_messages (
  routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
  id text NOT NULL, author text NOT NULL, body text NOT NULL,
  sent_at timestamp with time zone NOT NULL, attachment text,
  PRIMARY KEY (routing_key, tenant_id, actor_id, id))`

/** Attachment bytes, stored beside the room's rows and rolled back with its turn. */
export const Attachments = Actor.blob("attachments")

export class MessagePosted extends Actor.Event<MessagePosted>()("MessagePosted", {
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
}) {}

export class RoomArchived extends Actor.Event<RoomArchived>()("RoomArchived", {}) {}

/** Runs after the posting turn commits; the executor has no database access. */
export class ModerateMessage extends Actor.effect<ModerateMessage>()("ModerateMessage", {
  input: { id: Schema.String, body: Schema.String },
  success: Schema.Struct({ id: Schema.String, flagged: Schema.Boolean }),
}) {}

export class RoomClosed extends Schema.TaggedError<RoomClosed>()("RoomClosed", {}) {}

export const RoomState = Actor.state({
  closed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  reactions: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  idleToken: Schema.optional(Schema.String),
})

/**
 * A pure transition with no server handler, which the client can later run
 * optimistically. Typing indicators are connection frames, not state.
 */
export const React = Actor.reducer("React", {
  state: RoomState,
  input: Schema.Int,
  reduce: (state, n) => Result.succeed({ ...state, reactions: state.reactions + n }),
})

export const Post = Actor.command("Post", {
  input: Schema.Struct({ body: Schema.String, file: Schema.optional(Schema.Uint8Array) }),
  output: Schema.String,
  errors: [RoomClosed],
})

export const Archive = Actor.command("Archive")

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

export const Attachment = Actor.query("Attachment", {
  input: Schema.String,
  output: Schema.Option(Schema.Uint8Array),
})

// Internal commands: only System callers (the relay and effect routes) reach them.
export const IdleCheck = Actor.command("IdleCheck", {
  input: Schema.Struct({ token: Schema.String }),
})

export const Moderated = Actor.command("Moderated", {
  input: Schema.Struct({ id: Schema.String, flagged: Schema.Boolean }),
})

export const ModerationFailed = Actor.command("ModerationFailed", {
  input: Actor.DeadLetter(ModerateMessage),
})

export const Room = Actor.make("Room", {
  key: RoomId,
  state: RoomState,
  tables: [messages],
  blobs: [Attachments],
  events: [MessagePosted, RoomArchived],
  effects: [ModerateMessage],
  api: { Post, Archive, Recent, History, Attachment, React },
  internal: { IdleCheck, Moderated, ModerationFailed },
  policy: {
    keepReceipts: "7 days",
    keepEvents: "30 days",
    effects: {
      ModerateMessage: {
        retry: { times: 5 },
        onSuccess: Moderated,
        onDeadLetter: ModerationFailed,
      },
    },
  },
})
