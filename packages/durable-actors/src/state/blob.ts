import type { Effect, Option } from "effect"
import type { AnyBlob } from "../members/blob.ts"
import type { TableScope } from "../tables/owned.ts"

/** Read-only access to the current actor's entries of one blob. */
export interface BlobRead {
  /** The entry's bytes, every appended chunk in order; none when it was never set. */
  readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>>
}

/** Turn-bound access to the current actor's entries; writes commit or roll back with the turn. */
export interface BlobWrite extends BlobRead {
  /** Replaces the entry with `bytes` as its only chunk. */
  readonly set: (name: string, bytes: Uint8Array) => Effect.Effect<void>
  /** Adds `bytes` as a new chunk after the existing ones, creating the entry if needed. */
  readonly append: (name: string, bytes: Uint8Array) => Effect.Effect<void>
  /** Merges the entry's chunks into one without changing its bytes. */
  readonly compact: (name: string) => Effect.Effect<void>
  /** Removes the entry and its bytes, so `get` returns none; removing a missing entry does nothing. */
  readonly delete: (name: string) => Effect.Effect<void>
}

/** Whose blob entries a capability reaches and how long it lives, as for owned tables. */
export interface BlobScope extends Omit<TableScope, "tables"> {
  /** The blobs the actor type declares; `blob` refuses any other. */
  readonly blobs: ReadonlyArray<AnyBlob>
  /** Bytes all of the actor's entries may hold together: `policy.maxBlobBytes`. */
  readonly maxBytes: number
  /** Entries all of the actor's blobs may hold together: `policy.maxBlobEntries`. */
  readonly maxEntries: number
}

/** Turn-bound access returns `BlobWrite`; read access only `BlobRead`. */
export type BlobAccess = (blob: AnyBlob) => BlobRead
