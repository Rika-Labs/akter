import {
  type Cause,
  Clock,
  Context,
  Data,
  Effect,
  Option,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect"
import { milliseconds } from "./metrics.ts"

/** How far back an activity or latency read reaches, ending now. */
export type LiveWindow = "1h" | "24h" | "7d"

const MINUTE_MS = 60_000

const HOUR_MS = 3_600_000

/** Minute buckets kept: the last hour. */
const MINUTES_KEPT = 60

/** Hour buckets kept: the last 7 days. */
const HOURS_KEPT = 168

/** The most tenants one runner records turns for; past it the least recently active is dropped. */
export const MAX_RECORDED_TENANTS = 1_024

/** The most command streams one tenant may hold open on one runner. */
export const MAX_TENANT_STREAMS = 4

/** The most command streams one runner holds open. */
export const MAX_STREAMS = 64

/** The entries a watched tenant's ring keeps for a reconnecting stream. */
export const STREAM_RING = 256

/** The entries one stream buffers before it ends with a gap. */
export const STREAM_BUFFER = 1_024

/** How long a tenant keeps recording stream entries after its last stream ended, so a reconnect resumes. */
export const STREAM_GRACE_MS = 60_000

/** The longest payload preview, in characters. */
export const PREVIEW_CHARACTERS = 256

const PREVIEW_DEPTH = 3

const PREVIEW_MEMBERS = 8

const PREVIEW_STRING = 32

/** Keys whose values a payload preview never shows. */
const SENSITIVE = /pass|secret|token|key|auth|cookie|credential|session|card|cvv|ssn|email|phone/i

interface Bucket {
  readonly start: number
  readonly commands: Map<string, { count: number; failures: number }>
  readonly histogram: Array<number>
  total: number
  max: number
}

interface Series {
  readonly minutes: Array<Bucket>
  readonly hours: Array<Bucket>
}

interface Recorded {
  readonly since: number
  readonly types: Map<string, Series>
  lastMs: number
}

/** One committed command as a stream carries it; `id` is the stream's epoch and sequence. */
export interface StreamEntry {
  readonly id: string
  readonly seq: number
  readonly commandId: string
  readonly atMs: number
  readonly durationMs: number
  readonly actorType: string
  readonly actorId: string
  readonly command: string
  readonly callerKey: string
  readonly failed: boolean
  readonly errorTag: string | null
  readonly payloadPreview: string | null
}

/** What a stream's subscriber receives: a committed command, or a gap after which entries are missing. */
export type StreamMessage = Data.TaggedEnum<{
  command: { readonly entry: StreamEntry }
  gap: {}
}>

export const StreamMessage = Data.taggedEnum<StreamMessage>()

/** Which committed commands a stream sends: one actor type, failures or successes, or all. */
export interface StreamFilter {
  readonly actorType?: string | undefined
  readonly failed?: boolean | undefined
}

interface Subscriber {
  readonly filter: StreamFilter
  readonly queue: Queue.Queue<StreamEntry, Cause.Done>
  overflowed: boolean
}

interface Watch {
  readonly epoch: string
  readonly subscribers: Set<Subscriber>
  readonly ring: Array<StreamEntry>
  seq: number
  until: number
}

/** The fields of a committed command its stream entry is built from, read only when the tenant is watched. */
export interface StreamSource {
  readonly commandId: string
  readonly atMs: number
  readonly durationMs: number
  readonly actorType: string
  readonly actorId: string
  readonly command: string
  readonly callerKey: string
  readonly failed: boolean
  /** The command's encoded payload. */
  readonly payload: string
  /** The declared failure's encoded value, when the command failed. */
  readonly failure: string | undefined
}

const bucketIndex = (durationMs: number) => {
  for (let index = 0; index < milliseconds.length; index++)
    if (durationMs <= milliseconds[index]!) return index

  return milliseconds.length
}

const emptyBucket = (start: number): Bucket => ({
  start,
  commands: new Map(),
  histogram: Array.from({ length: milliseconds.length + 1 }, () => 0),
  total: 0,
  max: 0,
})

/** The bucket starting at `start`, made in order if absent, after dropping buckets older than `kept` slots. */
const bucketAt = (buckets: Array<Bucket>, start: number, size: number, kept: number) => {
  const oldest = start - (kept - 1) * size

  while (buckets.length > 0 && buckets[0]!.start < oldest) buckets.shift()

  for (let index = buckets.length - 1; index >= 0; index--) {
    const found = buckets[index]!

    if (found.start === start) return found

    if (found.start < start) {
      const made = emptyBucket(start)
      buckets.splice(index + 1, 0, made)

      return made
    }
  }

  const made = emptyBucket(start)
  buckets.unshift(made)

  return made
}

const add = (
  bucket: Bucket,
  command: string,
  failed: boolean,
  durationMs: number,
  slot: number,
) => {
  const counted = bucket.commands.get(command)

  if (counted === undefined) bucket.commands.set(command, { count: 1, failures: failed ? 1 : 0 })
  else {
    counted.count += 1
    if (failed) counted.failures += 1
  }

  bucket.total += 1
  bucket.histogram[slot]! += 1
  if (durationMs > bucket.max) bucket.max = durationMs
}

/**
 * The quantile `q` of a histogram on the duration bounds: the bound of the
 * bucket it falls in, capped by the largest duration seen, so it is an upper
 * bound that no turn's own time in that bucket exceeds; null when it is empty.
 */
const quantile = (histogram: ReadonlyArray<number>, max: number, q: number) => {
  const total = histogram.reduce((sum, count) => sum + count, 0)

  if (total === 0) return null

  const rank = Math.max(1, Math.ceil(q * total))
  let seen = 0

  for (let index = 0; index < histogram.length; index++) {
    seen += histogram[index]!

    if (seen >= rank) return Math.min(milliseconds[index] ?? max, max)
  }

  return max
}

const truncated = (text: string, length: number) =>
  text.length <= length ? text : `${text.slice(0, length)}…`

const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ value: Schema.optionalKey(Schema.Json) })),
)

const decodeFailureTag = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
)

const isJsonArray = Schema.is(Schema.Array(Schema.Json))

const render = (value: Schema.Json, depth: number): string => {
  if (value === null || Predicate.isBoolean(value) || Predicate.isNumber(value))
    return String(value)

  if (Predicate.isString(value)) return JSON.stringify(truncated(value, PREVIEW_STRING))

  if (isJsonArray(value)) {
    if (depth >= PREVIEW_DEPTH) return "[…]"

    const shown = value.slice(0, PREVIEW_MEMBERS).map((item) => render(item, depth + 1))

    return `[${[...shown, ...(value.length > PREVIEW_MEMBERS ? ["…"] : [])].join(",")}]`
  }

  if (depth >= PREVIEW_DEPTH) return "{…}"

  const entries = Object.entries(value)
  const shown = entries
    .slice(0, PREVIEW_MEMBERS)
    .map(
      ([key, member]) =>
        `${JSON.stringify(truncated(key, PREVIEW_STRING))}:${
          SENSITIVE.test(key) ? '"[redacted]"' : render(member, depth + 1)
        }`,
    )

  return `{${[...shown, ...(entries.length > PREVIEW_MEMBERS ? ["…"] : [])].join(",")}}`
}

/**
 * A short, redacted rendering of a payload, encoded as `{ "value": ... }`,
 * and null when it carries none: the value under any key that names a
 * credential or personal identifier is replaced, strings are cut, objects and
 * arrays show their first members and stop a few levels down, and the whole
 * is cut to `PREVIEW_CHARACTERS`. It is built on the runner, so the payload
 * itself never leaves it.
 */
export const payloadPreview = (encoded: string): string | null =>
  Option.match(decodePayload(encoded), {
    onNone: () => null,
    onSome: ({ value }) =>
      value === undefined ? null : truncated(render(value, 0), PREVIEW_CHARACTERS - 1),
  })

/** The `_tag` of an encoded declared failure, or null when it has none. */
const failureTag = (encoded: string | undefined) =>
  encoded === undefined
    ? null
    : Option.match(decodeFailureTag(encoded), {
        onNone: () => null,
        onSome: (failure) => failure._tag,
      })

/** One window's buckets and how they are spaced. */
const windowOf = (window: LiveWindow) =>
  window === "1h"
    ? { size: MINUTE_MS, slots: MINUTES_KEPT, hours: false }
    : { size: HOUR_MS, slots: window === "24h" ? 24 : HOURS_KEPT, hours: true }

/** Activity over a window: commands per second at each covered slot, oldest first, and each command's volume. */
export interface Activity {
  readonly since: number
  readonly points: ReadonlyArray<{ readonly atMs: number; readonly perSecond: number }>
  readonly commands: ReadonlyArray<{
    readonly command: string
    readonly count: number
    readonly perSecond: number
  }>
}

/** Turn latency over a window: counts per duration bound (the last unbounded) and quantiles. */
export interface Latency {
  readonly since: number
  readonly count: number
  readonly buckets: ReadonlyArray<{ readonly upToMs: number | null; readonly count: number }>
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly p99Ms: number | null
}

/** A type's recent rate and quantiles, or all types' together. */
export interface Rates {
  /** Commands per second over the current minute and the four before it, from `since`. */
  readonly perSecond: number
  /** The median turn time over the last hour, from `since`; null with no turn. */
  readonly p50Ms: number | null
  /** The 99th percentile turn time over the last hour, from `since`; null with no turn. */
  readonly p99Ms: number | null
}

const sequenceOf = (id: string) => Number(id.slice(id.lastIndexOf(".") + 1))

/**
 * Committed turns of this runner, by tenant and actor type, in minute buckets
 * for an hour and hour buckets for 7 days, and the live command stream. Every
 * read is one tenant's. Nothing here survives the process.
 */
export const liveRecorder = (options: { readonly startedAtMs: number; readonly epoch: string }) => {
  const tenants = new Map<string, Recorded>()
  const watches = new Map<string, Watch>()
  let evicted = false
  let streams = 0
  let watchEpochs = 0

  const recorded = (tenant: string, nowMs: number) => {
    const found = tenants.get(tenant)

    if (found !== undefined) return found

    if (tenants.size >= MAX_RECORDED_TENANTS) {
      let oldest: string | undefined
      let oldestMs = Number.POSITIVE_INFINITY

      for (const [name, entry] of tenants)
        if (entry.lastMs < oldestMs) {
          oldest = name
          oldestMs = entry.lastMs
        }

      if (oldest !== undefined) tenants.delete(oldest)
      evicted = true
    }

    const made: Recorded = {
      since: evicted ? nowMs : options.startedAtMs,
      types: new Map(),
      lastMs: nowMs,
    }

    tenants.set(tenant, made)

    return made
  }

  /**
   * When this runner began counting a tenant's turns: its start, unless a
   * tenant was ever dropped to stay within `MAX_RECORDED_TENANTS`, after which
   * a tenant counts from its first turn since and an unrecorded one is unknown.
   */
  const sinceOf = (tenant: string) =>
    tenants.get(tenant)?.since ?? (evicted ? undefined : options.startedAtMs)

  /** Every bucket of `tenant` (one type or all) in the slots from `first` on. */
  const buckets = (
    tenant: string,
    actorType: string | undefined,
    hours: boolean,
    first: number,
  ): Array<Bucket> => {
    const entry = tenants.get(tenant)

    if (entry === undefined) return []

    const series =
      actorType === undefined
        ? [...entry.types.values()]
        : entry.types.has(actorType)
          ? [entry.types.get(actorType)!]
          : []

    return series.flatMap((found) =>
      (hours ? found.hours : found.minutes).filter((bucket) => bucket.start >= first),
    )
  }

  const histogramOf = (found: ReadonlyArray<Bucket>) => {
    const histogram = Array.from({ length: milliseconds.length + 1 }, () => 0)
    let max = 0

    for (const bucket of found) {
      bucket.histogram.forEach((count, index) => {
        histogram[index]! += count
      })
      if (bucket.max > max) max = bucket.max
    }

    return { histogram, max }
  }

  const matches = (filter: StreamFilter, entry: StreamEntry) =>
    (filter.actorType === undefined || filter.actorType === entry.actorType) &&
    (filter.failed === undefined || filter.failed === entry.failed)

  return {
    startedAtMs: options.startedAtMs,

    /**
     * A window's points are the slots it spans whose time this runner
     * observed: a slot before `since` has none, and a slot's rate divides its
     * count by the seconds of it observed, so the current slot and the one
     * `since` falls in are not diluted.
     */
    activity: (
      tenant: string,
      actorType: string | undefined,
      window: LiveWindow,
      nowMs: number,
    ): Activity | undefined => {
      const since = sinceOf(tenant)

      if (since === undefined) return undefined

      const { size, slots, hours } = windowOf(window)
      const current = Math.floor(nowMs / size) * size
      const first = current - (slots - 1) * size
      const found = buckets(tenant, actorType, hours, first)
      const points: Array<{ atMs: number; perSecond: number }> = []

      for (let start = first; start <= current; start += size) {
        const seconds = (Math.min(start + size, nowMs) - Math.max(start, since)) / 1000

        if (seconds <= 0) continue

        const count = found
          .filter((bucket) => bucket.start === start)
          .reduce((sum, bucket) => sum + bucket.total, 0)

        points.push({ atMs: start, perSecond: count / seconds })
      }

      const volumes = new Map<string, number>()

      for (const bucket of found)
        for (const [command, { count }] of bucket.commands)
          volumes.set(command, (volumes.get(command) ?? 0) + count)

      const seconds = Math.max(nowMs - Math.max(first, since), 1) / 1000

      return {
        since,
        points,
        commands: [...volumes]
          .map(([command, count]) => ({ command, count, perSecond: count / seconds }))
          .sort(
            (left, right) => right.count - left.count || (left.command < right.command ? -1 : 1),
          ),
      }
    },

    latency: (
      tenant: string,
      actorType: string | undefined,
      window: LiveWindow,
      nowMs: number,
    ): Latency | undefined => {
      const since = sinceOf(tenant)

      if (since === undefined) return undefined

      const { size, slots, hours } = windowOf(window)
      const first = Math.floor(nowMs / size) * size - (slots - 1) * size
      const { histogram, max } = histogramOf(buckets(tenant, actorType, hours, first))

      return {
        since,
        count: histogram.reduce((sum, count) => sum + count, 0),
        buckets: histogram.map((count, index) => ({ upToMs: milliseconds[index] ?? null, count })),
        p50Ms: quantile(histogram, max, 0.5),
        p95Ms: quantile(histogram, max, 0.95),
        p99Ms: quantile(histogram, max, 0.99),
      }
    },

    rates: (tenant: string, actorType: string | undefined, nowMs: number): Rates | undefined => {
      const since = sinceOf(tenant)

      if (since === undefined) return undefined

      const current = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
      const recent = buckets(tenant, actorType, false, current - 4 * MINUTE_MS)
      const hour = histogramOf(buckets(tenant, actorType, false, current - 59 * MINUTE_MS))
      const seconds = Math.max(nowMs - Math.max(current - 4 * MINUTE_MS, since), 1) / 1000

      return {
        perSecond: recent.reduce((sum, bucket) => sum + bucket.total, 0) / seconds,
        p50Ms: quantile(hour.histogram, hour.max, 0.5),
        p99Ms: quantile(hour.histogram, hour.max, 0.99),
      }
    },

    /** The actor types `tenant` committed a turn of in the last 7 days on this runner. */
    actorTypes: (tenant: string) => [...(tenants.get(tenant)?.types.keys() ?? [])],

    /**
     * Counts one command that wrote a receipt. `durationMs` is its turn's
     * transaction time; `nowMs` is the runner's clock when its batch was
     * published, which places it in its minute and hour.
     */
    record: (
      tenant: string,
      actorType: string,
      command: string,
      failed: boolean,
      durationMs: number,
      nowMs: number,
    ) => {
      const entry = recorded(tenant, nowMs)
      entry.lastMs = nowMs
      let series = entry.types.get(actorType)

      if (series === undefined) {
        series = { minutes: [], hours: [] }
        entry.types.set(actorType, series)
      }

      const slot = bucketIndex(durationMs)

      add(
        bucketAt(
          series.minutes,
          Math.floor(nowMs / MINUTE_MS) * MINUTE_MS,
          MINUTE_MS,
          MINUTES_KEPT,
        ),
        command,
        failed,
        durationMs,
        slot,
      )
      add(
        bucketAt(series.hours, Math.floor(nowMs / HOUR_MS) * HOUR_MS, HOUR_MS, HOURS_KEPT),
        command,
        failed,
        durationMs,
        slot,
      )
    },

    /**
     * Hands one committed command to the tenant's streams. Unless the tenant
     * has a stream open, or had one within `STREAM_GRACE_MS`, this is one map
     * lookup and `source` is never called.
     */
    publish: (tenant: string, nowMs: number, source: () => StreamSource) => {
      const watch = watches.get(tenant)

      if (watch === undefined) return

      if (watch.subscribers.size === 0 && nowMs > watch.until) {
        watches.delete(tenant)

        return
      }

      const read = source()
      watch.seq += 1

      const entry: StreamEntry = {
        id: `${watch.epoch}.${watch.seq}`,
        seq: watch.seq,
        commandId: read.commandId,
        atMs: read.atMs,
        durationMs: read.durationMs,
        actorType: read.actorType,
        actorId: read.actorId,
        command: read.command,
        callerKey: read.callerKey,
        failed: read.failed,
        errorTag: read.failed ? failureTag(read.failure) : null,
        payloadPreview: payloadPreview(read.payload),
      }

      watch.ring.push(entry)
      if (watch.ring.length > STREAM_RING) watch.ring.shift()

      for (const subscriber of watch.subscribers)
        if (
          !subscriber.overflowed &&
          matches(subscriber.filter, entry) &&
          !Queue.offerUnsafe(subscriber.queue, entry)
        ) {
          subscriber.overflowed = true
          Queue.endUnsafe(subscriber.queue)
        }
    },

    /**
     * Opens one of `tenant`'s command streams, or undefined when this runner
     * already holds `MAX_TENANT_STREAMS` for it or `MAX_STREAMS` in all.
     * `after` is the id of the last entry a previous stream sent: entries the
     * ring still holds after it are sent first, and an id from another epoch,
     * or one the ring no longer reaches, starts with a gap and ends. A stream
     * that falls `STREAM_BUFFER` entries behind ends with a gap.
     */
    subscribe: Effect.fnUntraced(function* (
      tenant: string,
      filter: StreamFilter,
      after: string | undefined,
      nowMs: number,
    ) {
      let watch = watches.get(tenant)

      if (streams >= MAX_STREAMS || (watch?.subscribers.size ?? 0) >= MAX_TENANT_STREAMS)
        return undefined

      if (watch === undefined || (watch.subscribers.size === 0 && nowMs > watch.until)) {
        watchEpochs += 1
        watch = {
          epoch: `${options.epoch}-${watchEpochs}`,
          subscribers: new Set(),
          ring: [],
          seq: 0,
          until: nowMs,
        }
        watches.set(tenant, watch)
      }

      const opened = watch
      const oldest = opened.ring[0]?.seq ?? opened.seq + 1
      const seq = after === undefined ? undefined : sequenceOf(after)

      const gapFirst =
        after !== undefined &&
        (after.slice(0, after.lastIndexOf(".")) !== opened.epoch ||
          seq === undefined ||
          !Number.isSafeInteger(seq) ||
          seq > opened.seq ||
          seq < oldest - 1)

      const subscriber: Subscriber = {
        filter,
        queue: yield* Queue.bounded<StreamEntry, Cause.Done>(STREAM_BUFFER),
        overflowed: false,
      }

      const replay =
        seq === undefined || gapFirst
          ? []
          : opened.ring.filter((entry) => entry.seq > seq && matches(filter, entry))

      opened.subscribers.add(subscriber)
      streams += 1

      const release = Effect.flatMap(Clock.currentTimeMillis, (releasedMs) =>
        Effect.sync(() => {
          if (!opened.subscribers.delete(subscriber)) return

          streams -= 1
          opened.until = releasedMs + STREAM_GRACE_MS
        }),
      )

      if (gapFirst) return Stream.succeed(StreamMessage.gap()).pipe(Stream.ensuring(release))

      return Stream.fromIterable(replay.map((entry) => StreamMessage.command({ entry }))).pipe(
        Stream.concat(
          Stream.fromQueue(subscriber.queue).pipe(
            Stream.map((entry) => StreamMessage.command({ entry })),
          ),
        ),
        Stream.concat(
          Stream.suspend(() =>
            subscriber.overflowed ? Stream.succeed(StreamMessage.gap()) : Stream.empty,
          ),
        ),
        Stream.ensuring(release),
      )
    }),
  }
}

/** The recorder `liveRecorder` builds. */
export type LiveRecorder = ReturnType<typeof liveRecorder>

/** One activation resident on this runner. */
export interface Resident {
  readonly actorType: string
  readonly actorId: string
  /** Commands waiting in its mailbox, not yet taken into a batch. */
  readonly mailbox: number
}

/** One open connection this runner holds or serves. */
export interface OpenConnection {
  readonly actorType: string
  readonly actorId: string
  readonly kind: "socket" | "feed" | "watch" | "stream"
  /** A feed's event names; empty for any other kind. */
  readonly events: ReadonlyArray<string>
}

/** One cron entry a registered actor type declares. */
export interface DeclaredSchedule {
  readonly actorType: string
  readonly key: string
  readonly command: string
}

/**
 * What this runner knows only in memory, for the inspector's live reads:
 * its recorder, the activations resident on it and their mailboxes, the
 * connections it holds, the cron entries it registers, and how many other
 * runners the cluster lists. Each read names one tenant.
 */
export class LiveRuntime extends Context.Service<
  LiveRuntime,
  {
    readonly recorder: LiveRecorder
    readonly resident: (tenant: string) => ReadonlyArray<Resident>
    readonly connections: (tenant: string) => ReadonlyArray<OpenConnection>
    readonly schedules: () => ReadonlyArray<DeclaredSchedule>
    /** Other runners the cluster's runner storage lists, healthy or not; undefined when unknown. */
    readonly peers: Effect.Effect<number | undefined>
    /** Counts one served SSE stream member until the returned release runs. */
    readonly streamOpened: (ref: {
      readonly tenant: string
      readonly actor: string
      readonly id: string
    }) => () => void
  }
>()("@rikalabs/akter/runtime/telemetry/live/LiveRuntime") {}
