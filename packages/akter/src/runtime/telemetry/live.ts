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

/** Minute slots kept: the last hour. */
const MINUTES_KEPT = 60

/** Hour slots kept: the last 7 days. */
const HOURS_KEPT = 168

/** Histogram slots per time slot: one per duration bound and one for slower turns. */
const BOUNDS = milliseconds.length + 1

/** The most tenants one runner records turns for; past it the least recently active is dropped. */
export const MAX_RECORDED_TENANTS = 64

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

/** The longest encoded payload or failure a preview or error tag is read from; a longer one has none. */
export const PREVIEW_INPUT_CHARACTERS = 16_384

const PREVIEW_DEPTH = 3

const PREVIEW_MEMBERS = 8

const PREVIEW_STRING = 32

const REDACTED = '"[redacted]"'

/** Words in a key that mark its value as a credential or personal data. */
const SENSITIVE_WORDS = new Set([
  "pass",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "key",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "session",
  "sid",
  "card",
  "pan",
  "cvv",
  "cvc",
  "ssn",
  "sin",
  "email",
  "mail",
  "phone",
  "mobile",
  "tel",
  "dob",
  "birth",
  "birthday",
  "birthdate",
  "address",
  "addr",
  "street",
  "zip",
  "postcode",
  "postal",
  "iban",
  "bic",
  "swift",
  "account",
  "routing",
  "ip",
  "signature",
  "otp",
  "pin",
  "private",
])

/** Fragments that mark a key as sensitive wherever they appear in it. */
const SENSITIVE_FRAGMENTS =
  /pass|secret|token|auth|cookie|credential|session|e-?mail|phone|address|birth|iban|ssn|cvv/i

/** A key or string value that is itself personal data or a credential. */
const PERSONAL =
  /[^\s@]+@[^\s@]+\.[^\s@]+|^\s*bearer\s|^\s*basic\s|^\d{1,3}(?:\.\d{1,3}){3}$|^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/i

/** Members that name the field a sibling `value` holds, as header and form-field lists do. */
const NAMING_MEMBERS = ["name", "key", "header", "field"] as const

const NAMED_MEMBERS = new Set(["value", "values"])

/** Splits `apiToken`, `api_token` and `API-Token` alike into lowercase words. */
const wordsOf = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)

const sensitiveKey = (key: string) =>
  SENSITIVE_FRAGMENTS.test(key) || wordsOf(key).some((word) => SENSITIVE_WORDS.has(word))

const truncated = (text: string, length: number) =>
  text.length <= length ? text : `${text.slice(0, length)}…`

const quoted = (text: string) => JSON.stringify(truncated(text, PREVIEW_STRING))

const isArray = Schema.is(Schema.Array(Schema.Json))

/**
 * One value of a payload as the preview shows it: at most `PREVIEW_MEMBERS`
 * members of an object or array, `PREVIEW_DEPTH` levels down, strings cut to
 * `PREVIEW_STRING` characters, and anything that is or names a credential or
 * personal data replaced, so the walk is bounded however large the payload.
 */
const render = (value: Schema.Json, depth: number): string => {
  if (value === null || Predicate.isBoolean(value) || Predicate.isNumber(value))
    return String(value)

  if (Predicate.isString(value)) return PERSONAL.test(value) ? REDACTED : quoted(value)

  if (isArray(value)) {
    if (depth >= PREVIEW_DEPTH) return "[…]"

    const shown = value.slice(0, PREVIEW_MEMBERS).map((item) => render(item, depth + 1))

    return `[${[...shown, ...(value.length > PREVIEW_MEMBERS ? ["…"] : [])].join(",")}]`
  }

  if (depth >= PREVIEW_DEPTH) return "{…}"

  const named = NAMING_MEMBERS.some((member) => {
    const naming = value[member]

    return Predicate.isString(naming) && (sensitiveKey(naming) || PERSONAL.test(naming))
  })
  const entries = Object.entries(value)
  const shown = entries.slice(0, PREVIEW_MEMBERS).map(([key, member]) => {
    if (PERSONAL.test(key)) return `${REDACTED}:${REDACTED}`

    return `${quoted(key)}:${
      sensitiveKey(key) || (named && NAMED_MEMBERS.has(key)) ? REDACTED : render(member, depth + 1)
    }`
  })

  return `{${[...shown, ...(entries.length > PREVIEW_MEMBERS ? ["…"] : [])].join(",")}}`
}

const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) })),
)

const decodeFailureTag = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
)

/**
 * A short, redacted rendering of a payload encoded as `{ "value": ... }`,
 * null when it carries none or is longer than `PREVIEW_INPUT_CHARACTERS`. A
 * top-level string is never shown, since nothing names what it holds. It is
 * built on the runner, so the payload itself never leaves it.
 */
export const payloadPreview = (encoded: string): string | null => {
  if (encoded.length > PREVIEW_INPUT_CHARACTERS) return null

  return Option.match(decodePayload(encoded), {
    onNone: () => null,
    onSome: ({ value }) => {
      if (value === undefined) return null

      if (Predicate.isString(value)) return REDACTED

      return truncated(render(value as Schema.Json, 0), PREVIEW_CHARACTERS - 1)
    },
  })
}

/** The `_tag` of an encoded declared failure, or null when it has none or is too long to read. */
const failureTag = (encoded: string | undefined) =>
  encoded === undefined || encoded.length > PREVIEW_INPUT_CHARACTERS
    ? null
    : Option.match(decodeFailureTag(encoded), {
        onNone: () => null,
        onSome: (failure) => failure._tag,
      })

/**
 * One time series in fixed slots, reused as time moves on: a slot holds the
 * turns of the interval its `starts` entry names and is cleared when a later
 * interval claims it. Each command's counts are a slot-indexed array, so a
 * series costs a few typed arrays however many turns it counts.
 */
interface Ring {
  readonly size: number
  readonly slots: number
  readonly starts: Float64Array
  readonly totals: Uint32Array
  readonly histogram: Uint32Array
  readonly max: Float64Array
  readonly commands: Map<string, Uint32Array>
}

const ringOf = (size: number, slots: number): Ring => ({
  size,
  slots,
  starts: new Float64Array(slots).fill(-1),
  totals: new Uint32Array(slots),
  histogram: new Uint32Array(slots * BOUNDS),
  max: new Float64Array(slots),
  commands: new Map(),
})

const indexOf = (ring: Ring, start: number) => (start / ring.size) % ring.slots

/** The slot for the interval starting at `start`, cleared first if an older interval held it. */
const claim = (ring: Ring, start: number) => {
  const index = indexOf(ring, start)

  if (ring.starts[index] !== start) {
    ring.starts[index] = start
    ring.totals[index] = 0
    ring.histogram.fill(0, index * BOUNDS, (index + 1) * BOUNDS)
    ring.max[index] = 0
    for (const counts of ring.commands.values()) counts[index] = 0
  }

  return index
}

/** The slot holding the interval starting at `start`, or undefined when no turn of it is kept. */
const held = (ring: Ring, start: number) => {
  const index = indexOf(ring, start)

  return ring.starts[index] === start ? index : undefined
}

const boundOf = (durationMs: number) => {
  for (let index = 0; index < milliseconds.length; index++)
    if (durationMs <= milliseconds[index]!) return index

  return milliseconds.length
}

const add = (ring: Ring, nowMs: number, command: string, durationMs: number) => {
  const index = claim(ring, Math.floor(nowMs / ring.size) * ring.size)
  let counts = ring.commands.get(command)

  if (counts === undefined) {
    counts = new Uint32Array(ring.slots)
    ring.commands.set(command, counts)
  }

  ring.totals[index]! += 1
  ring.histogram[index * BOUNDS + boundOf(durationMs)]! += 1
  if (durationMs > ring.max[index]!) ring.max[index] = durationMs
  counts[index]! += 1
}

interface Series {
  readonly minutes: Ring
  readonly hours: Ring
}

interface Recorded {
  readonly since: number
  readonly types: Map<string, Series>
  lastMs: number
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

/** One window's ring and how many of its slots the window spans. */
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

const matches = (filter: StreamFilter, entry: Pick<StreamEntry, "actorType" | "failed">) =>
  (filter.actorType === undefined || filter.actorType === entry.actorType) &&
  (filter.failed === undefined || filter.failed === entry.failed)

/**
 * Committed turns of this runner, by tenant and actor type, in minute slots
 * for an hour and hour slots for 7 days, and the live command stream. Every
 * read is one tenant's. Nothing here survives the process. A tenant costs a
 * few typed arrays per actor type it ran (about 20 KiB, and under 1 KiB per
 * command), and at most `MAX_RECORDED_TENANTS` are kept.
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

  /** The rings of `tenant` for one type, or every type. */
  const ringsOf = (tenant: string, actorType: string | undefined, hours: boolean) => {
    const entry = tenants.get(tenant)

    if (entry === undefined) return []

    const series =
      actorType === undefined
        ? [...entry.types.values()]
        : entry.types.has(actorType)
          ? [entry.types.get(actorType)!]
          : []

    return series.map((found) => (hours ? found.hours : found.minutes))
  }

  /** Every slot start from `first` to `current`, `size` apart. */
  const startsOf = (first: number, current: number, size: number) => {
    const starts: Array<number> = []

    for (let start = first; start <= current; start += size) starts.push(start)

    return starts
  }

  /** The histogram and slowest turn of `rings` over the slots starting at `starts`. */
  const histogramOf = (rings: ReadonlyArray<Ring>, starts: ReadonlyArray<number>) => {
    const histogram = Array.from({ length: BOUNDS }, () => 0)
    let max = 0

    for (const ring of rings)
      for (const start of starts) {
        const index = held(ring, start)

        if (index === undefined) continue

        for (let bound = 0; bound < BOUNDS; bound++)
          histogram[bound]! += ring.histogram[index * BOUNDS + bound]!
        if (ring.max[index]! > max) max = ring.max[index]!
      }

    return { histogram, max }
  }

  const totalOf = (rings: ReadonlyArray<Ring>, starts: ReadonlyArray<number>) => {
    let total = 0

    for (const ring of rings)
      for (const start of starts) {
        const index = held(ring, start)

        if (index !== undefined) total += ring.totals[index]!
      }

    return total
  }

  /** Ends watches no stream holds whose grace has passed, so a quiet tenant keeps no ring. */
  const sweep = (nowMs: number) => {
    for (const [tenant, watch] of watches)
      if (watch.subscribers.size === 0 && nowMs > watch.until) watches.delete(tenant)
  }

  /**
   * Takes a stream's slot and computes what it replays in one step after its
   * queue exists, so no command published meanwhile is both replayed and
   * queued, or neither. Undefined when the stream gets only a gap: the runner
   * is full, or `after` names an entry this runner no longer holds.
   */
  const open = Effect.fnUntraced(function* (
    tenant: string,
    filter: StreamFilter,
    after: string | undefined,
  ) {
    const queue = yield* Queue.bounded<StreamEntry, Cause.Done>(STREAM_BUFFER)
    const nowMs = yield* Clock.currentTimeMillis

    sweep(nowMs)

    const existing = watches.get(tenant)

    if (streams >= MAX_STREAMS || (existing?.subscribers.size ?? 0) >= MAX_TENANT_STREAMS)
      return undefined

    if (after !== undefined) {
      const seq = sequenceOf(after)

      if (
        existing === undefined ||
        after.slice(0, after.lastIndexOf(".")) !== existing.epoch ||
        !Number.isSafeInteger(seq) ||
        seq > existing.seq ||
        seq < (existing.ring[0]?.seq ?? existing.seq + 1) - 1
      )
        return undefined
    }

    let watch = existing

    if (watch === undefined) {
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

    const seq = after === undefined ? undefined : sequenceOf(after)
    const replay =
      seq === undefined
        ? []
        : watch.ring.filter((entry) => entry.seq > seq && matches(filter, entry))
    const subscriber: Subscriber = { filter, queue, overflowed: false }

    watch.subscribers.add(subscriber)
    streams += 1

    return { watch, subscriber, replay }
  })

  const release = (opened: Effect.Success<ReturnType<typeof open>>) =>
    opened === undefined
      ? Effect.void
      : Effect.flatMap(Clock.currentTimeMillis, (releasedMs) =>
          Effect.sync(() => {
            if (!opened.watch.subscribers.delete(opened.subscriber)) return

            streams -= 1
            opened.watch.until = releasedMs + STREAM_GRACE_MS
            sweep(releasedMs)
          }),
        )

  return {
    startedAtMs: options.startedAtMs,

    /** How many command streams this runner holds open now. */
    streams: () => streams,

    /** How many tenants this runner holds a stream ring for now. */
    watched: () => watches.size,

    /** Whether a new stream of `tenant` would be refused now. */
    full: (tenant: string) =>
      streams >= MAX_STREAMS || (watches.get(tenant)?.subscribers.size ?? 0) >= MAX_TENANT_STREAMS,

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
      const rings = ringsOf(tenant, actorType, hours)
      const points: Array<{ atMs: number; perSecond: number }> = []

      for (const start of startsOf(first, current, size)) {
        const seconds = (Math.min(start + size, nowMs) - Math.max(start, since)) / 1000

        if (seconds <= 0) continue

        points.push({ atMs: start, perSecond: totalOf(rings, [start]) / seconds })
      }

      const volumes = new Map<string, number>()

      for (const ring of rings)
        for (const [command, counts] of ring.commands)
          for (const start of startsOf(first, current, size)) {
            const index = held(ring, start)

            if (index !== undefined && counts[index]! > 0)
              volumes.set(command, (volumes.get(command) ?? 0) + counts[index]!)
          }

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
      const current = Math.floor(nowMs / size) * size
      const { histogram, max } = histogramOf(
        ringsOf(tenant, actorType, hours),
        startsOf(current - (slots - 1) * size, current, size),
      )

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
      const rings = ringsOf(tenant, actorType, false)
      const recent = totalOf(rings, startsOf(current - 4 * MINUTE_MS, current, MINUTE_MS))
      const hour = histogramOf(rings, startsOf(current - 59 * MINUTE_MS, current, MINUTE_MS))
      const seconds = Math.max(nowMs - Math.max(current - 4 * MINUTE_MS, since), 1) / 1000

      return {
        perSecond: recent / seconds,
        p50Ms: quantile(hour.histogram, hour.max, 0.5),
        p99Ms: quantile(hour.histogram, hour.max, 0.99),
      }
    },

    /** The actor types `tenant` committed a turn of on this runner. */
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
      durationMs: number,
      nowMs: number,
    ) => {
      const entry = recorded(tenant, nowMs)
      entry.lastMs = nowMs
      let series = entry.types.get(actorType)

      if (series === undefined) {
        series = { minutes: ringOf(MINUTE_MS, MINUTES_KEPT), hours: ringOf(HOUR_MS, HOURS_KEPT) }
        entry.types.set(actorType, series)
      }

      add(series.minutes, nowMs, command, durationMs)
      add(series.hours, nowMs, command, durationMs)
    },

    /**
     * Hands one committed command to the tenant's streams. Unless the tenant
     * has a stream open, or had one within `STREAM_GRACE_MS`, this is one map
     * lookup and `source` is never called. The payload preview is built only
     * when an open stream takes the command, so the ring kept for a reconnect
     * during the grace holds none.
     */
    publish: (tenant: string, nowMs: number, source: () => StreamSource) => {
      const watch = watches.get(tenant)

      if (watch === undefined) return

      if (watch.subscribers.size === 0 && nowMs > watch.until) {
        watches.delete(tenant)

        return
      }

      const read = source()
      const takers = [...watch.subscribers].filter(
        (subscriber) => !subscriber.overflowed && matches(subscriber.filter, read),
      )
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
        payloadPreview: takers.length === 0 ? null : payloadPreview(read.payload),
      }

      watch.ring.push(entry)
      if (watch.ring.length > STREAM_RING) watch.ring.shift()

      for (const subscriber of takers)
        if (!Queue.offerUnsafe(subscriber.queue, entry)) {
          subscriber.overflowed = true
          Queue.endUnsafe(subscriber.queue)
        }
    },

    /**
     * One of `tenant`'s command streams. Its slot is taken only when the
     * stream starts and given back when it ends however it ends, so a request
     * interrupted before its body starts holds none. `after` is the id of the
     * last entry a previous stream sent: entries the ring still holds after it
     * are sent first, and an id from another epoch, or one the ring no longer
     * reaches, sends a gap and ends. A stream that falls `STREAM_BUFFER`
     * entries behind ends with a gap, and so does one opened when this runner
     * already holds `MAX_TENANT_STREAMS` for the tenant or `MAX_STREAMS` in all.
     */
    subscribe: (
      tenant: string,
      filter: StreamFilter,
      after: string | undefined,
    ): Stream.Stream<StreamMessage> =>
      Stream.unwrap(
        Effect.acquireRelease(open(tenant, filter, after), release).pipe(
          Effect.map((opened) => {
            if (opened === undefined) return Stream.succeed(StreamMessage.gap())

            const { subscriber, replay } = opened

            return Stream.fromIterable(
              replay.map((entry) => StreamMessage.command({ entry })),
            ).pipe(
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
            )
          }),
        ),
      ),
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
 * runners the cluster lists. Each read names one tenant. The recorder exists
 * only once `enable` ran, which `Inspector.serve` does when it is mounted, so
 * a runtime nobody inspects counts nothing.
 */
export class LiveRuntime extends Context.Service<
  LiveRuntime,
  {
    /** The recorder, or undefined until `enable` ran. */
    readonly recorder: () => LiveRecorder | undefined
    /** Builds the recorder on first use and returns it; it counts from then on. */
    readonly enable: Effect.Effect<LiveRecorder>
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
