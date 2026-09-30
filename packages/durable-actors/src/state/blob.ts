import type { Cause, Effect, Option, Stream } from "effect"
import type { InvalidContentRef } from "../errors/content.ts"
import type { ContentEntry, ContentRef } from "../identity/content.ts"
import type { AnyBlob, AnyContent } from "../members/blob.ts"
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

/**
 * Off-turn access to the content the current actor references. A read never
 * returns partial bytes: content swept after its reference was resolved reads
 * as a missing name.
 */
export interface ContentRead {
  /** The referenced content's bytes; none when the actor holds no reference under `name`. */
  readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>>
  /**
   * The referenced content's bytes in chunks from one snapshot, so a
   * concurrent sweep never truncates them. A missing name fails before any
   * chunk with `NoSuchElementError`.
   */
  readonly stream: (name: string) => Stream.Stream<Uint8Array, Cause.NoSuchElementError>
  /** Every reference under this blob, by name. */
  readonly list: Effect.Effect<ReadonlyArray<ContentEntry>>
}

/**
 * Turn-bound references to shared content. Writes touch only the actor's own
 * rows and commit or roll back with the turn; a turn never sees content bytes.
 */
export interface ContentWrite {
  /**
   * References the content `ref` names under `name`, replacing any earlier
   * reference. Fails `InvalidContentRef` unless `ref.grant` was issued by this
   * deployment for this tenant, hash, and size, and stays valid past the skew margin.
   */
  readonly attach: (name: string, ref: ContentRef) => Effect.Effect<void, InvalidContentRef>
  /** Drops the reference under `name`; dropping a missing one does nothing. */
  readonly detach: (name: string) => Effect.Effect<void>
  /** Every reference under this blob, by name, including this turn's changes. */
  readonly list: Effect.Effect<ReadonlyArray<ContentEntry>>
}

/** What `read.blob(B)` returns for a declared blob `B`. */
export type BlobReadOf<B extends AnyBlob> = B extends AnyContent ? ContentRead : BlobRead

/** What `turn.blob(B)` returns for a declared blob `B`. */
export type BlobWriteOf<B extends AnyBlob> = B extends AnyContent ? ContentWrite : BlobWrite

/** Whose blob entries a capability reaches and how long it lives, as for owned tables. */
export interface BlobScope extends Omit<TableScope, "tables"> {
  /** The blobs the actor type declares; `blob` refuses any other. */
  readonly blobs: ReadonlyArray<AnyBlob>
  /** Bytes all of the actor's entries may hold together: `policy.maxBlobBytes`. */
  readonly maxBytes: number
  /** Entries and content references of all the actor's blobs together: `policy.maxBlobEntries`. */
  readonly maxEntries: number
  /** `executionTimeout`: how long a content stream may hold its snapshot. */
  readonly timeoutMs: number
}

/** Turn-bound access returns the write interfaces; read access only the read ones. */
export type BlobAccess = (blob: AnyBlob) => BlobRead | BlobWrite | ContentRead | ContentWrite
