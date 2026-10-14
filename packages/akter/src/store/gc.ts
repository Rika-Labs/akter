import { Clock, Duration, Effect, Option, Random, Result, Schema, Semaphore } from "effect"
import { SchemaBinary } from "effect/encoding"
import { type RetriedBucket, retryUnavailable } from "./bucket.ts"
import { decodeManifest, decodePage, decodeSegment, FORMAT, PageHash } from "./codec.ts"
import { CorruptSegment, PageCorrupt, StaleEpoch, StorageUnavailable } from "./errors.ts"
import { pageKey, PAGES_PREFIX } from "./keys.ts"
import { historyWindow } from "./history.ts"

const PREFIX = "gc/"

const EPOCH = /^gc\/([0-9a-f]{16})$/u

const LAST_EPOCH = 0xffff_ffff_ffff_ffffn

const Record = Schema.Struct({
  format: Schema.Literal(FORMAT),
  owner: Schema.String,
  phase: Schema.Literals(["marking", "deleting", "publishing", "idle"]),
  expiresAt: Schema.Finite,
})

const RecordBinary = SchemaBinary.toCodec(Record)

/** The collector lost its epoch or outlived its verified deletion window. */
export class GcStaleEpoch extends Schema.TaggedError<GcStaleEpoch>()("GcStaleEpoch", {
  epoch: Schema.BigInt,
}) {}

/** Page publication waits for a collector or another publisher to finish its immutable epoch. */
export class PagePublicationBusy extends Schema.TaggedError<PagePublicationBusy>()(
  "PagePublicationBusy",
  {
    epoch: Schema.BigInt,
  },
) {}

/** The immutable collector protocol uses the same store-wide timing and retention settings as the log. */
export interface GcSettings extends RetriedBucket {
  readonly writer: string
  readonly shards: number
  readonly retention: Effect.Effect<number, StorageUnavailable | CorruptSegment>
  readonly validFor: number
  readonly trimAfter: number
}

/** Page interpretation belongs to the page tree; the collector only walks verified page payloads. */
export interface GcOptions {
  readonly references: (bytes: Uint8Array) => ReadonlyArray<string>
  /** Page pointers introduced by retained log entries, including fork manifests not yet in a checkpoint. */
  readonly entryReferences: (bytes: Uint8Array) => ReadonlyArray<string>
  /** Minimum page age; must exceed twice `checkpointInterval` plus the store's trim delay. Default: 24 hours. */
  readonly gracePeriod?: Duration.Input
  /** The longest checkpoint interval configured for this store. Default: 60 seconds. */
  readonly checkpointInterval?: Duration.Input
  /** How long marking may run before another collector can take over. Default: 10 minutes. */
  readonly leaseFor?: Duration.Input
  /** At most this many keys in one deletion batch. Default: 256, maximum: 1000. */
  readonly batchSize?: number
  /** How often this collector refreshes its page listing. Timestamps and roots are always re-read. Default: 1 hour. */
  readonly listEvery?: Duration.Input
  /** Bounds one delete request; an unknown outcome blocks its epoch. Default: the store's `validFor`. */
  readonly deleteTimeout?: Duration.Input
}

/** A blocked epoch has an unknown delete outcome; another collector must not sweep behind it. */
export interface GcReport {
  readonly outcome: "collected" | "busy" | "blocked"
  readonly epoch: bigint
  readonly marked: number
  readonly deletedPages: number
  readonly deletedCheckpoints: number
}

interface StoredEpoch {
  readonly epoch: bigint
  readonly record: typeof Record.Type
}

interface Holding extends StoredEpoch {
  readonly deadline: number
}

interface Candidate {
  readonly key: string
  readonly cutoff: number
  readonly page: boolean
}

const monotonic = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n))

const keyOf = (epoch: bigint) => `${PREFIX}${epoch.toString(16).padStart(16, "0")}`

const millis = (input: Duration.Input) => Duration.toMillis(Duration.fromInputUnsafe(input))

/**
 * Each deletion batch first creates the next immutable epoch in `deleting` state. A contender
 * cannot take over that state, even after expiry: unconditional bucket deletes cannot be fenced
 * once issued. Only a completed delete advances to an expirable `marking` epoch. A crash or an
 * unknown delete outcome therefore blocks collection rather than allowing concurrent sweeps.
 * Marking epochs can expire safely because claiming the next epoch fences their first delete.
 * Every snapshot and fork must hold `gc.protect` from its first reused-page PUT through
 * its durable reference. Publication and deletion then contend for the same next immutable epoch,
 * closing the gap between a page timestamp check and an unconditional delete.
 */
export const bucketGc = (settings: GcSettings) => {
  const { bucket } = settings
  const retrying = retryUnavailable(settings.retry)
  const permit = Semaphore.makeUnsafe(1)
  let listing: { readonly at: number; readonly keys: ReadonlyArray<string> } | undefined

  const latest = Effect.gen(function* () {
    const keys = yield* retrying(bucket.list(PREFIX))
    const key = keys.filter((key) => EPOCH.test(key)).at(-1)
    if (key === undefined) return undefined
    const epoch = BigInt(`0x${key.slice(PREFIX.length)}`)
    const bytes = yield* retrying(bucket.get(key))
    if (Option.isNone(bytes))
      return yield* CorruptSegment.make({ key, reason: "collector epoch is no longer stored" })
    const record = yield* Schema.decodeEffect(RecordBinary)(bytes.value).pipe(
      Effect.mapError((error) => CorruptSegment.make({ key, reason: error.message })),
    )
    return { epoch, record } satisfies StoredEpoch
  })

  const create = (previous: bigint, record: typeof Record.Type, deadline: number) =>
    Effect.gen(function* () {
      if (previous === LAST_EPOCH) return yield* Effect.die(new RangeError("GC epochs exhausted"))
      const epoch = previous + 1n
      const key = keyOf(epoch)
      const bytes = yield* Schema.encodeEffect(RecordBinary)(record).pipe(Effect.orDie)
      const applied = yield* retrying(
        Effect.gen(function* () {
          if (yield* bucket.create(key, bytes)) return true
          const stored = yield* bucket.get(key)
          return Option.exists(
            stored,
            (body) => body.length === bytes.length && body.every((byte, i) => byte === bytes[i]),
          )
        }),
      )
      if (!applied) return yield* GcStaleEpoch.make({ epoch: previous })
      return { epoch, record, deadline } satisfies Holding
    })

  const confirm = (holding: Holding) =>
    Effect.gen(function* () {
      const start = yield* monotonic
      const stored = yield* latest
      const end = yield* monotonic
      if (
        stored?.epoch !== holding.epoch ||
        end < start ||
        end - start > settings.validFor ||
        (holding.record.phase !== "publishing" &&
          (end >= holding.deadline || (yield* Clock.currentTimeMillis) >= holding.record.expiresAt))
      )
        return yield* GcStaleEpoch.make({ epoch: holding.epoch })
    })

  const ownerId = Effect.map(
    Effect.all([Random.nextInt, Random.nextInt]),
    ([a, b]) => `${settings.writer}:${a}:${b}`,
  )

  const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    permit
      .withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          const previous = yield* latest
          const at = yield* Clock.currentTimeMillis
          if (
            previous !== undefined &&
            (previous.record.phase === "deleting" ||
              previous.record.phase === "publishing" ||
              (previous.record.phase === "marking" && previous.record.expiresAt > at))
          )
            return yield* PagePublicationBusy.make({ epoch: previous.epoch })
          const holding = yield* create(
            previous?.epoch ?? 0n,
            { format: FORMAT, owner: yield* ownerId, phase: "publishing", expiresAt: at },
            yield* monotonic,
          )
          yield* confirm(holding)
          const result = yield* effect.pipe(Effect.result)
          if (Result.isFailure(result) && !Schema.is(StaleEpoch)(result.failure))
            return yield* Effect.fail(result.failure)
          yield* create(holding.epoch, { ...holding.record, phase: "idle" }, holding.deadline)
          return Result.isFailure(result) ? yield* Effect.fail(result.failure) : result.success
        }),
      )
      .pipe(
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.flatMap(latest, (previous) =>
                Effect.fail(PagePublicationBusy.make({ epoch: previous?.epoch ?? 0n })),
              ),
        ),
      )

  const collect = (options: GcOptions) =>
    permit.withPermits(1)(
      Effect.gen(function* () {
        const grace = millis(options.gracePeriod ?? "24 hours")
        const checkpointInterval = millis(options.checkpointInterval ?? "60 seconds")
        const leaseFor = millis(options.leaseFor ?? "10 minutes")
        const listEvery = millis(options.listEvery ?? "1 hour")
        const deleteTimeout =
          options.deleteTimeout === undefined ? settings.validFor : millis(options.deleteTimeout)
        const batchSize = options.batchSize ?? 256
        if (
          !Number.isFinite(grace) ||
          grace <= 2 * checkpointInterval + settings.trimAfter ||
          !Number.isFinite(checkpointInterval) ||
          checkpointInterval <= 0 ||
          !Number.isFinite(leaseFor) ||
          leaseFor <= settings.validFor ||
          !Number.isFinite(listEvery) ||
          listEvery <= 0 ||
          !Number.isFinite(deleteTimeout) ||
          deleteTimeout <= 0 ||
          deleteTimeout > settings.validFor ||
          !Number.isInteger(batchSize) ||
          batchSize < 1 ||
          batchSize > 1000
        )
          return yield* Effect.die(
            new RangeError("Invalid garbage collection timing or batch size"),
          )
        const previous = yield* latest
        const at = yield* Clock.currentTimeMillis
        const report = {
          epoch: previous?.epoch ?? 0n,
          marked: 0,
          deletedPages: 0,
          deletedCheckpoints: 0,
        }
        if (previous?.record.phase === "deleting" || previous?.record.phase === "publishing")
          return { ...report, outcome: "blocked" } satisfies GcReport
        if (previous?.record.phase === "marking" && previous.record.expiresAt > at)
          return { ...report, outcome: "busy" } satisfies GcReport
        const owner = yield* ownerId
        let holding = yield* create(
          previous?.epoch ?? 0n,
          { format: FORMAT, owner, phase: "marking", expiresAt: at + leaseFor },
          (yield* monotonic) + leaseFor,
        )
        yield* confirm(holding)
        const roots: Array<string> = []
        const candidates: Array<Candidate> = []
        const retentionCutoff = at - (yield* settings.retention)
        for (let shard = 0; shard < settings.shards; shard++) {
          const window = yield* retrying(historyWindow(bucket, shard, retentionCutoff))
          let covered = 0n
          for (const [index, { key, offset, modified }] of window.checkpoints.entries()) {
            if (index > 0 && modified < retentionCutoff && key !== window.anchor?.key) {
              candidates.push({ key, cutoff: retentionCutoff, page: false })
              continue
            }
            const bytes = yield* retrying(bucket.get(key))
            if (Option.isNone(bytes))
              return yield* CorruptSegment.make({ key, reason: "retained checkpoint is missing" })
            const manifest = yield* decodeManifest(key)(bytes.value)
            if (manifest.offset > covered) covered = manifest.offset
            if (manifest.offset !== offset)
              return yield* CorruptSegment.make({
                key,
                reason: "checkpoint offset differs from its key",
              })
            roots.push(...manifest.statePages, ...manifest.indexPages)
          }
          const after = window.first === undefined ? covered : (window.anchor?.offset ?? 0n)
          for (const { key, offset } of window.segments) {
            if (offset <= after) continue
            const bytes = yield* retrying(bucket.get(key))
            if (Option.isNone(bytes))
              return yield* CorruptSegment.make({ key, reason: "retained segment is missing" })
            const segment = yield* decodeSegment(key)(bytes.value)
            for (const entry of segment.entries)
              roots.push(...(yield* Effect.sync(() => options.entryReferences(entry))))
          }
        }
        const marked = new Set<string>()
        while (roots.length > 0) {
          const hash = roots.pop()
          if (hash === undefined || marked.has(hash)) continue
          if (!Schema.is(PageHash)(hash))
            return yield* Effect.die(
              PageCorrupt.make({ hash, reason: "reference is not a page hash" }),
            )
          marked.add(hash)
          const stored = yield* retrying(bucket.get(pageKey(hash)))
          if (Option.isNone(stored))
            return yield* Effect.die(PageCorrupt.make({ hash, reason: "is not in the store" }))
          const bytes = yield* decodePage(hash)(stored.value)
          roots.push(...(yield* Effect.sync(() => options.references(bytes))))
        }
        const listedAt = yield* monotonic
        if (listing === undefined || listedAt < listing.at || listedAt - listing.at >= listEvery)
          listing = { at: listedAt, keys: yield* retrying(bucket.list(PAGES_PREFIX)) }
        for (const key of listing.keys)
          if (!marked.has(key.slice(PAGES_PREFIX.length)))
            candidates.push({ key, cutoff: at - grace, page: true })
        for (let index = 0; index < candidates.length; index += batchSize) {
          const batch: Array<Candidate> = []
          for (const candidate of candidates.slice(index, index + batchSize)) {
            const modified = yield* retrying(bucket.modified(candidate.key))
            if (Option.exists(modified, (time) => time < candidate.cutoff)) batch.push(candidate)
          }
          if (batch.length === 0) continue
          yield* confirm(holding)
          holding = yield* create(
            holding.epoch,
            { ...holding.record, phase: "deleting" },
            holding.deadline,
          )
          const deleting: Array<Candidate> = []
          for (const candidate of batch) {
            const modified = yield* retrying(bucket.modified(candidate.key))
            if (Option.exists(modified, (time) => time < candidate.cutoff)) deleting.push(candidate)
          }
          yield* confirm(holding)
          if (deleting.length > 0)
            yield* bucket.delete(deleting.map(({ key }) => key)).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(deleteTimeout),
                orElse: () =>
                  Effect.fail(
                    StorageUnavailable.make({
                      operation: "delete",
                      key: deleting[0]!.key,
                      reason: "collector delete request timed out; its epoch remains blocked",
                    }),
                  ),
              }),
            )
          for (const candidate of deleting)
            if (candidate.page) report.deletedPages++
            else report.deletedCheckpoints++
          holding = yield* create(
            holding.epoch,
            {
              format: FORMAT,
              owner,
              phase: "marking",
              expiresAt: (yield* Clock.currentTimeMillis) + leaseFor,
            },
            (yield* monotonic) + leaseFor,
          )
        }
        yield* create(holding.epoch, { ...holding.record, phase: "idle" }, holding.deadline)
        return {
          ...report,
          epoch: holding.epoch + 1n,
          marked: marked.size,
          outcome: "collected",
        } satisfies GcReport
      }),
    )

  return { gc: { collect, protect } }
}
