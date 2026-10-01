import { Actor, RetentionGap, UnknownCursor } from "@durable-actors/core"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { Effect, Result, Schema } from "effect"
import { signedIn } from "../access.ts"

/** A room's key: a non-empty string. */
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

/** A message posted to the room, as its feed and history deliver it. */
export const MessagePosted = Actor.event("MessagePosted", {
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
})

/** The room was archived after sitting idle, and refuses further posts. */
export const RoomArchived = Actor.event("RoomArchived", {})

/** Runs after the posting turn commits; the executor has no database access. */
export const ModerateMessage = Actor.job("ModerateMessage", {
  payload: { id: Schema.String, body: Schema.String },
  success: Schema.Struct({ id: Schema.String, flagged: Schema.Boolean }),
})

/** A moderator's ruling on an appealed message; the waiting appeal reads it from the room's events. */
export const AppealDecided = Actor.event("AppealDecided", {
  messageId: Schema.String,
  restore: Schema.Boolean,
})

/** One appeal per message: it notifies moderators once and waits durably for their decision. */
export const Appeal = Actor.workflow("Appeal", {
  payload: { messageId: Schema.String },
  success: Schema.Boolean,
  key: ({ messageId }) => messageId,
  versions: { "notify-moderators": { current: 1, min: 0 } },
})

/** Workflow step that notifies moderators of an appeal, once. */
export const Notify = Appeal.step("notify", { payload: Schema.String })

/**
 * Waits, up to the workflow's timeout, for the `AppealDecided` event of the
 * appealed message.
 */
export const AwaitDecision = Appeal.wait("decision", AppealDecided)

/** A moderator's ruling on an appeal; emits `AppealDecided`. */
export const DecideAppeal = Actor.command("DecideAppeal", {
  payload: { messageId: Schema.String, restore: Schema.Boolean },
})

/** Creating command of `Thread`; records its room and message. */
export const Open = Actor.command("Open", {
  payload: { room: Schema.String, messageId: Schema.String },
})

/** Adds a reply to the thread and returns the reply count. */
export const Reply = Actor.command("Reply", { payload: Schema.String, success: Schema.Int })

/** A reply thread: a minted child with no key, created only by its room's `Open` intent. */
export const Thread = Actor.make("Thread", {
  state: Actor.state({
    room: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    messageId: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    replies: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  access: signedIn,
  api: { Open, Reply },
  createdBy: Open,
})

/** Mints a reply thread for a message and returns its id. */
export const StartThread = Actor.command("StartThread", {
  payload: { messageId: Schema.String },
  success: Schema.String,
})

/** Declared failure of `Post` and `React` once the room is archived. */
export class RoomClosed extends Schema.TaggedError<RoomClosed>()("RoomClosed", {}) {}

/**
 * Room state: whether it is closed, the reaction count, and the token of the
 * pending idle check.
 */
export const RoomState = Actor.state({
  closed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  reactions: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  idleToken: Schema.optional(Schema.String),
})

/**
 * A pure transition with no server handler, which a browser runs
 * optimistically; an archived room refuses it, and the browser rolls it back.
 * Typing indicators are connection frames, not state.
 */
export const React = Actor.reducer("React", {
  state: RoomState,
  payload: Schema.Int,
  error: RoomClosed,
  reduce: (state, n) =>
    state.closed
      ? Result.fail(RoomClosed.make({}))
      : Result.succeed({ ...state, reactions: state.reactions + n }),
})

/** Who is typing. Frames reach connected clients only; nothing is stored. */
export const Presence = Actor.connection("Presence", {
  client: Schema.Struct({ typing: Schema.Boolean }),
  server: Schema.Struct({ user: Schema.String, typing: Schema.Boolean }),
  session: Schema.Struct({ user: Schema.String }),
})

/**
 * Posts a message, optionally with an attachment, and returns its id; fails
 * with `RoomClosed`.
 */
export const Post = Actor.command("Post", {
  payload: { body: Schema.String, file: Schema.optional(Schema.Uint8Array) },
  success: Schema.String,
  error: RoomClosed,
})

/** Closes the room and cancels its idle timer. */
export const Archive = Actor.command("Archive")

/** Deletes the author's message and withdraws its moderation call if it has not settled. */
export const Retract = Actor.command("Retract", { payload: Schema.String })

/** The latest messages, newest first, up to `limit` (1 to 100). */
export const Recent = Actor.query("Recent", {
  payload: { limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })) },
  success: Schema.Array(
    Schema.Struct({ id: Schema.String, author: Schema.String, body: Schema.String }),
  ),
})

/** One page of posted messages after an exclusive cursor, with each message's cursor. */
export const History = Actor.query("History", {
  payload: {
    after: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  },
  success: Schema.Array(Schema.Struct({ cursor: Schema.String, message: MessagePosted })),
  error: Schema.Union([UnknownCursor, RetentionGap]),
})

/** The attachment stored under the message id, if any. */
export const Attachment = Actor.query("Attachment", {
  payload: Schema.String,
  success: Schema.Option(Schema.Uint8Array),
})

/**
 * Internal commands: only System callers (the relay and job routes) reach
 * them.
 */
export const IdleCheck = Actor.command("IdleCheck", {
  payload: { token: Schema.String },
})

/** The moderation result for a message; a flagged message is deleted. */
export const Moderated = Actor.command("Moderated", {
  payload: { id: Schema.String, flagged: Schema.Boolean },
})

/** A moderation call that exhausted its retries. */
export const ModerationFailed = Actor.command("ModerationFailed", {
  payload: Actor.DeadLetter(ModerateMessage),
})

/** A moderation call that was cancelled. */
export const ModerationCancelled = Actor.command("ModerationCancelled", {
  payload: Actor.Cancelled(ModerateMessage),
})

/**
 * A chat room. `ModerateMessage` runs at most two calls per room in flight,
 * across every runner.
 */
export const Room = Actor.make("Room", {
  key: RoomId,
  state: RoomState,
  tables: [messages],
  blobs: [Attachments],
  events: [MessagePosted, RoomArchived, AppealDecided],
  feeds: [MessagePosted],
  jobs: {
    ModerateMessage: {
      job: ModerateMessage,
      retry: { times: 5 },
      concurrency: { perActor: 2 },
      onSuccess: Moderated,
      onDeadLetter: ModerationFailed,
      onCancelled: ModerationCancelled,
    },
  },
  access: signedIn,
  api: {
    Post,
    Archive,
    Retract,
    Recent,
    History,
    Attachment,
    React,
    Presence,
    Appeal,
    DecideAppeal,
    StartThread,
  },
  internal: { IdleCheck, Moderated, ModerationFailed, ModerationCancelled },
  policy: {
    keepReceipts: "7 days",
    keepEvents: "30 days",
  },
})

/** Sends the daily digest. Only its cron tick calls it, so it stays out of the public API. */
export const Send = Actor.command("Send")

/** One per deployment: the digest goes out at 08:00 UTC once, however many runners serve it. */
export const Digest = Actor.make("Digest", {
  key: Actor.singleton,
  state: Actor.state({ sent: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: {},
  internal: { Send },
  schedules: { "0 8 * * *": Send },
  policy: { maxScheduleLag: "1 hour" },
})
