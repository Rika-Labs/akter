import { Effect, Option } from "effect"
import { Cursor, Here, Joined, Left, Moved } from "./contract.ts"

/** The other open connections with their sessions, as peers. */
const others = Effect.gen(function* () {
  const conn = yield* Cursor.Connection
  const open = yield* conn.connections({ session: true })

  return open.flatMap(({ connectionId, session }) =>
    connectionId === conn.connectionId || session === undefined
      ? []
      : [{ connectionId, ...session }],
  )
})

export const CursorLive = Cursor.toLayer(
  Effect.succeed({
    Live: {
      open: Effect.fnUntraced(function* ({ color }: { readonly color: string }) {
        const conn = yield* Cursor.Connection

        const user = Option.match(conn.principal, {
          onNone: () => "anonymous",
          onSome: ({ subject }) => subject,
        })

        yield* conn.session.set({ user, color })
        yield* conn.send(Here.make({ peers: yield* others }))
        yield* conn.broadcast(
          Joined.make({ peer: { connectionId: conn.connectionId, user, color } }),
          {
            except: [conn.connectionId],
          },
        )
      }),

      // Each move rewrites the session, so a late joiner's `Here` shows where everyone is.
      frame: Effect.fnUntraced(function* (at: { readonly x: number; readonly y: number }) {
        const conn = yield* Cursor.Connection
        yield* conn.session.set({ at })
        yield* conn.broadcast(Moved.make({ connectionId: conn.connectionId, at }), {
          except: [conn.connectionId],
        })
      }),

      close: Effect.fnUntraced(function* () {
        const conn = yield* Cursor.Connection
        yield* conn.broadcast(Left.make({ connectionId: conn.connectionId }), {
          except: [conn.connectionId],
        })
      }),

      // Frames sent while the owner was down are gone; the room as it is now replaces them.
      resync: Effect.fnUntraced(function* () {
        const conn = yield* Cursor.Connection
        yield* conn.send(Here.make({ peers: yield* others }))
      }),
    },
  }),
)
