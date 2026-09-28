import { Intent } from "@durable-actors/core"
import { DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AppealDecided,
  Attachments,
  AwaitDecision,
  Digest,
  MessagePosted,
  messages,
  messagesDdl,
  ModerateMessage,
  Notify,
  Room,
  RoomArchived,
  RoomClosed,
  Thread,
} from "./contract.ts"
import { ModerationApi, Moderators } from "./moderation.ts"

export const RoomCommands = Room.toLayer(
  Effect.gen(function* () {
    const moderators = yield* Moderators

    return {
      Post: Effect.fnUntraced(function* ({ body, file }) {
        const turn = yield* Room.Turn

        // A declared failure rolls back everything the turn wrote.
        if (turn.state.closed) return yield* RoomClosed.make({})

        const id = turn.commandId

        const author = Option.match(turn.principal, {
          onNone: () => "anonymous",
          onSome: ({ subject }) => subject,
        })

        if (file !== undefined) yield* turn.blob(Attachments).set(id, file)

        yield* turn.rows(messages).insert({
          id,
          author,
          body,
          sentAt: DateTime.toDate(yield* DateTime.now),
          attachment: file === undefined ? null : id,
        })

        yield* turn.emit(MessagePosted.make({ id, author, body }))
        yield* turn.perform(ModerateMessage.make({ id, body }), { key: `moderate:${id}` })

        // The same key replaces the pending timer, so every post pushes it back.
        yield* (yield* Room.intents(turn.id))
          .IdleCheck({ token: turn.commandId })
          .pipe(Intent.after("24 hours"), Intent.key("idle"))
        yield* turn.state.set({
          closed: turn.state.closed,
          reactions: turn.state.reactions,
          idleToken: turn.commandId,
        })

        return id
      }),

      Archive: Effect.fnUntraced(function* () {
        const turn = yield* Room.Turn
        yield* turn.state.set({
          closed: true,
          reactions: turn.state.reactions,
          idleToken: turn.state.idleToken,
        })
        yield* turn.emit(RoomArchived.make({}))
        yield* Intent.cancel("idle")
      }),

      Retract: Effect.fnUntraced(function* (id: string) {
        const turn = yield* Room.Turn
        const attached = yield* turn.rows(messages).one({ where: { id } })
        yield* turn.rows(messages).delete().where({ id })

        if (Option.isSome(attached) && attached.value.attachment === id)
          yield* turn.blob(Attachments).set(id, new Uint8Array())

        // A call that already reached the provider is reported to ModerationCancelled, not undone.
        yield* turn.cancelEffect(`moderate:${id}`)
      }),

      // A timer the relay has already claimed still fires once after a cancel,
      // so the check reads state instead of trusting that it was never cancelled.
      IdleCheck: Effect.fnUntraced(function* ({ token }) {
        const turn = yield* Room.Turn

        if (!turn.state.closed && turn.state.idleToken === token)
          yield* (yield* Room.intents(turn.id)).Archive()
      }),

      Moderated: Effect.fnUntraced(function* ({ id, flagged }) {
        const turn = yield* Room.Turn

        if (!flagged) return

        // Deleting the entry frees its bytes and its slot in the room's blob quotas.
        const attached = yield* turn.rows(messages).one({ where: { id } })
        yield* turn.rows(messages).delete().where({ id })

        if (Option.isSome(attached) && attached.value.attachment === id)
          yield* turn.blob(Attachments).delete(id)
      }),

      ModerationFailed: Effect.fnUntraced(function* (dead) {
        yield* Room.Turn
        yield* Effect.logWarning("moderation dead-lettered", dead.effectId)
      }),

      // The message is already gone; an ambiguous outcome means the provider may have seen it.
      ModerationCancelled: Effect.fnUntraced(function* (cancelled) {
        yield* Room.Turn
        yield* Effect.logInfo("moderation cancelled", cancelled.effectId).pipe(
          Effect.annotateLogs({ outcome: cancelled.outcome._tag, ambiguous: cancelled.ambiguous }),
        )
      }),

      // A runner lost mid-notify reruns it; `Moderators` deduplicates by message id.
      Appeal: Effect.fnUntraced(function* ({ messageId }) {
        const wf = yield* Room.Workflow

        if ((yield* wf.version("notify-moderators")) >= 1)
          yield* Notify.run(messageId, moderators.notify)

        const decided = yield* AwaitDecision({
          where: (event) => event.messageId === messageId,
          timeout: "3 days",
        })

        return Option.match(decided, { onNone: () => false, onSome: ({ restore }) => restore })
      }),

      DecideAppeal: Effect.fnUntraced(function* ({ messageId, restore }) {
        yield* (yield* Room.Turn).emit(AppealDecided.make({ messageId, restore }))
      }),

      // A replayed turn mints the same id, and the thread is created after the room commits.
      StartThread: Effect.fnUntraced(function* ({ messageId }) {
        const turn = yield* Room.Turn
        const id = yield* turn.mint(Thread)
        yield* (yield* Thread.intents(id)).Open({ room: turn.id, messageId })

        return id
      }),

      // The connection parks between frames: the room hibernates while members stay connected.
      Presence: {
        open: Effect.fnUntraced(function* () {
          const conn = yield* Room.Connection

          const user = Option.match(conn.principal, {
            onNone: () => "anonymous",
            onSome: ({ subject }) => subject,
          })

          yield* conn.session.set({ user })
        }),
        frame: Effect.fnUntraced(function* ({ typing }: { readonly typing: boolean }) {
          const conn = yield* Room.Connection
          const session = yield* conn.session.get

          const user = Option.match(session, {
            onNone: () => "anonymous",
            onSome: (stored) => stored.user,
          })

          yield* conn.broadcast({ user, typing }, { except: [conn.connectionId] })
        }),
      },
    }
  }),
)

export const ThreadCommands = Thread.toLayer(
  Effect.succeed({
    Open: Effect.fnUntraced(function* ({ room, messageId }) {
      yield* (yield* Thread.Turn).state.set({ room, messageId, replies: 0 })
    }),
    Reply: Effect.fnUntraced(function* () {
      const turn = yield* Thread.Turn
      yield* turn.state.set({ replies: turn.state.replies + 1 })

      return turn.state.replies
    }),
  }),
)

export const RoomReads = Room.toQueryLayer(
  Effect.succeed({
    Recent: Effect.fnUntraced(function* ({ limit }) {
      const rows = yield* (yield* Room.Read)
        .rows(messages)
        .all({ orderBy: { sentAt: "desc", id: "desc" }, limit })

      return rows.map(({ id, author, body }) => ({ id, author, body }))
    }),
    History: Effect.fnUntraced(function* ({ after, limit }) {
      const read = yield* Room.Read
      const entries = yield* read.events(MessagePosted, { after, limit })

      const ids = entries.map(({ event }) => event.id)
      const rows = yield* read.rows(messages).all({ where: { id: { in: ids } } })
      const kept = new Set(rows.map(({ id }) => id))

      // A moderated post keeps its event and cursor but not its body.
      return entries.map(({ cursor, event }) => ({
        cursor,
        message: kept.has(event.id)
          ? event
          : MessagePosted.make({ id: event.id, author: event.author, body: "" }),
      }))
    }),
    Attachment: Effect.fnUntraced(function* (id: string) {
      const message = yield* (yield* Room.Read).rows(messages).one({ where: { id } })

      if (Option.isNone(message) || message.value.attachment !== id) return Option.none()

      return yield* (yield* Room.Read).blob(Attachments).get(id)
    }),
  }),
)

/** May run in another process: it gets no database, only the provider. */
export const RoomEffects = Room.toEffectLayer(
  Effect.gen(function* () {
    const moderation = yield* ModerationApi

    return {
      ModerateMessage: Effect.fnUntraced(function* ({ id, body }) {
        const exec = yield* Room.Executor
        const flagged = yield* moderation.check(body, { idempotencyKey: exec.effectId })

        return { id, flagged }
      }),
    }
  }),
)

export const DigestCommands = Digest.toLayer(
  Effect.succeed({
    Send: Effect.fnUntraced(function* () {
      const turn = yield* Digest.Turn
      yield* turn.state.set({ sent: turn.state.sent + 1 })
    }),
  }),
)

/**
 * Creates the table as a drizzle-kit migration would, then registers the
 * room's commands and reads; its executors are `RoomEffects`.
 */
export const RoomHandlers = Layer.unwrap(
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient).unsafe(messagesDdl)

    return Layer.mergeAll(RoomCommands, ThreadCommands, DigestCommands, RoomReads)
  }).pipe(Effect.orDie),
)

export const RoomLive = Layer.merge(RoomHandlers, RoomEffects)
