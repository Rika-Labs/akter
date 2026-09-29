/** How long one round trip's sample of the database clock stays eligible. */
const SAMPLE_WINDOW_MS = 60_000

/** A response slower than this says too little about when the server stamped it. */
const MAX_SAMPLE_RTT_MS = 5_000

/** The least lead an id's issue time keeps behind the estimated database clock. */
const MIN_LEAD_MS = 1_000

/** The most samples kept; the slowest is dropped past this. */
const MAX_SAMPLES = 16

interface Sample {
  readonly offset: number
  readonly rtt: number
  readonly at: number
}

/** A monotonic local clock in epoch milliseconds, unaffected by wall-clock steps. */
export const monotonic = (): number => performance.timeOrigin + performance.now()

/**
 * The database clock as a client estimates it: the offset of the
 * lowest-latency round trip of the last minute, applied to a local clock.
 */
export class DatabaseClock {
  private samples: Array<Sample> = []

  constructor(private readonly local: () => number = monotonic) {}

  /** The local time now, for stamping a request before it is sent. */
  readonly localNow = (): number => this.local()

  /** Records a response's `durable-now`, stamped between `sentAt` and `receivedAt`. */
  observe(sentAt: number, receivedAt: number, serverNow: number): void {
    const rtt = Math.max(0, receivedAt - sentAt)

    if (!Number.isFinite(serverNow) || rtt > MAX_SAMPLE_RTT_MS) return

    const sample = { offset: serverNow - (sentAt + receivedAt) / 2, rtt, at: receivedAt }
    const kept = this.samples.filter((older) => receivedAt - older.at < SAMPLE_WINDOW_MS)

    kept.push(sample)

    if (kept.length > MAX_SAMPLES) {
      const slowest = kept.reduce(
        (worst, older, index) => (older.rtt > kept[worst]!.rtt ? index : worst),
        0,
      )

      kept.splice(slowest, 1)
    }

    this.samples = kept
  }

  private best(): Sample | undefined {
    const now = this.local()
    const recent = this.samples.filter((sample) => now - sample.at < SAMPLE_WINDOW_MS)

    if (recent.length === 0) return this.samples.at(-1)

    return recent.reduce((best, sample) => (sample.rtt < best.rtt ? sample : best))
  }

  /** Whether any response has been observed yet. */
  get isSampled(): boolean {
    return this.samples.length > 0
  }

  /** Whether a sample from the last minute exists; an older offset may have drifted. */
  get isFresh(): boolean {
    const now = this.local()

    return this.samples.some((sample) => now - sample.at < SAMPLE_WINDOW_MS)
  }

  /** Estimated database time; the local clock alone until a sample exists. */
  now(): number {
    return this.local() + (this.best()?.offset ?? 0)
  }

  /**
   * A v1 command id issued behind the estimated database clock, with the
   * deployment's window. The lead is at least a second and the sample's round
   * trip, but a short window caps it at a quarter of the window, never below the
   * sample's error.
   */
  mint(retryWindowMs: number, uuid: string): string {
    const rtt = this.best()?.rtt ?? 0
    const lead = Math.max(rtt / 2, Math.min(Math.max(MIN_LEAD_MS, rtt), retryWindowMs / 4))
    const issuedAt = Math.floor(this.now() - lead)

    return `v1.${issuedAt}.${issuedAt + retryWindowMs}.${uuid}`
  }
}

const V1 = /^v1\.(\d+)\.(\d+)\.[0-9a-f-]{36}$/i

/** The issue and expiry times of a v1 id, or `undefined` for any other string. */
export const lifetime = (commandId: string) => {
  const match = V1.exec(commandId)

  if (match === null) return undefined

  return { issuedAt: Number(match[1]), expiresAt: Number(match[2]) }
}

/** How long before its expiry retries of an id stop. */
const EXPIRY_MARGIN_MS = 1_000

/**
 * When retries of a v1 id stop, so no attempt races its own expiry: a second
 * before it expires, or a quarter of its window before when that is shorter.
 */
export const retryDeadline = (commandId: string) => {
  const issued = lifetime(commandId)

  if (issued === undefined) return undefined

  return issued.expiresAt - Math.min(EXPIRY_MARGIN_MS, (issued.expiresAt - issued.issuedAt) / 4)
}

const TOKEN = /^(0|[1-9]\d*)$/

/**
 * The highest `durable-version` a client has seen: a non-negative decimal
 * string, ordered by length and then digits, never as a number.
 */
export class ConsistencyToken {
  private highest: string | undefined

  /** The highest version seen, to send as `durable-min-version`; undefined until one is seen. */
  get value(): string | undefined {
    return this.highest
  }

  /** Records a response's `durable-version` header; a missing or malformed one is ignored. */
  observe(value: string | null): void {
    if (value === null || !TOKEN.test(value)) return

    const current = this.highest

    if (
      current === undefined ||
      value.length > current.length ||
      (value.length === current.length && value > current)
    )
      this.highest = value
  }
}
