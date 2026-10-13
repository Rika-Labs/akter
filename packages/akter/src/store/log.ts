import { Clock, Effect, Option, Semaphore, Stream } from "effect"
import { type RetriedBucket, retryUnavailable } from "./bucket.ts"
import type { Build } from "./build.ts"
import {
  decodeManifest,
  decodeSegment,
  encodeManifest,
  encodeSegment,
  type Manifest,
  type Segment,
} from "./codec.ts"
import { CorruptSegment, LogUnavailable, StaleEpoch, type StorageUnavailable } from "./errors.ts"
import {
  checkpointKey,
  checkpointOffset,
  checkpointPrefix,
  logPrefix,
  pageKey,
  segmentKey,
  segmentOffset,
} from "./keys.ts"
import { Metrics, count, record } from "../runtime/telemetry/metrics.ts"

/** How many times `open` re-lists after another opener took the next offset before giving up. */
const OPEN_ATTEMPTS = 5

/** How many segments `read` fetches at once, in offset order. */
const READ_CONCURRENCY = 8

/** Page existence checks in flight at once while `open` checks a manifest. */
const PAGE_CHECKS = 16

/** The protocol's bucket and settings, resolved from the store options. */
export interface Settings extends RetriedBucket {
  readonly writer: string
  readonly build: Build
  readonly shards: number
  /** Milliseconds an owner may go without appending or verifying before it must verify. */
  readonly validFor: number
  /** Milliseconds a checkpoint must have been known before trim deletes what it covers. */
  readonly trimAfter: number
}

/**
 * Ownership of one shard's log, from a successful open until it is fenced. The
 * open offset is the lease's epoch: a later owner always opens at a higher
 * offset. `head` advances with each append made through this lease; the object
 * is the lease, so a copy of it authorizes nothing.
 */
export interface Lease {
  readonly shard: number
  readonly open: bigint
  readonly head: bigint
  /** The newest intact checkpoint when the shard was opened; recovery reads the log after its offset. */
  readonly checkpoint: Option.Option<Manifest>
  /** Newer checkpoints that open skipped because they do not decode or name a page that is not stored, newest first. */
  readonly damaged: ReadonlyArray<CorruptSegment>
}

/** A segment read from the log, with the offset it is stored at. */
export interface StoredSegment extends Segment {
  readonly offset: bigint
}

interface Known {
  readonly offset: bigint
  readonly seenAt: number
}

interface Holding {
  head: bigint
  confirmedAt: number
  closed: boolean
  readonly checkpoints: Array<Known>
  readonly permit: Semaphore.Semaphore
}

const now = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n))

const unavailable = (error: StorageUnavailable) =>
  LogUnavailable.make({
    operation: error.operation,
    key: error.key,
    status: error.status,
    reason: error.reason,
  })

/**
 * The bucket log protocol. A segment is created once at `head + 1`; the
 * create-once write is the fence, so no clock sits in the commit path. An
 * ambiguous write is resolved by reading the segment back: one carrying this
 * lease's writer and open offset is its own earlier attempt. Two elapsed-time
 * rules close the gap trim opens: an owner idle longer than `validFor`
 * re-checks its lease before writing, and trim deletes only segments covered by
 * a checkpoint known for `trimAfter`, so an owner that could aim at a deleted
 * key has failed its check first. Times are the owner's own monotonic clock,
 * and each confirmation counts from before its request was sent.
 *
 * Open recovers from the newest intact checkpoint. A newer one that does not
 * decode or names a page that is not stored is skipped and reported, but only
 * while every segment after the intact one is still in the log, through the
 * skipped checkpoint's offset; otherwise the shard is refused, because opening
 * would reuse offsets whose entries are gone.
 */
export const bucketLog = (settings: Settings) => {
  const bucket = settings.bucket
  const holdings = new WeakMap<Lease, Holding>()
  const retrying = retryUnavailable(settings.retry)

  const newestCheckpoint = (shard: number) =>
    bucket
      .list(checkpointPrefix(shard), { limit: 1 })
      .pipe(Effect.map((keys) => Option.fromNullishOr(keys[0])))

  /** The manifest at `key` if it decodes, matches its key and names only stored pages. */
  const intactCheckpoint = (shard: number, key: string) =>
    Effect.gen(function* () {
      const bytes = yield* retrying(bucket.get(key))
      if (Option.isNone(bytes))
        return yield* CorruptSegment.make({ key, reason: "was listed but is no longer stored" })
      const manifest = yield* decodeManifest(key)(bytes.value)
      if (!Option.contains(checkpointOffset(shard, key), manifest.offset))
        return yield* CorruptSegment.make({
          key,
          reason: `holds a checkpoint at offset ${manifest.offset}`,
        })
      const sizes = yield* Effect.forEach(
        [...manifest.statePages, ...manifest.indexPages],
        (hash) => Effect.map(retrying(bucket.head(pageKey(hash))), (size) => [hash, size] as const),
        { concurrency: PAGE_CHECKS },
      )
      for (const [hash, size] of sizes)
        if (Option.isNone(size))
          return yield* CorruptSegment.make({
            key,
            reason: `names page ${hash}, which is not stored`,
          })
      return manifest
    })

  const loadSegment = (key: string) =>
    Effect.gen(function* () {
      const bytes = yield* retrying(bucket.get(key))
      if (Option.isNone(bytes))
        return yield* CorruptSegment.make({ key, reason: "deleted while it was being read" })
      return yield* decodeSegment(key)(bytes.value)
    })

  /** Creates the segment, or recognizes this lease's own write behind a lost response. */
  const writeSegment = (key: string, bytes: Uint8Array, open: bigint) =>
    retrying(
      Effect.gen(function* () {
        if (yield* bucket.create(key, bytes)) return true
        const existing = yield* bucket.get(key)
        if (Option.isNone(existing)) return false
        return yield* decodeSegment(key)(existing.value).pipe(
          Effect.flatMap((segment) => {
            const own = segment.writer === settings.writer && segment.open === open
            return Effect.as(count(Metrics.appendAmbiguous, {}, own ? 1 : 0), own)
          }),
          Effect.catchTag("CorruptSegment", () => Effect.succeed(false)),
        )
      }),
    )

  const fence = (lease: Lease, holding: Holding) => {
    holding.closed = true
    return StaleEpoch.make({ shard: lease.shard, open: lease.open })
  }

  /** Newest checkpoint at or below the head and nothing at `head + 1`, or the lease is fenced. */
  const confirm = (lease: Lease, holding: Holding) =>
    Effect.gen(function* () {
      const start = yield* now
      const [newest, taken] = yield* retrying(
        Effect.all(
          [newestCheckpoint(lease.shard), bucket.head(segmentKey(lease.shard, holding.head + 1n))],
          { concurrency: 2 },
        ),
      )
      const passed = Option.exists(
        Option.flatMap(newest, (key) => checkpointOffset(lease.shard, key)),
        (offset) => offset > holding.head,
      )
      if (Option.isSome(taken) || passed) return yield* fence(lease, holding)
      holding.confirmedAt = start
    })

  /** Runs `body` alone on the lease, after re-checking a lease idle longer than `validFor`. */
  const guarded = <A>(
    lease: Lease,
    body: (holding: Holding) => Effect.Effect<A, StaleEpoch | StorageUnavailable>,
  ): Effect.Effect<A, StaleEpoch | LogUnavailable> =>
    Effect.suspend(() => {
      const holding = holdings.get(lease)
      if (holding === undefined)
        return Effect.fail(StaleEpoch.make({ shard: lease.shard, open: lease.open }))
      return holding.permit.withPermits(1)(
        Effect.gen(function* () {
          if (holding.closed)
            return yield* StaleEpoch.make({ shard: lease.shard, open: lease.open })
          if ((yield* now) - holding.confirmedAt > settings.validFor) yield* confirm(lease, holding)
          return yield* body(holding)
        }),
      )
    }).pipe(Effect.catchTag("StorageUnavailable", (error) => Effect.fail(unavailable(error))))

  /** The newest intact checkpoint, with the newer ones skipped on the way. */
  const recoveryPoint = (shard: number) =>
    Effect.gen(function* () {
      const damaged: Array<CorruptSegment> = []
      const after = (key: string | undefined) =>
        retrying(bucket.list(checkpointPrefix(shard), { limit: 1, startAfter: key }))
      for (let [key] = yield* after(undefined); key !== undefined; [key] = yield* after(key)) {
        const checkpoint = yield* intactCheckpoint(shard, key).pipe(
          Effect.asSome,
          Effect.catchTag("CorruptSegment", (error) =>
            Effect.sync(() => {
              damaged.push(error)
              return Option.none<Manifest>()
            }),
          ),
        )
        if (Option.isSome(checkpoint)) return { checkpoint, damaged }
      }
      return { checkpoint: Option.none<Manifest>(), damaged }
    })

  const open = (shard: number) =>
    Effect.gen(function* () {
      if (!Number.isInteger(shard) || shard < 0 || shard >= settings.shards)
        return yield* Effect.die(
          new RangeError(`Shard ${shard} is outside 0..${settings.shards - 1}`),
        )
      let at = 1n
      for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
        const start = yield* now
        const { checkpoint, damaged } = yield* recoveryPoint(shard)
        const base = Option.match(checkpoint, { onNone: () => 0n, onSome: (cp) => cp.offset })
        let reach = base
        for (const skipped of damaged)
          for (const offset of Option.toArray(checkpointOffset(shard, skipped.key)))
            if (offset > reach) reach = offset
        const keys = yield* retrying(
          bucket.list(logPrefix(shard), { startAfter: segmentKey(shard, base) }),
        )
        let head = base
        for (const key of keys) {
          const offset = segmentOffset(shard, key)
          if (Option.isNone(offset)) continue
          if (offset.value !== head + 1n)
            return yield* CorruptSegment.make({
              key: segmentKey(shard, head + 1n),
              reason: `is missing from the log after checkpoint ${base}${damaged.length === 0 ? "" : `, the newest intact one (${damaged.map((skipped) => skipped.message).join("; ")})`}`,
            })
          head = offset.value
        }
        if (head < reach)
          return yield* CorruptSegment.make({
            key: segmentKey(shard, head + 1n),
            reason: `is missing, so the log after checkpoint ${base} no longer reaches skipped checkpoint ${reach} (${damaged.map((skipped) => skipped.message).join("; ")})`,
          })
        at = head + 1n
        const bytes = yield* encodeSegment({
          writer: settings.writer,
          open: at,
          build: settings.build,
          entries: [],
        })
        if (!(yield* writeSegment(segmentKey(shard, at), bytes, at))) continue
        const holding: Holding = {
          head: at,
          confirmedAt: start,
          closed: false,
          checkpoints: Option.match(checkpoint, {
            onNone: () => [],
            onSome: (cp) => [{ offset: cp.offset, seenAt: start }],
          }),
          permit: Semaphore.makeUnsafe(1),
        }
        const lease: Lease = {
          shard,
          open: at,
          checkpoint,
          damaged,
          get head() {
            return holding.head
          },
        }
        holdings.set(lease, holding)
        return lease
      }
      return yield* StaleEpoch.make({ shard, open: at })
    }).pipe(Effect.catchTag("StorageUnavailable", (error) => Effect.fail(unavailable(error))))

  const append = (lease: Lease, batch: ReadonlyArray<Uint8Array>) =>
    guarded(lease, (holding) =>
      Effect.gen(function* () {
        const start = yield* now
        const offset = holding.head + 1n
        const bytes = yield* encodeSegment({
          writer: settings.writer,
          open: lease.open,
          build: settings.build,
          entries: [...batch],
        })
        const ours = yield* writeSegment(segmentKey(lease.shard, offset), bytes, lease.open).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              holding.closed = true
            }),
          ),
        )
        if (!ours) return yield* fence(lease, holding)
        holding.head = offset
        holding.confirmedAt = start
        yield* record(Metrics.appendDuration, {}, (yield* now) - start)
        yield* record(Metrics.batchEntries, {}, batch.length)
        return offset
      }),
    )

  const read = (
    shard: number,
    from: bigint,
  ): Stream.Stream<StoredSegment, LogUnavailable | CorruptSegment> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const keys = yield* retrying(
          bucket.list(logPrefix(shard), { startAfter: segmentKey(shard, from) }),
        )
        const listed: Array<readonly [bigint, string]> = []
        let expected = from + 1n
        for (const key of keys) {
          const offset = segmentOffset(shard, key)
          if (Option.isNone(offset)) continue
          if (offset.value !== expected)
            return yield* CorruptSegment.make({
              key: segmentKey(shard, expected),
              reason: "is not in the log; read from the lease's checkpoint offset",
            })
          listed.push([offset.value, key])
          expected += 1n
        }
        return Stream.fromIterable(listed).pipe(
          Stream.mapEffect(
            ([offset, key]) =>
              Effect.map(loadSegment(key), (segment): StoredSegment => ({ ...segment, offset })),
            { concurrency: READ_CONCURRENCY },
          ),
        )
      }),
    ).pipe(Stream.catchTag("StorageUnavailable", (error) => Stream.fail(unavailable(error))))

  const checkpoint = (lease: Lease, manifest: Manifest) =>
    guarded(lease, (holding) =>
      Effect.gen(function* () {
        if (manifest.offset < 1n || manifest.offset > holding.head)
          return yield* Effect.die(
            new RangeError(
              `Checkpoint offset ${manifest.offset} is outside the lease's log 1..${holding.head}`,
            ),
          )
        const start = yield* now
        yield* retrying(
          bucket.create(
            checkpointKey(lease.shard, manifest.offset),
            yield* encodeManifest(manifest),
          ),
        )
        holding.checkpoints.push({ offset: manifest.offset, seenAt: start })
      }),
    )

  const trim = (lease: Lease, through: bigint) =>
    guarded(lease, (holding) =>
      Effect.gen(function* () {
        const current = yield* now
        let covered = 0n
        for (const known of holding.checkpoints)
          if (current - known.seenAt >= settings.trimAfter && known.offset > covered)
            covered = known.offset
        const bound = through < covered ? through : covered
        if (bound < 1n) return 0n
        const doomed: Array<string> = []
        for (const key of yield* retrying(bucket.list(logPrefix(lease.shard))))
          if (Option.exists(segmentOffset(lease.shard, key), (offset) => offset <= bound))
            doomed.push(key)
        if (doomed.length > 0) yield* retrying(bucket.delete(doomed))
        return bound
      }),
    )

  const verify = (lease: Lease) => guarded(lease, () => Effect.void)

  /** Whether `verify` would succeed without asking the bucket: the lease is open and within `validFor` of its last confirmation. */
  const fresh = (lease: Lease) =>
    Effect.map(now, (at) => {
      const holding = holdings.get(lease)
      return (
        holding !== undefined && !holding.closed && at - holding.confirmedAt <= settings.validFor
      )
    })

  return { open, append, read, checkpoint, trim, verify, fresh, recoveryPoint }
}
