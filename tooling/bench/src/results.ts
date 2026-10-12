/** Successful samples alone have percentiles; failures remain in the denominator and validity. */
export const percentile = (samples: ReadonlyArray<number>, fraction: number): number | null => {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new Error("Percentile must be in (0, 1]")
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * fraction) - 1]!
}

/** Each metric retains its own per-run value instead of pooling response times. */
export interface Metrics {
  readonly throughput: number | null
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly p99Ms: number | null
  readonly maxMs: number | null
  readonly appCpuMsPerSuccess: number | null
  readonly databaseCpuMsPerSuccess: number | null
  readonly sqlElapsedMsPerSuccess: number | null
  readonly flightsPerSuccess: number | null
  readonly statementsPerSuccess: number | null
  readonly rssBytesPerResident: number | null
}

/** Raw attempts and independent storage agreement are required before accepting a run. */
export interface Result {
  readonly schemaVersion: 1
  readonly sha: string
  readonly case: string
  readonly diagnostic: boolean
  readonly attempts: number
  readonly successes: number
  readonly failures: number
  readonly refusals: number
  readonly timeouts: number
  readonly dropped: number
  readonly elapsedMs: number
  readonly valid: boolean
  readonly metrics: Metrics
}

/** The comparison names noise by observed repeat ranges, not by an invented confidence level. */
export const compareMetric = (
  baseline: ReadonlyArray<number>,
  candidate: ReadonlyArray<number>,
  lowerIsBetter: boolean,
) => {
  if (baseline.length < 3 || candidate.length < 3)
    throw new Error("A comparison requires at least three repeats per side")
  const summarize = (values: ReadonlyArray<number>) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return {
      median:
        sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
      min: sorted[0]!,
      max: sorted.at(-1)!,
    }
  }
  const base = summarize(baseline)
  const head = summarize(candidate)
  const outsideNoise = head.max < base.min || head.min > base.max
  const changePercent = base.median === 0 ? null : (head.median / base.median - 1) * 100
  const improved = lowerIsBetter ? head.max < base.min : head.min > base.max
  return {
    base,
    head,
    changePercent,
    verdict: outsideNoise ? (improved ? "improved" : "regressed") : "overlapping",
  }
}
