import { Effect, Layer, Result } from "effect"
import { PageDocuments } from "../handlers/page-tree.ts"
import { Checkpoints } from "../snapshots/checkpoint.ts"
import { Entry, EntryCodec } from "../execution/entries.ts"
import type { GcOptions } from "./gc.ts"
import { type CheckOptions, checkBucket } from "./check.ts"
import { fileSystemBucket } from "./file-system.ts"
import { memoryBucket } from "./memory.ts"
import { type S3Options, s3Bucket } from "./s3.ts"
import { Store, storeOf, type StoreOptions } from "./service.ts"

export { Store, type StoreOptions }

/**
 * A store in an S3-compatible bucket. The server entry exposes this module as
 * the `Store` namespace, so a build that never reads `Store.s3` drops it, and
 * with it every AWS SDK module, even without code splitting.
 */
export const s3 = (options: S3Options & StoreOptions) =>
  Layer.effect(Store, Effect.flatMap(s3Bucket(options), storeOf(options)))

/** A store in a local directory, for `akter dev` and tests. */
export const fileSystem = (directory: string, options: StoreOptions = {}) =>
  Layer.effect(Store, Effect.flatMap(fileSystemBucket(directory), storeOf(options)))

/** A store in process memory; not durable. */
export const memory = (options: StoreOptions = {}) =>
  Layer.effect(Store, storeOf(memoryBucket(), options))

/** Runs the conformance probe against the provided store's bucket. */
export const check = (options?: CheckOptions) => Store.use((store) => store.check(options))

/** Collects engine pages and expired checkpoints with the store-wide publication barrier. */
export const collect = (options: Omit<GcOptions, "references" | "entryReferences"> = {}) =>
  Store.use((store) =>
    store.gc.collect({
      ...options,
      references: (bytes) => {
        try {
          return PageDocuments.references(bytes)
        } catch (error) {
          if (Result.isSuccess(Checkpoints.decode(bytes))) return []
          throw error
        }
      },
      entryReferences: (bytes) => {
        const entry = Result.getOrThrow(EntryCodec.decode(bytes))
        if (Entry.guards.Replayed(entry) && entry.page !== undefined) return [entry.page]
        return Entry.guards.Forked(entry) ? [entry.manifest] : []
      },
    }),
  )

/**
 * Runs the conformance probe against an S3-compatible bucket without opening a
 * store in it: nothing is written outside the probe's own `check/` prefix, so
 * a bucket can be tried before it holds a store.
 */
export const checkS3 = (options: S3Options, check?: CheckOptions) =>
  Effect.flatMap(s3Bucket(options), (bucket) => checkBucket(bucket)(check))

/** {@link checkS3} for a local directory. */
export const checkFileSystem = (directory: string, check?: CheckOptions) =>
  Effect.flatMap(fileSystemBucket(directory), (bucket) => checkBucket(bucket)(check))
