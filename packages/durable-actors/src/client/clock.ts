/** How long one round trip's sample of the database clock stays eligible. */
const SAMPLE_WINDOW_MS = 60_000

/** A response slower than this says too little about when the server stamped it. */
const MAX_SAMPLE_RTT_MS = 5_000

/** The least lead an id's issue time keeps behind the estimated database clock. */
const MIN_LEAD_MS = 1_000

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
    this.samples = [
      ...this.samples.filter((kept) => receivedAt - kept.at < SAMPLE_WINDOW_MS),
      sample,
    ]
  }

  private best(): Sample | undefined {
    const now = this.local()
    const recent = this.samples.filter((sample) => now - sample.at < SAMPLE_WINDOW_MS)

    if (recent.length === 0) return this.samples.at(-1)

    return recent.reduce((best, sample) => (sample.rtt < best.rtt ? sample : best))
  }

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

  /** A v1 command id issued behind the estimated database clock, with the deployment's window. */
  mint(retryWindowMs: number, uuid: string): string {
    const issuedAt = Math.floor(this.now() - Math.max(MIN_LEAD_MS, this.best()?.rtt ?? 0))

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

const TOKEN = /^(0|[1-9]\d*)$/

/**
 * The highest `durable-version` a client has seen: a non-negative decimal
 * string, ordered by length and then digits, never as a number.
 */
export class ConsistencyToken {
  private highest: string | undefined

  get value(): string | undefined {
    return this.highest
  }

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
