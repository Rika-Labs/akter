// Contract file: an ephemeral actor — live cursors, no tables, no events, no effects, no durable state.
import { Effect, Schema } from "effect"
import { Actor, Hibernate, Mailbox } from "../framework/Actor.ts"
import { DocId } from "./Doc.ts" // an ephemeral actor can share an id with a durable one
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
export const Positions = Actor.query("Positions", {
  description: "Every known cursor position, keyed by user id. Empty once the activation has hibernated.",
  output: Schema.Record(UserId, Position)
})
// no params and no client frames: the browser only listens
export const Live = Actor.connection("Live", {
  description: "Live cursor session: Moved and Left frames out, nothing in. Never fails.",
  server: Schema.Union([Moved, Left])
})

export const Cursor = Actor.ephemeral("Cursor", {
  description: "Live cursor positions for one document. Forgets everything when idle.",
  id: DocId,
  // the only state there is: a closure on the activation, dropped by `Hibernate.after`
  memory: {
    cursors: Schema.Record(UserId, Position).pipe(Schema.withDecodingDefault(Effect.succeed({})))
  },
  commands: [Move],
  queries: [Positions],
  connections: [Live],
  // no tables, events, effects or state to govern: an ephemeral actor rejects those policies
  lifecycle: [Hibernate.after("30 seconds"), Mailbox.capacity(1000)]
})
