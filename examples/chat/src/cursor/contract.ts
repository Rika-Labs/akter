import { Actor } from "@durable-actors/core"
import { Schema } from "effect"
import { signedIn } from "../access.ts"

/** A document's key: a non-empty string. */
export const DocId = Schema.NonEmptyString.pipe(Schema.brand("DocId"))

/** A cursor position. */
export const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite })

/** One open connection as the others see it; `at` is absent until its first move. */
export const Peer = Schema.Struct({
  connectionId: Schema.String,
  user: Schema.String,
  color: Schema.String,
  at: Schema.optional(Point),
})

/** Everyone already here, sent once to a connection that opens or resyncs. */
export const Here = Schema.TaggedStruct("Here", { peers: Schema.Array(Peer) })

/** A connection opened; sent to the others. */
export const Joined = Schema.TaggedStruct("Joined", { peer: Peer })

/** A connection's cursor moved; sent to the others. */
export const Moved = Schema.TaggedStruct("Moved", { connectionId: Schema.String, at: Point })

/** A connection closed; sent to the others. */
export const Left = Schema.TaggedStruct("Left", { connectionId: Schema.String })

/**
 * Who is looking at a document and where their cursor is. Positions live in
 * each connection's session, so nothing outlives the connections: the actor
 * has no state, events, or tables, and parks between frames.
 */
export const Live = Actor.connection("Live", {
  payload: { color: Schema.String },
  client: Point,
  server: Schema.Union([Here, Joined, Moved, Left]),
  session: Schema.Struct({ user: Schema.String, color: Schema.String, at: Schema.optional(Point) }),
  stampCursor: false,
})

/** A document whose viewers' cursors are shared over `Live`. */
export const Cursor = Actor.make("Cursor", {
  key: DocId,
  access: signedIn,
  api: { Live },
})
