import { Actor } from "@durable-actors/core"
import { Effect, Layer, Option, Schema } from "effect"

export const documents = Actor.blob("documents")

const cache = new Map<string, Uint8Array>()

/**
 * Seeded pseudo-random bytes, built once per size and variant: incompressible,
 * like encrypted or already compressed attachments, and never part of the
 * command payload, so a turn's cost is the blob write alone.
 */
const bytesOf = (size: number, variant: number) => {
  const key = `${size}:${variant}`
  const cached = cache.get(key)

  if (cached !== undefined) return cached
  const bytes = new Uint8Array(size)
  let state = (size * 31 + variant) >>> 0

  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    bytes[index] = state >>> 24
  }

  cache.set(key, bytes)

  return bytes
}

const Write = Schema.Struct({ name: Schema.String, size: Schema.Int, variant: Schema.Int })

export const Put = Actor.command("Put", { input: Write })

export const Add = Actor.command("Add", { input: Write })

export const Compact = Actor.command("Compact", { input: Schema.String })

export const Length = Actor.query("Length", { input: Schema.String, output: Schema.Int })

/** Writes and reads its own entries of `documents` through `turn.blob` and `read.blob`. */
export const Archive = Actor.make("Archive", {
  key: Schema.NonEmptyString,
  blobs: [documents],
  api: { Put, Add, Compact, Length },
})

const ArchiveCommands = Archive.toLayer(
  Effect.succeed({
    Put: Effect.fnUntraced(function* ({ name, size, variant }) {
      yield* (yield* Archive.Turn).blob(documents).set(name, bytesOf(size, variant))
    }),
    Add: Effect.fnUntraced(function* ({ name, size, variant }) {
      yield* (yield* Archive.Turn).blob(documents).append(name, bytesOf(size, variant))
    }),
    Compact: Effect.fnUntraced(function* (name: string) {
      yield* (yield* Archive.Turn).blob(documents).compact(name)
    }),
  }),
)

// Returns the length, not the bytes, so the reply's encoding is not the measured cost.
const ArchiveReads = Archive.toQueryLayer(
  Effect.succeed({
    Length: Effect.fnUntraced(function* (name: string) {
      const found = yield* (yield* Archive.Read).blob(documents).get(name)

      return Option.match(found, { onNone: () => -1, onSome: (bytes) => bytes.byteLength })
    }),
  }),
)

export const ArchiveLive = Layer.mergeAll(ArchiveCommands, ArchiveReads)
