// Query layer: reads committed rows on the caller's node, so it needs Database, not Actors.
import { Effect } from "effect"
import { Chat, Message, messages } from "./Chat.ts"
import { RoomAccess } from "./Chat.server.ts"

export const ChatReads = Chat.toQueryLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    return Chat.ofQueries({
      Recent: Effect.fn(function*(ctx, { limit }) {
        yield* access.requireMember(ctx.caller, ctx.ref)
        // `ctx.rows` is a ScopedRead here: an `insert` on this line would not compile
        const rows = yield* ctx.rows(messages).all({ orderBy: { column: "sent_at", direction: "desc" }, limit })
        return rows.map((r) => new Message({ id: r.id, authorId: r.author_id, body: r.body, sentAt: r.sent_at }))
      })
    })
  })
)
