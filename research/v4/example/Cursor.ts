// Contract file: a "durable" actor that stores nothing durable — live cursors. No tables, no state, no events, no effects.
// Durability is not a flag (decision 157): an actor that declares none of those never touches those rows.
import { Effect, Schema } from "effect"
import { Actor, Connections, Hibernate, Mailbox } from "../framework/Actor.ts"
import { DocId } from "./Doc.ts" // two actors may share an id space: Cursor/doc-1 and Doc/doc-1 are different refs
import { UserId } from "./Principal.ts"

export const Position = Schema.Struct({ line: Schema.Number, column: Schema.Number })
export type Position = typeof Position.Type

export class NotSignedIn extends Schema.TaggedError<NotSignedIn>()("NotSignedIn", {}, { httpApiStatus: 401 }) {
  override get message(): string {
    return `cursors are per user: sign in before moving one`
  }
}

// connection frames: ephemeral in both directions, never persisted
export class Moved extends Schema.TaggedClass<Moved>()("Moved", { userId: UserId, position: Position }) {}
export class Left extends Schema.TaggedClass<Left>()("Left", { userId: UserId }) {}

export const Move = Actor.command("Move", {
  description: "Record the caller's cursor position and broadcast it to every open connection. Fails with NotSignedIn for anonymous callers.",
  input: Position,
  errors: [NotSignedIn]
})
// a stream, not a query: queries run on the caller's node against committed rows and cannot see `vars` (decision 160)
export const Positions = Actor.stream("Positions", {
  description: "The current cursor map, then one element per change. Empty once the activation has hibernated.",
  output: Schema.Record(UserId, Position)
})
// no params and no client frames: the browser only listens
export const Live = Actor.connection("Live", {
  description: "Live cursor session: Moved and Left frames out, nothing in. Never fails.",
  server: Schema.Union([Moved, Left])
})

export const Cursor = Actor.make("Cursor", {
  description: "Live cursor positions for one document. Forgets everything when idle.",
  id: DocId,
  // per-activation memory (decision 160): typed, defaulted from the schema, dropped by `Hibernate.after`
  vars: {
    cursors: Schema.Record(UserId, Position).pipe(Schema.withDecodingDefault(Effect.succeed({})))
  },
  commands: [Move],
  streams: [Positions],
  connections: [Live],
  lifecycle: [
    Hibernate.after("30 seconds"),
    Mailbox.capacity(1000),
    // open sockets do not keep the activation resident; the edge parks them and the next frame wakes it (decision 163)
    Connections.park
  ]
})
