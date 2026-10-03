/** One histogram bucket: the count of observations at or below `upper` and above the previous bucket. */
export interface Bucket {
  readonly upper: number
  readonly count: number
}

/**
 * The value below which `quantile` of the observations fall, interpolated inside the bucket that
 * crosses it the way Prometheus' `histogram_quantile` does. The first bucket's lower bound is zero.
 */
export const bucketQuantile = (
  input: Readonly<{ buckets: ReadonlyArray<Bucket>; quantile: number }>,
): number => {
  const total = input.buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  if (total === 0) return 0
  const target = total * input.quantile
  let seen = 0
  let lower = 0
  for (const bucket of input.buckets) {
    if (seen + bucket.count >= target && bucket.count > 0)
      return lower + ((target - seen) / bucket.count) * (bucket.upper - lower)
    seen += bucket.count
    lower = bucket.upper
  }
  return lower
}

/** Counts of `values` per bucket, given ascending upper `edges`; values above the last edge are dropped. */
export const toBuckets = (
  input: Readonly<{ values: ReadonlyArray<number>; edges: ReadonlyArray<number> }>,
): ReadonlyArray<Bucket> => {
  const counts = input.edges.map(() => 0)
  for (const value of input.values) {
    const index = input.edges.findIndex((edge) => value <= edge)
    if (index >= 0) counts[index] = (counts[index] ?? 0) + 1
  }
  return input.edges.map((upper, index) => ({ upper, count: counts[index] ?? 0 }))
}
