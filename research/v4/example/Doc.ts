// Contract file: a collaborative document. Shows blobs (an update-log CRDT) next to keyed state and a table.
import { Effect, Schema } from "effect"
import { Actor, Events, Hibernate, State } from "../framework/Actor.ts"

export const DocId = Schema.String.pipe(Schema.brand("DocId"))
export type DocId = typeof DocId.Type

export class Revision extends Schema.Class<Revision>("Revision")({
  seq: Schema.Number,
  at: Schema.DateTimeUtc,
  by: Schema.String
}) {}

export class Updated extends Schema.TaggedClass<Updated>()("Updated", { seq: Schema.Number }) {}
export class Renamed extends Schema.TaggedClass<Renamed>()("Renamed", { title: Schema.String }) {}

// the revision index is a normal actor-owned table: small rows, queryable with plain SQL
export const revisions = Actor.table("doc_revisions", {
  seq: "integer",
  by: "text",
  at: "timestamptz"
})

// the document bytes themselves live outside the state cap, in actor_blobs
export const doc = Actor.blob("doc")

export const ApplyUpdate = Actor.command("ApplyUpdate", {
  description: "Append one CRDT update to the document and return its new revision number. Never fails; a malformed update is still stored and folded on the next wake.",
  input: { update: Schema.Uint8ArrayFromBase64 }, // base64 over the wire, Uint8Array in the handler
  output: Schema.Number
})
export const Rename = Actor.command("Rename", {
  description: "Set the document title. Always succeeds; the previous title is replaced.",
  input: { title: Schema.String }
})
// internal: folds the update log into one blob. A write, so it is a turn (decision 136), never a wake hook.
export const Compact = Actor.command("Compact", {
  description: "Fold the appended updates into one blob. Sent by the actor to itself; not reachable from outside."
})
export const Snapshot = Actor.query("Snapshot", {
  description: "The committed title, revision and document bytes. Reads the caller's node and never wakes the actor.",
  output: Schema.Struct({
    title: Schema.String,
    revision: Schema.Number,
    bytes: Schema.Option(Schema.Uint8ArrayFromBase64)
  })
})

export const Doc = Actor.make("Doc", {
  description: "A collaborative document. The bytes are one blob written as an append-only update log; the title and revision are keyed state.",
  id: DocId,
  commands: [ApplyUpdate, Rename, Compact],
  internal: [Compact],
  queries: [Snapshot],
  events: [Updated, Renamed],
  tables: [revisions],
  blobs: [doc],
  state: {
    revision: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("Untitled")))
  },
  lifecycle: [
    Hibernate.after("2 minutes"),
    Events.keep("forever"), // the update log is the audit trail: events are never purged
    State.maxBytes("8 KiB") // the bytes are in the blob, so the state stays tiny
  ]
})
