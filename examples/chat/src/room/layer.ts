import { Intent } from "durable-actors"
import { DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  Attachments,
  MessagePosted,
  messages,
  messagesDdl,
  ModerateMessage,
  Room,
  RoomArchived,
  RoomClosed,
} from "./contract.ts"
import { ModerationApi } from "./moderation.ts"

export const RoomCommands = Room.toLayer(
  Effect.succeed({
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
      yield* turn.perform(ModerateMessage.make({ id, body }))

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

    // A timer the relay has already claimed still fires once after a cancel,
    // so the check reads state instead of trusting that it was never cancelled.
    IdleCheck: Effect.fnUntraced(function* ({ token }) {
      const turn = yield* Room.Turn

      if (!turn.state.closed && turn.state.idleToken === token)
        yield* (yield* Room.intents(turn.id)).Archive()
    }),

    Moderated: Effect.fnUntraced(function* ({ id, flagged }) {
      const turn = yield* Room.Turn

      if (flagged) yield* turn.rows(messages).delete().where({ id })
    }),

    ModerationFailed: Effect.fnUntraced(function* (dead) {
      yield* Room.Turn
      yield* Effect.logWarning("moderation dead-lettered", dead.effectId)
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

      // A moderated post keeps its event and cursor but not its body.
      return yield* Effect.forEach(entries, ({ cursor, event }) =>
        read
          .rows(messages)
          .one({ where: { id: event.id } })
          .pipe(
            Effect.map((row) => ({
              cursor,
              message: Option.isSome(row)
                ? event
                : MessagePosted.make({ id: event.id, author: event.author, body: "" }),
            })),
          ),
      )
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

/** Creates the table as a drizzle-kit migration would, then registers the room. */
export const RoomLive = Layer.unwrap(
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient).unsafe(messagesDdl)

    return Layer.mergeAll(RoomCommands, RoomReads, RoomEffects)
  }).pipe(Effect.orDie),
)
