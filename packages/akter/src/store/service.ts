import { Context, DateTime, Duration, Effect, Option, Random, Schedule, type Stream } from "effect"
import { dual } from "effect/Function"
import { type Bucket, retryUnavailable } from "./bucket.ts"
import { type Application, type Build, runtimeBuild } from "./build.ts"
import { bucketAudit } from "./audit.ts"
import type { AuditRecord } from "./audit.ts"
import { type CheckOptions, type CheckReport, checkBucket } from "./check.ts"
import { decodeMeta, encodeMeta, FORMAT, type Manifest, type StoreMeta } from "./codec.ts"
import {
  type CorruptSegment,
  type LogUnavailable,
  type StaleEpoch,
  type StorageUnavailable,
  StoreMismatch,
} from "./errors.ts"
import type { Faults } from "./faults.ts"
import {
  bucketGc,
  type GcOptions,
  type GcReport,
  type GcStaleEpoch,
  type PagePublicationBusy,
} from "./gc.ts"
import { META_KEY } from "./keys.ts"
import { bucketLeases, type Leases } from "./leases.ts"
import { bucketLog, type HistoryCheckpoint, type Lease, type StoredSegment } from "./log.ts"
import { bucketPages } from "./pages.ts"
import { bucketRetention } from "./retention.ts"
import type {
  HistoryExpired,
  RetentionConflict,
  RetentionRecord,
  RetentionRefused,
  SetRetentionOptions,
} from "./retention.ts"

/** How a store is created and how its owners keep their leases honest. */
export interface StoreOptions {
  /** Shards recorded in `meta/store` when this call creates the store; an existing store with another count is refused. Default: 16 for a new store, the recorded count for an existing one. */
  readonly shards?: number
  /** Initial history retention for a new store only; ignored when reopening. Default: 7 days. Use `setRetention` to change an existing store. */
  readonly retention?: Duration.Input
  /** The application bundle digest and framework version recorded in every segment beside the runtime's own build. Default: both empty. */
  readonly build?: Application
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

const DEFAULT_RETENTION = "7 days"

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
    /** The store's identity record, as created by its first runner. */
    readonly meta: StoreMeta
    readonly build: Build
    /** Reads effective retention from the bucket, falling back to the initial descriptor value. */
    readonly retention: Effect.Effect<number, StorageUnavailable | CorruptSegment>
    /** Atomically changes retention and its audit with a store-wide `retention.set` grant. */
    readonly setRetention: (
      duration: Duration.Input,
      options: SetRetentionOptions,
    ) => Effect.Effect<
      RetentionRecord,
      StorageUnavailable | CorruptSegment | RetentionConflict | RetentionRefused
    >
    /** Reads the recovery point without opening, fencing or activating a shard. */
    readonly recoveryPoint: (shard: number) => Effect.Effect<
      {
        readonly checkpoint: Option.Option<Manifest>
        readonly damaged: ReadonlyArray<CorruptSegment>
      },
      StorageUnavailable | CorruptSegment
    >
    readonly audit: (record: AuditRecord) => Effect.Effect<void, StorageUnavailable>
    readonly audits: Effect.Effect<ReadonlyArray<AuditRecord>, StorageUnavailable | CorruptSegment>
    /** Opens a shard from its newest intact checkpoint: fences every earlier owner and returns the new lease. */
    readonly open: (
      shard: number,
    ) => Effect.Effect<Lease, StaleEpoch | LogUnavailable | CorruptSegment>
    /** Appends one batch of encoded entries at `head + 1` and returns its offset. */
    readonly append: (
      lease: Lease,
      batch: ReadonlyArray<Uint8Array>,
    ) => Effect.Effect<bigint, StaleEpoch | LogUnavailable>
    /** The shard's segments after `from`, in offset order. */
    readonly read: (
      shard: number,
      from: bigint,
    ) => Stream.Stream<StoredSegment, LogUnavailable | CorruptSegment>
    /** Records a checkpoint through `manifest.offset`; write its pages first. */
    readonly checkpoint: (
      lease: Lease,
      manifest: Manifest,
    ) => Effect.Effect<void, StaleEpoch | LogUnavailable>
    /** Deletes the expired history prefix at or below `through` that an old enough checkpoint covers; returns the offset deleted through, 0 for none. */
    readonly trim: (
      lease: Lease,
      through: bigint,
    ) => Effect.Effect<bigint, StaleEpoch | LogUnavailable | CorruptSegment>
    /** Succeeds while the lease is current: at once within `validFor` of its last append or check, otherwise after re-checking the bucket. */
    readonly verify: (lease: Lease) => Effect.Effect<void, StaleEpoch | LogUnavailable>
    /**
     * True while `verify` would succeed without a bucket call: the lease is open and within
     * `validFor` of its last append or check. An owner answers reads from memory only while this
     * holds, so its read window is the store's own and the two can never disagree.
     */
    readonly fresh: (lease: Lease) => Effect.Effect<boolean>
    /** Stores a page and returns its hash. */
    readonly putPage: (bytes: Uint8Array) => Effect.Effect<string, StorageUnavailable>
    /** Loads a page by hash; concurrent loads are batched. A page that is absent or does not match its hash is the `PageCorrupt` defect. */
    readonly getPage: (hash: string) => Effect.Effect<Uint8Array, StorageUnavailable>
    readonly leases: Leases
    readonly gc: {
      /** Marks retained checkpoints and log references, then removes expired checkpoints and unreachable old pages. */
      readonly collect: (
        options: GcOptions,
      ) => Effect.Effect<GcReport, GcStaleEpoch | StorageUnavailable | CorruptSegment>
      /** Holds the store-wide barrier from page uploads through the durable checkpoint or fork reference; unknown publication failures stay blocked. */
      readonly protect: <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ) => Effect.Effect<
        A,
        E | PagePublicationBusy | GcStaleEpoch | StorageUnavailable | CorruptSegment,
        R
      >
    }
    readonly history: {
      /** Checkpoints within retention plus the newest per shard, in ascending offset order. */
      readonly checkpoints: (
        shard: number,
      ) => Effect.Effect<ReadonlyArray<HistoryCheckpoint>, LogUnavailable | CorruptSegment>
      /** Retained log objects after `from` through an optional inclusive upper offset; does not load any later segment. */
      readonly read: (
        shard: number,
        from: bigint,
        through?: bigint,
      ) => Stream.Stream<StoredSegment, LogUnavailable | CorruptSegment | HistoryExpired>
    }
    /** Runs the conformance probe against this store's bucket. */
    readonly check: (options?: CheckOptions) => Effect.Effect<CheckReport, StorageUnavailable>
  }
>()("@rikalabs/akter/store/service/Store") {}

/** The store settings a process was configured with; unset ones adopt what `meta/store` records. */
interface Configured {
  readonly shards: Option.Option<number>
  readonly retentionMillis: Option.Option<number>
}

/** Fails when `meta` disagrees with a configured setting. */
const agrees = (meta: StoreMeta, configured: Configured) =>
  Effect.gen(function* () {
    if (Option.exists(configured.shards, (shards) => shards !== meta.shards))
      return yield* StoreMismatch.make({
        setting: "shards",
        stored: meta.shards,
        configured: Option.getOrElse(configured.shards, () => meta.shards),
      })
    return meta
  })

/** Reads `meta/store`, creating it if this is the store's first start, and checks it against the configuration. */
const establish = (
  bucket: Bucket,
  retrying: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  configured: Configured,
) =>
  Effect.gen(function* () {
    const existing = yield* retrying(bucket.get(META_KEY))
    if (Option.isSome(existing))
      return yield* agrees(yield* decodeMeta(META_KEY)(existing.value), configured)
    const created: StoreMeta = {
      format: FORMAT,
      store: yield* randomHex,
      shards: Option.getOrElse(configured.shards, () => DEFAULT_SHARDS),
      retentionMillis: Option.getOrElse(configured.retentionMillis, () =>
        Duration.toMillis(Duration.fromInputUnsafe(DEFAULT_RETENTION)),
      ),
      createdAt: yield* DateTime.now,
    }
    if (yield* retrying(bucket.create(META_KEY, yield* encodeMeta(created)))) return created
    const winner = yield* retrying(bucket.get(META_KEY))
    if (Option.isNone(winner))
      return yield* Effect.die(new Error("meta/store vanished after another process created it"))
    return yield* agrees(yield* decodeMeta(META_KEY)(winner.value), configured)
  })

/** The store over a bucket. */
export const storeOf: {
  (
    options: StoreOptions,
  ): (
    raw: Bucket,
  ) => Effect.Effect<Store["Service"], StorageUnavailable | CorruptSegment | StoreMismatch>
  (
    raw: Bucket,
    options: StoreOptions,
  ): Effect.Effect<Store["Service"], StorageUnavailable | CorruptSegment | StoreMismatch>
} = dual(2, (raw: Bucket, options: StoreOptions) =>
  Effect.gen(function* () {
    const bucket = options.faults === undefined ? raw : options.faults.wrap(raw)
    const retry = options.retry ?? DEFAULT_RETRY
    const validFor = Duration.toMillis(Duration.fromInputUnsafe(options.validFor ?? "10 seconds"))
    const trimAfter = Duration.toMillis(Duration.fromInputUnsafe(options.trimAfter ?? "10 minutes"))
    if (trimAfter <= validFor)
      return yield* Effect.die(new RangeError("trimAfter must be longer than validFor"))
    const meta = yield* establish(bucket, retryUnavailable(retry), {
      shards: Option.fromUndefinedOr(options.shards),
      retentionMillis: Option.map(Option.fromUndefinedOr(options.retention), (retention) =>
        Duration.toMillis(Duration.fromInputUnsafe(retention)),
      ),
    })
    const writer = options.writer ?? (yield* randomHex)
    const build = yield* runtimeBuild(options.build ?? { bundle: "", framework: "" })
    const retention = bucketRetention({ bucket, retry, initial: meta.retentionMillis })
    const audit = bucketAudit({ bucket, retry })
    return Store.of({
      meta,
      build,
      retention: retention.retention,
      setRetention: retention.setRetention,
      ...bucketLog({
        bucket,
        retry,
        writer,
        build,
        shards: meta.shards,
        validFor,
        trimAfter,
        retention: retention.retention,
      }),
      ...bucketGc({
        bucket,
        retry,
        writer,
        shards: meta.shards,
        validFor,
        trimAfter,
        retention: retention.retention,
      }),
      ...bucketPages({ bucket, retry }),
      audit: audit.audit,
      audits: Effect.gen(function* () {
        const current = yield* retention.retentionAudit
        const records = yield* audit.audits
        if (current !== undefined && !records.some((record) => record.id === current.id))
          records.push(current)
        return records
      }),
      leases: bucketLeases({ bucket, retry }),
      check: checkBucket(bucket),
    })
  }),
)
