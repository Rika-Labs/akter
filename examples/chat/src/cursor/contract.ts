import { Actor } from "@durable-actors/core"
import { Schema } from "effect"

export const DocId = Schema.NonEmptyString.pipe(Schema.brand("DocId"))

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

export const Joined = Schema.TaggedStruct("Joined", { peer: Peer })

export const Moved = Schema.TaggedStruct("Moved", { connectionId: Schema.String, at: Point })

export const Left = Schema.TaggedStruct("Left", { connectionId: Schema.String })

/**
 * Who is looking at a document and where their cursor is. Positions live in
 * each connection's session, so nothing outlives the connections: the actor
 * has no state, events, or tables, and parks between frames.
 */
export const Live = Actor.connection("Live", {
  params: Schema.Struct({ color: Schema.String }),
  client: Point,
  server: Schema.Union([Here, Joined, Moved, Left]),
  session: Schema.Struct({ user: Schema.String, color: Schema.String, at: Schema.optional(Point) }),
  stampCursor: false,
})

export const Cursor = Actor.make("Cursor", {
  key: DocId,
  api: { Live },
})
