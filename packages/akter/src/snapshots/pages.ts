import { Effect, Result, Schema } from "effect"
import { Durable } from "../execution/durable.ts"
import type { ShardImage } from "../execution/durable.ts"
import { Layouts } from "../execution/layout.ts"
import type { Image } from "../execution/layout.ts"
import { Lists, PagedItems } from "../handlers/lists.ts"
import { PageCache, PageDocuments, PageMiss, PageTrees } from "../handlers/page-tree.ts"
import type { Store } from "../store/service.ts"
import { PageCorrupt } from "../store/errors.ts"
import { Checkpoints } from "./checkpoint.ts"
import type { Checkpoint } from "./checkpoint.ts"
import { pendingClocks } from "../execution/workflow.ts"

/** Prepares changed list paths and actor manifests before publishing their checkpoint root. */
const write = (image: ShardImage, store: Store["Service"], cache: PageCache) =>
  Effect.gen(function* () {
    const checkpoint = Checkpoints.capture(image, false)
    const images = new Map(Array.from(image.actors, ([address, record]) => [address, record.image]))
    const replacements = new Map<string, { before: Image; after: Image }>()
    const roots: Array<string> = []
    for (const snapshot of checkpoint.actors) {
      const address = Durable.addressOf(snapshot.actor, snapshot.key)
      const record = image.actors.get(address)!
      const before = images.get(address)!
      const layout = Layouts.of(record.actor)
      const lists = new Map(before.lists)
      const saved: Array<Checkpoint["actors"][number]["lists"][number]> = []
      const references: Array<string> = []
      for (const [field, list] of layout.lists) {
        const items = before.lists.get(field) ?? Lists.empty
        const tree =
          items instanceof PagedItems
            ? items
            : new PagedItems(
                PageTrees.empty,
                PageTrees.empty,
                cache,
                list.ordering,
                list.item,
              ).apply({ put: Lists.all(items, list.ordering), delete: [] })
        const keys = yield* PageTrees.persist(tree.keys, store, cache)
        const ordered = yield* PageTrees.persist(tree.ordered, store, cache)
        references.push(keys, ordered)
        saved.push({ field, items: [], keys, ordered })
        lists.set(field, new PagedItems(keys, ordered, cache, list.ordering, list.item))
      }
      const bytes = PageDocuments.encode({
        kind: "actor",
        references,
        value: PageDocuments.json({ ...snapshot, lists: saved }),
      })
      roots.push(yield* store.putPage(bytes))
      replacements.set(address, { before, after: { ...before, lists } })
    }
    const hash = yield* store.putPage(
      PageDocuments.encode({
        kind: "checkpoint",
        references: roots,
        value: PageDocuments.json({ ...checkpoint, actors: [] }),
      }),
    )
    return {
      hash,
      offset: checkpoint.offset,
      nextDue: (() => {
        let earliest: number | undefined
        for (const { timer } of checkpoint.timers)
          if (earliest === undefined || timer.at < earliest) earliest = timer.at
        for (const job of checkpoint.jobs)
          for (const at of pendingClocks(job.workflow))
            if (earliest === undefined || at < earliest) earliest = at
        return earliest
      })(),
      committed: () => {
        for (const record of image.actors.values()) {
          const replacement = replacements.get(record.address)
          if (replacement !== undefined && record.image === replacement.before)
            record.image = replacement.after
        }
      },
    }
  })

/** Reads only shard metadata and actor manifests; list roots remain lazy. */
const read = (hash: string, store: Pick<Store["Service"], "getPage">) =>
  Effect.gen(function* () {
    const bytes = yield* store.getPage(hash)
    const parsed = PageDocuments.parse(bytes)
    if (Result.isFailure(parsed)) return bytes
    const document = parsed.success
    if (document.kind !== "checkpoint")
      return yield* Effect.die(PageCorrupt.make({ hash, reason: "Expected checkpoint page" }))
    const actors = yield* Effect.forEach(
      document.references,
      (actorHash) =>
        Effect.map(store.getPage(actorHash), (actorBytes) => {
          try {
            const actor = PageDocuments.decode(actorBytes)
            if (actor.kind !== "actor") throw new Error("Expected actor manifest")
            return actor.value
          } catch {
            throw PageCorrupt.make({ hash: actorHash, reason: "Invalid actor manifest" })
          }
        }),
      { concurrency: 32 },
    )
    const metadata = Result.getOrThrow(
      Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(document.value),
    )
    const validated = Checkpoints.decodeValue({ ...metadata, actors })
    if (Result.isFailure(validated))
      return yield* Effect.die(PageCorrupt.make({ hash, reason: validated.failure.message }))
    return Checkpoints.encode(validated.success)
  })

/** Materializes a checkpoint for independent replay evidence, not for owner recovery. */
const materialize = (hash: string, store: Pick<Store["Service"], "getPage">) =>
  Effect.gen(function* () {
    const bytes = yield* read(hash, store)
    const checkpoint = Result.getOrThrow(Checkpoints.decode(bytes))
    const cache = new PageCache()
    const actors = yield* Effect.forEach(checkpoint.actors, (snapshot) =>
      cache.resolve(store, () => ({
        ...snapshot,
        lists: snapshot.lists.map((list) => ({
          field: list.field,
          items: list.ordered === undefined ? list.items : PageTrees.range(list.ordered, cache),
        })),
      })),
    )
    return Checkpoints.encode({ ...checkpoint, actors })
  })

/** Recovery resolves a replay image synchronously with the same invocation-local page working set. */
const cached = (hash: string, cache: PageCache): Uint8Array => {
  const load = (key: string) => {
    const bytes = cache.get(key)
    if (bytes === undefined) throw new PageMiss({ hashes: [key] })
    return PageDocuments.decode(bytes)
  }
  const root = load(hash)
  if (root.kind !== "checkpoint")
    throw PageCorrupt.make({ hash, reason: "Expected checkpoint page" })
  const actors = root.references.map((key) => {
    const actor = load(key)
    if (actor.kind !== "actor")
      throw PageCorrupt.make({ hash: key, reason: "Expected actor manifest" })
    return actor.value
  })
  const metadata = Result.getOrThrow(
    Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(root.value),
  )
  const validated = Checkpoints.decodeValue({ ...metadata, actors })
  if (Result.isFailure(validated))
    throw PageCorrupt.make({ hash, reason: "Invalid checkpoint page" })
  return Checkpoints.encode(validated.success)
}

/** Page-backed checkpoint upload and metadata-only restoration. */
export const PagedCheckpoints = { write, read, materialize, cached }
