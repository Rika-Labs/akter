import { Context, Duration, Effect, Option, Random, Schedule, type Stream } from "effect"
import { dual } from "effect/Function"
import { type Bucket, retryUnavailable } from "./bucket.ts"
import { type CheckOptions, type CheckReport, checkBucket } from "./check.ts"
import { decodeMeta, encodeMeta, FORMAT, type Manifest, type StoreMeta } from "./codec.ts"
import type { CorruptSegment, MissingPage, StaleEpoch, StoreUnavailable } from "./errors.ts"
import type { Faults } from "./faults.ts"
import { META_KEY } from "./keys.ts"
import { bucketLeases, type Leases } from "./leases.ts"
import { bucketLog, type Lease, type StoredSegment } from "./log.ts"
import { bucketPages } from "./pages.ts"

/** How a store is created and how its owners keep their leases honest. */
export interface StoreOptions {
  /** Shards recorded in `meta/store` when this call creates the store; an existing store keeps its count. Default 16. */
  readonly shards?: number
  /** Names this process in the segments it writes. Default: random per store instance. */
  readonly writer?: string
  /** How long an owner may append or answer reads without re-checking its lease. Default 10 seconds. */
  readonly validFor?: Duration.Input
  /** How long a checkpoint must have been known before trim deletes the segments it covers; well above `validFor`. Default 10 minutes. */
  readonly trimAfter?: Duration.Input
  /** Retries for unavailable responses; a retried create-once write repeats the same bytes. Default: up to 5 retries, exponential from 50 ms with jitter. */
  readonly retry?: Schedule.Schedule<unknown, unknown>
  /** Faults injected between the store and its bucket, for tests and the simulator. */
  readonly faults?: Faults
}

const DEFAULT_SHARDS = 16

const DEFAULT_RETRY: Schedule.Schedule<unknown, unknown> = Schedule.max([
  Schedule.exponential("50 millis").pipe(Schedule.jittered),
  Schedule.recurs(5),
])

const randomHex = Effect.map(
  Effect.all([Random.nextIntBetween(0, 0xffff_ffff), Random.nextIntBetween(0, 0xffff_ffff)]),
  ([high, low]) => `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`,
)

/**
 * Everything durable in one bucket: each shard's log, checkpoint manifests,
 * content-addressed pages, the store's identity record and lease objects.
 * Owners write a shard's log only through a {@link Lease} from `open`, and a
 * write from any owner but the newest fails with `StaleEpoch`.
 */
export class Store extends Context.Service<
  Store,
  {
    readonly meta: StoreMeta
    /** Opens a shard: fences every earlier owner and returns the new lease. */
    readonly open: (
      shard: number,
    ) => Effect.Effect<Lease, StaleEpoch | StoreUnavailable | CorruptSegment>
    /** Appends one batch of encoded entries at `head + 1` and returns its offset. */
    readonly append: (
      lease: Lease,
      batch: ReadonlyArray<Uint8Array>,
    ) => Effect.Effect<bigint, StaleEpoch | StoreUnavailable>
    /** The shard's segments after `from`, in offset order. */
    readonly read: (
      shard: number,
      from: bigint,
    ) => Stream.Stream<StoredSegment, StoreUnavailable | CorruptSegment>
    /** Records a checkpoint through `manifest.offset`; write its pages first. */
    readonly checkpoint: (
      lease: Lease,
      manifest: Manifest,
    ) => Effect.Effect<void, StaleEpoch | StoreUnavailable>
    /** Deletes segments at or below `through` that an old enough checkpoint covers; returns the offset deleted through, 0 for none. */
    readonly trim: (
      lease: Lease,
      through: bigint,
    ) => Effect.Effect<bigint, StaleEpoch | StoreUnavailable>
    /** Succeeds while the lease is current: at once within `validFor` of its last append or check, otherwise after re-checking the bucket. */
    readonly verify: (lease: Lease) => Effect.Effect<void, StaleEpoch | StoreUnavailable>
    /** Stores a page and returns its hash. */
    readonly putPage: (bytes: Uint8Array) => Effect.Effect<string, StoreUnavailable>
    /** Loads a page by hash; concurrent loads are batched. */
    readonly getPage: (
      hash: string,
    ) => Effect.Effect<Uint8Array, MissingPage | CorruptSegment | StoreUnavailable>
    readonly leases: Leases
    /** Runs the conformance probe against this store's bucket. */
    readonly check: (options?: CheckOptions) => Effect.Effect<CheckReport, StoreUnavailable>
  }
>()("@rikalabs/akter/store/service/Store") {}

/** Reads `meta/store`, creating it if this is the store's first start. */
const establish = (
  bucket: Bucket,
  retrying: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  shards: number,
) =>
  Effect.gen(function* () {
    const existing = yield* retrying(bucket.get(META_KEY))
    if (Option.isSome(existing)) return yield* decodeMeta(META_KEY)(existing.value)
    const created: StoreMeta = { format: FORMAT, store: yield* randomHex, shards }
    if (yield* retrying(bucket.create(META_KEY, yield* encodeMeta(created)))) return created
    const winner = yield* retrying(bucket.get(META_KEY))
    if (Option.isNone(winner))
      return yield* Effect.die(new Error("meta/store vanished after another process created it"))
    return yield* decodeMeta(META_KEY)(winner.value)
  })

/** The store over a bucket. */
export const storeOf: {
  (
    options: StoreOptions,
  ): (raw: Bucket) => Effect.Effect<Store["Service"], StoreUnavailable | CorruptSegment>
  (
    raw: Bucket,
    options: StoreOptions,
  ): Effect.Effect<Store["Service"], StoreUnavailable | CorruptSegment>
} = dual(2, (raw: Bucket, options: StoreOptions) =>
  Effect.gen(function* () {
    const bucket = options.faults === undefined ? raw : options.faults.wrap(raw)
    const retry = options.retry ?? DEFAULT_RETRY
    const validFor = Duration.toMillis(Duration.fromInputUnsafe(options.validFor ?? "10 seconds"))
    const trimAfter = Duration.toMillis(Duration.fromInputUnsafe(options.trimAfter ?? "10 minutes"))
    if (trimAfter <= validFor)
      return yield* Effect.die(new RangeError("trimAfter must be longer than validFor"))
    const meta = yield* establish(bucket, retryUnavailable(retry), options.shards ?? DEFAULT_SHARDS)
    const writer = options.writer ?? (yield* randomHex)
    return Store.of({
      meta,
      ...bucketLog({ bucket, retry, writer, shards: meta.shards, validFor, trimAfter }),
      ...bucketPages({ bucket, retry }),
      leases: bucketLeases({ bucket, retry }),
      check: checkBucket(bucket),
    })
  }),
)
