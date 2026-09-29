import { DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { MessagePosted, messages, messagesDdl, Room, RoomClosed } from "./contract.ts"

/**
 * `Post` returns the `RoomClosed` declared failure once the room is closed,
 * which rolls back the state, row and event that turn wrote.
 */
export const RoomCommands = Room.toLayer(
  Effect.succeed({
    Post: Effect.fnUntraced(function* ({ body }) {
      const turn = yield* Room.Turn
      const id = turn.commandId

      const author = Option.match(turn.principal, {
        onNone: () => "anonymous",
        onSome: ({ subject }) => subject,
      })

      const seq = turn.state.posted + 1

      yield* turn.state.set({
        closed: turn.state.closed,
        reactions: turn.state.reactions,
        posted: seq,
      })
      yield* turn.rows(messages).insert({
        id,
        seq,
        author,
        body,
        sentAt: DateTime.toDate(yield* DateTime.now),
      })
      yield* turn.emit(MessagePosted.make({ id, author, body }))

      if (turn.state.closed) return yield* RoomClosed.make({})

      return id
    }),

    Close: Effect.fnUntraced(function* () {
      const turn = yield* Room.Turn
      yield* turn.state.set({
        closed: true,
        reactions: turn.state.reactions,
        posted: turn.state.posted,
      })
    }),
  }),
)

/** Query handlers for `Room`. */
export const RoomReads = Room.toQueryLayer(
  Effect.succeed({
    Recent: Effect.fnUntraced(function* ({ limit }) {
      const rows = yield* (yield* Room.Read).rows(messages).all({ orderBy: { seq: "desc" }, limit })

      return rows.map(({ id, author, body }) => ({ id, author, body }))
    }),
    History: Effect.fnUntraced(function* ({ after, limit }) {
      const entries = yield* (yield* Room.Read).events(MessagePosted, { after, limit })

      return entries.map(({ cursor, event }) => ({ cursor, message: event }))
    }),
  }),
)

/** Creates the table as a drizzle-kit migration would, then registers the room. */
export const RoomLive = Layer.unwrap(
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient).unsafe(messagesDdl)

    return Layer.mergeAll(RoomCommands, RoomReads)
  }).pipe(Effect.orDie),
)
