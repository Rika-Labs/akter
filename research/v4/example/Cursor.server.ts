// Server file: handlers for an actor with no durable members. `vars` replaces rows/state; the turn still serializes.
import { Effect, Option, Stream } from "effect"
import { Caller } from "../framework/Actor.ts"
import { Cursor, Left, Moved, NotSignedIn } from "./Cursor.ts"

export const CursorLive = Cursor.toLayer({
  // commands still serialize through the mailbox: one writer per actor, durable or not
  Move: Effect.fn(function*(ctx, position) {
    const principal = yield* Option.match(ctx.principal, {
      onNone: () => new NotSignedIn(),
      onSome: Effect.succeed
    })
    // `vars` live on the activation (decision 160); `Hibernate.after("30 seconds")` drops them
    yield* ctx.vars.update((v) => ({ cursors: { ...v.cursors, [principal.userId]: position } }))
    yield* ctx.connections.broadcast(new Moved({ userId: principal.userId, position }))
  }),
  // a stream runs on the activation, so it can read `vars`: the current map, then the map after each broadcast frame
  Positions: (ctx) => Stream.succeed(ctx.vars.cursors),
  // nothing comes in, so the outbound stream is just the socket's lifetime; `Connections.park` lets the activation
  // sleep while this socket stays open, and the next frame or broadcast re-runs the handler with `ctx.conn.resumed`
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
