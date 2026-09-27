import { DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { MessagePosted, messages, messagesDdl, Room, RoomClosed } from "./contract.ts"

export const RoomCommands = Room.toLayer(
  Effect.succeed({
    Post: Effect.fnUntraced(function* ({ body }) {
      const turn = yield* Room.Turn

      // A declared failure rolls back everything the turn wrote.
      if (turn.state.closed) return yield* RoomClosed.make({})

      const id = turn.commandId

      const author = Option.match(turn.principal, {
        onNone: () => "anonymous",
        onSome: ({ subject }) => subject,
      })

      yield* turn.rows(messages).insert({
        id,
        author,
        body,
        sentAt: DateTime.toDate(yield* DateTime.now),
      })
      yield* turn.emit(MessagePosted.make({ id, author, body }))

      return id
    }),

    Close: Effect.fnUntraced(function* () {
      const turn = yield* Room.Turn
      yield* turn.state.set({ closed: true, reactions: turn.state.reactions })
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
