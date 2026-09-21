// Server file: blob appends inside the turn transaction, folded back into one blob by an internal command.
import { Effect, Option } from "effect"
import { doc, Doc, Renamed, revisions, Updated } from "./Doc.ts"

// a real app would use Y.mergeUpdates here; the shape is what matters
const mergeUpdates = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export const DocLive = Doc.toLayer({
  ApplyUpdate: Effect.fn(function*(ctx, { update }) {
    const seq = ctx.state.revision + 1
    // update-log CRDT: appended in the turn transaction
    yield* ctx.blob(doc).append(update)
    yield* ctx.rows(revisions).insert({
      seq,
      by: Option.getOrElse(Option.map(ctx.principal, (p) => p.userId), () => "system"),
      at: ctx.now
    })
    yield* ctx.state.set({ revision: seq }) // only the dirty key is written at commit
    yield* ctx.emit(new Updated({ seq }))
    // bounded maintenance: every 100 updates, fold the log in its own turn (decision 136).
    // Intents commit with this turn, so a crash never loses the compaction request.
    if (seq % 100 === 0) yield* ctx.self.Compact.send()
    return seq
  }),
  Rename: (ctx, { title }) => ctx.state.set({ title }).pipe(Effect.andThen(ctx.emit(new Renamed({ title })))),
  // a write, so it is a fenced turn like any other; `mergeUpdates` would be Y.mergeUpdates in a real app
  Compact: (ctx) => ctx.blob(doc).compact(mergeUpdates)
}, {
  // wake hooks read the committed snapshot and may only schedule work; a cold start with a long log asks for one fold
  hooks: [Doc.onWake((ctx) => ctx.state.revision % 100 === 0 ? Effect.void : ctx.self.Compact.send())]
})

// committed snapshot on the caller's node: no activation is woken, `ctx.blob(doc)` is read-only here
export const DocReads = Doc.toQueryLayer({
  Snapshot: (ctx) =>
    Effect.map(ctx.blob(doc).get, (bytes) => ({ title: ctx.state.title, revision: ctx.state.revision, bytes }))
})
