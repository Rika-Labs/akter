// Server file: an ephemeral actor's handlers. `ctx.memory` replaces rows/state; there is no transaction.
import { Effect, Option, Stream } from "effect"
import { Caller } from "../framework/Actor.ts"
import { Cursor, Left, Moved, NotSignedIn } from "./Cursor.ts"

export const CursorLive = Cursor.toLayer({
  // commands still serialize through the mailbox: one writer per actor, durable or not
  Move: (ctx, position) =>
    Effect.gen(function*() {
      const principal = yield* Option.match(ctx.principal, {
        onNone: () => new NotSignedIn(),
        onSome: Effect.succeed
      })
      // `memory` lives in the activation closure; `Hibernate.after("30 seconds")` drops it
      yield* ctx.memory.update((m) => ({ cursors: { ...m.cursors, [principal.userId]: position } }))
      yield* ctx.connections.broadcast(new Moved({ userId: principal.userId, position }))
    }),
  // queries on an ephemeral actor go to the activation: that is where the memory is
  Positions: (ctx) => Effect.succeed(ctx.memory.cursors),
  // nothing comes in, so the outbound stream is just the socket's lifetime
  Live: (ctx, inbound) =>
    inbound.pipe(
      Stream.drain,
      Stream.ensuring(
        Option.match(Caller.principal(ctx.conn.caller), {
          onNone: () => Effect.void,
          onSome: (p) => ctx.connections.broadcast(new Left({ userId: p.userId }), { except: ctx.conn.id })
        })
      )
    )
}, {
  hooks: [Cursor.onSleep(() => Effect.logInfo("cursors dropped"))]
})
