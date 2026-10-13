import { Data, Effect, Predicate, Result, Schema } from "effect"
import { SchemaBinary } from "effect/encoding"
import type { Store } from "../store/service.ts"
import { PageCorrupt } from "../store/errors.ts"

/** A synchronous handler stops here; its owner resolves every missing hash before rerunning it. */
export class PageMiss extends Data.TaggedError("PageMiss")<{
  readonly hashes: ReadonlyArray<string>
}> {}

/** Every engine page carries explicit edges so collection never guesses at application data. */
const Document = Schema.Struct({
  kind: Schema.Literals(["leaf", "branch", "actor", "checkpoint"]),
  references: Schema.Array(Schema.String),
  value: Schema.Json,
})
const binary = SchemaBinary.toCodec(Document)
const encode = Schema.encodeResult(binary)
const decode = Schema.decodeResult(binary)

/** A scalar key, or an ordering tuple whose final component breaks ties. */
export type Key = ReadonlyArray<string | number>
export type Tree = string | Leaf | Branch
interface Leaf {
  readonly kind: "leaf"
  readonly entries: ReadonlyArray<readonly [Key, Schema.Json]>
}
interface Child {
  readonly min: Key
  readonly max: Key
  readonly tree: Tree
}
interface Branch {
  readonly kind: "branch"
  readonly children: ReadonlyArray<Child>
}
type Node = Leaf | Branch
const OrderedKey = Schema.Array(Schema.Union([Schema.String, Schema.Finite]))
const StoredEntries = Schema.Array(Schema.Tuple([OrderedKey, Schema.Json]))
const StoredChildren = Schema.Array(
  Schema.Struct({ min: OrderedKey, max: OrderedKey, tree: Schema.String }),
)
const json = Schema.decodeResult(Schema.fromJsonString(Schema.Json))
const text = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))

/** Encoded engine metadata may carry absent optional fields before its JSON normalization. */
type PageValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<PageValue>
  | { readonly [key: string]: PageValue }

/** Binary page envelopes and their complete reachability edges. */
export const PageDocuments = {
  json: (value: PageValue): Schema.Json => Result.getOrThrow(json(Result.getOrThrow(text(value)))),
  encode: (document: typeof Document.Type): Uint8Array => Result.getOrThrow(encode(document)),
  decode: (bytes: Uint8Array): typeof Document.Type => Result.getOrThrow(decode(bytes.slice())),
  parse: (bytes: Uint8Array) => decode(bytes.slice()),
  references: (bytes: Uint8Array): ReadonlyArray<string> =>
    Result.getOrThrow(decode(bytes.slice())).references,
}

/** A byte-bounded LRU plus an invocation-local working set; dirty trees never enter the cache. */
export class PageCache {
  readonly maximum: number
  readonly #pages = new Map<string, Uint8Array>()
  #bytes = 0
  #working: Map<string, Uint8Array> | undefined

  constructor(maximum = 16 * 1024 * 1024) {
    this.maximum = maximum
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new RangeError("Invalid page cache bound")
  }

  get size(): number {
    return this.#bytes
  }

  get(hash: string): Uint8Array | undefined {
    const local = this.#working?.get(hash)
    if (local !== undefined) return local
    const bytes = this.#pages.get(hash)
    if (bytes !== undefined) {
      this.#pages.delete(hash)
      this.#pages.set(hash, bytes)
      this.#working?.set(hash, bytes)
    }
    return bytes
  }

  put(hash: string, bytes: Uint8Array): void {
    this.#working?.set(hash, bytes)
    const old = this.#pages.get(hash)
    if (old !== undefined) this.#bytes -= old.length
    this.#pages.delete(hash)
    if (bytes.length <= this.maximum) {
      this.#pages.set(hash, bytes)
      this.#bytes += bytes.length
    }
    while (this.#bytes > this.maximum) {
      const oldest = this.#pages.entries().next().value
      if (oldest === undefined) break
      this.#pages.delete(oldest[0])
      this.#bytes -= oldest[1].length
    }
  }

  clear(): void {
    this.#pages.clear()
    this.#bytes = 0
  }

  resolve<A, E = never>(
    store: Pick<Store["Service"], "getPage">,
    run: () => A,
    before?: Effect.Effect<unknown, E>,
  ): Effect.Effect<A, E | import("../store/errors.ts").StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      const working = new Map<string, Uint8Array>()
      while (true) {
        if (before !== undefined) yield* before
        const attempt = yield* Effect.sync(() => {
          const previous = this.#working
          this.#working = working
          try {
            return { value: run() }
          } catch (error) {
            if (error instanceof PageMiss) return { missing: error.hashes }
            throw error
          } finally {
            this.#working = previous
          }
        })
        if (attempt.missing === undefined) return attempt.value as A
        yield* Effect.forEach(
          Array.from(new Set(attempt.missing)),
          (hash) =>
            Effect.map(store.getPage(hash), (bytes) => {
              working.set(hash, bytes)
              this.put(hash, bytes)
            }),
          { concurrency: 32, discard: true },
        )
      }
    })
  }
}

const compare = (a: Key, b: Key): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i]!
    const right = b[i]!
    if (left < right) return -1
    if (left > right) return 1
  }
  return a.length - b.length
}

const node = (tree: Tree, cache: PageCache): Node => {
  if (!Predicate.isString(tree)) return tree
  const bytes = cache.get(tree)
  if (bytes === undefined) throw new PageMiss({ hashes: [tree] })
  try {
    const document = PageDocuments.decode(bytes)
    if (document.kind === "leaf")
      return {
        kind: "leaf",
        entries: Result.getOrThrow(Schema.decodeUnknownResult(StoredEntries)(document.value)),
      }
    if (document.kind === "branch")
      return {
        kind: "branch",
        children: Result.getOrThrow(Schema.decodeUnknownResult(StoredChildren)(document.value)),
      }
    throw new Error("Expected a list tree page")
  } catch {
    throw PageCorrupt.make({ hash: tree, reason: "Invalid list tree page" })
  }
}

const child = (tree: Node): Child => {
  if (tree.kind === "branch")
    return { tree, min: tree.children[0]!.min, max: tree.children.at(-1)!.max }
  return { tree, min: tree.entries[0]![0], max: tree.entries.at(-1)![0] }
}

const get = (tree: Tree, key: Key, cache: PageCache): Schema.Json | undefined => {
  const loaded = node(tree, cache)
  if (loaded.kind === "leaf")
    return loaded.entries.find(([candidate]) => compare(candidate, key) === 0)?.[1]
  const found = loaded.children.find(
    (part) => compare(part.max, key) >= 0 && compare(part.min, key) <= 0,
  )
  return found === undefined ? undefined : get(found.tree, key, cache)
}

const leafBytes = (entries: Leaf["entries"]): number =>
  PageDocuments.encode({ kind: "leaf", references: [], value: PageDocuments.json(entries) }).length

const split = (next: Node): ReadonlyArray<Child> => {
  if (next.kind === "leaf") {
    if (next.entries.length === 0) return []
    if (next.entries.length > 1 && leafBytes(next.entries) > 64 * 1024) {
      const middle = Math.floor(next.entries.length / 2)
      return [
        child({ kind: "leaf", entries: next.entries.slice(0, middle) }),
        child({ kind: "leaf", entries: next.entries.slice(middle) }),
      ]
    }
  } else {
    if (next.children.length === 0) return []
    if (next.children.length > 64) {
      const middle = Math.floor(next.children.length / 2)
      return [
        child({ kind: "branch", children: next.children.slice(0, middle) }),
        child({ kind: "branch", children: next.children.slice(middle) }),
      ]
    }
  }
  return [child(next)]
}

const change = (
  tree: Tree,
  key: Key,
  value: Schema.Json | undefined,
  cache: PageCache,
): ReadonlyArray<Child> => {
  const loaded = node(tree, cache)
  if (loaded.kind === "leaf") {
    const entries = loaded.entries.filter(([candidate]) => compare(candidate, key) !== 0)
    if (value !== undefined) entries.push([key, value])
    entries.sort(([a], [b]) => compare(a, b))
    return split({ kind: "leaf", entries })
  }
  const children = Array.from(loaded.children)
  let index = children.findIndex((part) => compare(part.max, key) >= 0)
  if (index < 0) index = children.length - 1
  children.splice(index, 1, ...change(children[index]!.tree, key, value, cache))
  return split({ kind: "branch", children })
}

const set = (tree: Tree, key: Key, value: Schema.Json | undefined, cache: PageCache): Tree => {
  const parts = change(tree, key, value, cache)
  if (parts.length === 0) return { kind: "leaf", entries: [] }
  if (parts.length === 1) return parts[0]!.tree
  return { kind: "branch", children: parts }
}

const range = (
  tree: Tree,
  cache: PageCache,
  from?: Key,
  to?: Key,
  reverse = false,
  limit?: number,
): ReadonlyArray<Schema.Json> => {
  if (limit !== undefined && limit <= 0) return []
  const values: Array<Schema.Json> = []
  const missing: Array<string> = []
  const visit = (part: Tree): void => {
    if (limit !== undefined && values.length >= limit) return
    if (Predicate.isString(part) && cache.get(part) === undefined) {
      missing.push(part)
      return
    }
    const loaded = node(part, cache)
    if (loaded.kind === "leaf") {
      const entries = reverse ? Array.from(loaded.entries).reverse() : loaded.entries
      for (const [key, value] of entries) {
        if (
          (from !== undefined && compare(key, from) < 0) ||
          (to !== undefined && compare(key, to) >= 0)
        )
          continue
        values.push(value)
        if (limit !== undefined && values.length >= limit) return
      }
    } else {
      const children = reverse ? Array.from(loaded.children).reverse() : loaded.children
      for (const next of children) {
        if (
          (from !== undefined && compare(next.max, from) < 0) ||
          (to !== undefined && compare(next.min, to) >= 0)
        )
          continue
        visit(next.tree)
      }
    }
  }
  visit(tree)
  if (missing.length > 0) throw new PageMiss({ hashes: missing })
  return values
}

const persist = (
  tree: Tree,
  store: Store["Service"],
  cache: PageCache,
): Effect.Effect<string, import("../store/errors.ts").StorageUnavailable> => {
  if (Predicate.isString(tree)) return Effect.succeed(tree)
  return Effect.gen(function* () {
    let document: typeof Document.Type
    if (tree.kind === "leaf")
      document = { kind: "leaf", references: [], value: PageDocuments.json(tree.entries) }
    else {
      const children = yield* Effect.forEach(
        tree.children,
        (part) =>
          Effect.map(persist(part.tree, store, cache), (hash) => ({
            min: part.min,
            max: part.max,
            tree: hash,
          })),
        { concurrency: 16 },
      )
      document = {
        kind: "branch",
        references: children.map((part) => part.tree),
        value: PageDocuments.json(children),
      }
    }
    const bytes = PageDocuments.encode(document)
    const hash = yield* store.putPage(bytes)
    cache.put(hash, bytes)
    return hash
  })
}

/** Persistent copy-on-write B+ trees: key lookup and ordered range reads load only their paths. */
export const PageTrees = { empty: { kind: "leaf", entries: [] } as Tree, get, set, range, persist }
