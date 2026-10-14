import { Context, Effect, Layer, Schema } from "effect"
import { Actor, user } from "../../../../packages/akter/src/index.ts"
import { Engine } from "../../../../packages/akter/src/execution/engine.ts"
import { Transports } from "../../../../packages/akter/src/execution/transport.ts"
import type { Bucket } from "../../../../packages/akter/src/store/bucket.ts"
import { Store, storeOf } from "../../../../packages/akter/src/store/service.ts"
import type { StoreOptions } from "../../../../packages/akter/src/store/service.ts"

const Item = Schema.Struct({ id: Schema.Int, at: Schema.Int, text: Schema.String })
export const Library = Actor.make("Library", {
  state: Schema.Struct({
    count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    text: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    items: Actor.list(Item, { key: "id", by: "at" }),
  }),
  actions: {
    fill: Actor.action(Schema.Int),
    change: Actor.action(Schema.Int, { success: Schema.Int }),
    grow: Actor.action(Schema.Int),
    remember: Actor.action(Schema.Int),
    note: Actor.action(Schema.Int, { internal: true }),
    failed: Actor.action({ internal: true }),
  },
  events: { changed: Actor.event(Schema.Int) },
})

export const LibraryLive = Library.toLayer({
  fill: (state, count) => {
    for (let id = 0; id < count; id++)
      state.items.put({ id, at: count - id, text: `${id}:` + "x".repeat(1100) })
    state.count = count
  },
  change: (state, id, { id: fresh, random, emit }) => {
    fresh()
    random()
    state.count += 1
    emit.changed(state.count)
    const old = state.items.get(id)
    if (old !== undefined) state.items.put({ ...old, at: -7, text: "changed" })
    return state.count
  },
  grow: (state, size, { schedule, emit }) => {
    state.count += 17
    state.text = "g".repeat(size)
    schedule("1 day").note(19)
    emit.changed(99)
  },
  remember: (_, amount, { schedule }) => {
    schedule("1 day").note(amount)
  },
  note: (state, amount) => {
    state.count += amount
  },
  failed: () => {},
})

/** A runner with an intentionally tiny cache, making cold reads go through the bucket resolver. */
export const pageRunner = Effect.fnUntraced(function* (
  bucket: Bucket,
  options: StoreOptions & { readonly checkpointEvery?: number; readonly doubleRun?: boolean } = {},
) {
  const store = yield* storeOf(bucket, { shards: 1, writer: "pages", ...options })
  const context = yield* Layer.build(LibraryLive)
  const catalog = {
    actors: new Map([
      [Library.name, { actor: Library, registered: Context.get(context, Library.implementation) }],
    ]),
    shards: 1,
  }
  const engine = yield* Engine.make(catalog, {
    shards: 1,
    policy: "matching",
    maxBatch: 64,
    checkpointEvery: options.checkpointEvery ?? 1,
    pageCacheBytes: 72_000,
    cronSkipIfOlderThan: 3_600_000,
    doubleRun: options.doubleRun ?? true,
    observer: undefined,
  }).pipe(Effect.provideService(Store, store))
  yield* engine.assign([0])
  const transport = Transports.client(engine, user("pages-test"))
  const call = (id: string, member: string, payload: Schema.Json) =>
    transport.call({ actor: Library, id, member, payload })
  const range = (id: string, from?: number, to?: number, limit?: number) =>
    transport.range({ actor: Library, id, member: "items", range: { from, to, limit } })
  return { store, engine, call, range }
})
