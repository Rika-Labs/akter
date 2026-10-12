import { Effect, Layer } from "effect"
import type { CheckOptions } from "./check.ts"
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
