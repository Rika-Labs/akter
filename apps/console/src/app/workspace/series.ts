/**
 * A deterministic random walk for fixture charts: the same seed always draws the same line, so
 * screenshots and browser tests stay stable. Values never fall below a quarter of `base`.
 */
export const seededSeries = (
  input: Readonly<{ length: number; base: number; volatility: number; seed: number }>,
): ReadonlyArray<number> => {
  let state = input.seed
  let value = input.base
  return Array.from({ length: input.length }, () => {
    state = (state * 9301 + 49297) % 233280
    value = Math.max(input.base * 0.25, value + (state / 233280 - 0.48) * input.volatility)
    return Number(value.toFixed(2))
  })
}

/** Hour labels for the last day, oldest first, at `points` evenly spaced samples ending at `end`. */
export const hourLabels = (
  input: Readonly<{ points: number; end: number }>,
): ReadonlyArray<string> =>
  Array.from({ length: input.points }, (_, index) => {
    const minutes = Math.round(((input.points - 1 - index) * 24 * 60) / (input.points - 1))
    const total = (((input.end * 60 - minutes) % 1440) + 1440) % 1440
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
  })
