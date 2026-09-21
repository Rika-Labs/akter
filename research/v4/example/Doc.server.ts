// Server file: blob appends inside the turn transaction, folded back into one blob on wake.
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
    // update-log CRDT: appended in the turn transaction, folded on wake
    yield* ctx.blob(doc).append(update)
    yield* ctx.rows(revisions).insert({
      seq,
      by: Option.getOrElse(Option.map(ctx.principal, (p) => p.userId), () => "system"),
      at: ctx.now
    })
    yield* ctx.state.set({ revision: seq }) // only the dirty key is written at commit
    yield* ctx.emit(new Updated({ seq }))
    return seq
  }),
  Rename: (ctx, { title }) => ctx.state.set({ title }).pipe(Effect.andThen(ctx.emit(new Renamed({ title }))))
}, {
  // folds the appended updates into one blob; `mergeUpdates` would be Y.mergeUpdates in a real app
  hooks: [Doc.onWake((ctx) => ctx.blob(doc).compact(mergeUpdates))]
})

// committed snapshot on the caller's node: no activation is woken, `ctx.blob(doc)` is read-only here
export const DocReads = Doc.toQueryLayer({
  Snapshot: (ctx) =>
    Effect.map(ctx.blob(doc).get, (bytes) => ({ title: ctx.state.title, revision: ctx.state.revision, bytes }))
})
