import { Clock, Deferred, Duration, Effect, Exit, Option, Random, Schema, Semaphore } from "effect"
import { SchemaBinary } from "effect/encoding"
import { type RetriedBucket, retryUnavailable } from "./bucket.ts"
import { decodeManifest, decodePage, decodeSegment, FORMAT, PageHash } from "./codec.ts"
import { CorruptSegment, PageCorrupt, StaleEpoch, StorageUnavailable } from "./errors.ts"
import { pageKey, PAGES_PREFIX } from "./keys.ts"
import { historyWindow } from "./history.ts"

const PREFIX = "gc/"

const EPOCH = /^gc\/([0-9a-f]{16})$/u

const LAST_EPOCH = 0xffff_ffff_ffff_ffffn

/**
 * Milliseconds after its claim that a `publishing` epoch may be taken over. It bounds how long a
 * publisher that stopped without advancing to `idle` (killed, interrupted, or failed with an
 * unknown outcome) blocks publication and collection. Safety does not rest on it: a holder whose
 * epoch was taken fails its fence before any durable reference.
 */
const PUBLICATION_EXPIRY = 60_000

/**
 * An epoch record. A `publishing` record's `expiresAt` holds its claim time, as every release has
 * written it; the epoch expires {@link PUBLICATION_EXPIRY} later.
 */
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

/** This process's open publication: one `publishing` epoch shared by every concurrent publisher. */
interface Publication {
  /** The claimed epoch once its create is acknowledged; no `idle` can follow an unacknowledged one. */
  holding: Holding | undefined
  /** Settles when the claim does; members wait on it before uploading. */
  readonly claimed: Deferred.Deferred<
    Holding,
    PagePublicationBusy | GcStaleEpoch | StorageUnavailable | CorruptSegment
  >
  /** Monotonic time before the claim was sent; members join only while it is within `validFor`. */
  readonly since: number
  members: number
  /** No `idle` may follow: a member's reference has no known outcome, or the epoch was taken. */
  unknown: boolean
  closing: boolean
  readonly closed: Deferred.Deferred<void>
}

const publishingExpiry = (record: typeof Record.Type) => record.expiresAt + PUBLICATION_EXPIRY

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
 *
 * A publisher confirms its epoch is still the newest after its uploads are acknowledged and
 * before it writes its durable reference. A collector that claims a later epoch therefore either
 * fences that reference or reads the uploads' fresh timestamps, which the grace period keeps; so
 * a `publishing` epoch whose holder stopped can expire after {@link PUBLICATION_EXPIRY} instead of
 * blocking the store for good. That holds only while every page the reference names was written
 * by the upload with a fresh timestamp or stays reachable from a retained checkpoint, and while
 * the reference lands within the grace period less the trim delay of the upload's start.
 * Concurrent publishers of one process share one epoch, so a drain claims the barrier once rather
 * than once per shard.
 */
export const bucketGc = (settings: GcSettings) => {
  const { bucket } = settings
  const retrying = retryUnavailable(settings.retry)
  const permit = Semaphore.makeUnsafe(1)
  let listing: { readonly at: number; readonly keys: ReadonlyArray<string> } | undefined
  let publication: Publication | undefined
  let collecting = false
  let seen = 0n

  /** The newest epoch; epochs are never deleted, so the listing starts at the newest one seen. */
  const latest = Effect.gen(function* () {
    const keys = yield* retrying(
      bucket.list(PREFIX, seen > 0n ? { startAfter: keyOf(seen - 1n) } : {}),
    )
    const key = keys.filter((key) => EPOCH.test(key)).at(-1)
    if (key === undefined) {
      if (seen > 0n)
        return yield* CorruptSegment.make({
          key: keyOf(seen),
          reason: "collector epoch is no longer stored",
        })
      return undefined
    }
    const epoch = BigInt(`0x${key.slice(PREFIX.length)}`)
    if (epoch > seen) seen = epoch
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

  /**
   * Claims the next epoch as `publishing` unless a live epoch holds the barrier. Losing the create
   * race or the confirmation is the same busy barrier a caller retries.
   */
  const claim = (made: Publication) =>
    Effect.gen(function* () {
      const previous = yield* latest
      const at = yield* Clock.currentTimeMillis
      if (
        previous !== undefined &&
        (previous.record.phase === "deleting" ||
          (previous.record.phase === "publishing" && publishingExpiry(previous.record) > at) ||
          (previous.record.phase === "marking" && previous.record.expiresAt > at))
      )
        return yield* PagePublicationBusy.make({ epoch: previous.epoch })
      made.holding = yield* create(
        previous?.epoch ?? 0n,
        { format: FORMAT, owner: yield* ownerId, phase: "publishing", expiresAt: at },
        made.since,
      )
      yield* confirm(made.holding)
      return made.holding
    }).pipe(
      Effect.catchTag("GcStaleEpoch", ({ epoch }) =>
        Effect.fail(PagePublicationBusy.make({ epoch: epoch + 1n })),
      ),
    )

  /**
   * Joins this process's open publication, or opens one and claims its epoch. Membership changes
   * run uninterruptibly so every member that entered also leaves; only waiting and the claim's
   * requests can be interrupted.
   */
  const enter = (restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      while (true) {
        const at = yield* monotonic
        const current = publication
        if (current !== undefined) {
          if (!current.closing && !current.unknown && at - current.since <= settings.validFor) {
            current.members++
            return current
          }
          yield* restore(Deferred.await(current.closed))
          continue
        }
        if (collecting) return yield* PagePublicationBusy.make({ epoch: seen })
        const made: Publication = {
          holding: undefined,
          claimed: Deferred.makeUnsafe(),
          since: at,
          members: 1,
          unknown: false,
          closing: false,
          closed: Deferred.makeUnsafe(),
        }
        publication = made
        const claimed = yield* Effect.exit(restore(claim(made)))
        Deferred.doneUnsafe(
          made.claimed,
          Exit.hasInterrupts(claimed)
            ? Exit.fail(PagePublicationBusy.make({ epoch: seen }))
            : claimed,
        )
        return made
      }
    })

  /** Fails unless the shared epoch is still the newest, so a taken-over publisher references nothing. */
  const fence = (current: Publication, holding: Holding) =>
    confirm(holding).pipe(
      Effect.catchTag("GcStaleEpoch", () =>
        Effect.suspend(() => {
          current.unknown = true
          return Effect.fail(PagePublicationBusy.make({ epoch: holding.epoch }))
        }),
      ),
    )

  /**
   * The last member out advances the epoch to `idle`, unless a member's reference ended without a
   * known outcome or the epoch was taken; then the epoch stays `publishing` until it expires. A
   * member that failed before its reference sent nothing, so it does not hold the epoch back. The
   * idle write only frees the barrier sooner, so its failure leaves the same expiring epoch.
   */
  const leave = (
    current: Publication,
    exit: Exit.Exit<unknown, unknown>,
    referenced: boolean,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      current.members--
      if (
        referenced &&
        Exit.isFailure(exit) &&
        !Option.exists(Exit.findErrorOption(exit), (error) => Schema.is(StaleEpoch)(error))
      )
        current.unknown = true
      if (current.members > 0) return Effect.void
      current.closing = true
      const close = Effect.sync(() => {
        if (publication === current) publication = undefined
        Deferred.doneUnsafe(current.closed, Exit.void)
      })
      const holding = current.holding
      if (current.unknown || holding === undefined) return close
      return restore(
        create(holding.epoch, { ...holding.record, phase: "idle" }, holding.deadline),
      ).pipe(Effect.ignore, Effect.ensuring(close))
    })

  const protect = <A, B, E1, E2, R1, R2>(
    upload: Effect.Effect<A, E1, R1>,
    reference: (uploaded: A) => Effect.Effect<B, E2, R2>,
  ): Effect.Effect<
    B,
    E1 | E2 | PagePublicationBusy | GcStaleEpoch | StorageUnavailable | CorruptSegment,
    R1 | R2
  > =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const current = yield* enter(restore)
        let referenced = false
        const exit = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              const holding = yield* Deferred.await(current.claimed)
              const uploaded = yield* upload
              yield* fence(current, holding)
              referenced = true
              return yield* reference(uploaded)
            }),
          ),
        )
        yield* leave(current, exit, referenced, restore)
        return yield* exit
      }),
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
        if (
          publication !== undefined ||
          previous?.record.phase === "deleting" ||
          (previous?.record.phase === "publishing" && publishingExpiry(previous.record) > at)
        )
          return { ...report, outcome: "blocked" } satisfies GcReport
        if (previous?.record.phase === "marking" && previous.record.expiresAt > at)
          return { ...report, outcome: "busy" } satisfies GcReport
        collecting = true
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
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            collecting = false
          }),
        ),
      ),
    )

  return { gc: { collect, protect } }
}
