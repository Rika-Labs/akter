const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

const units: ReadonlyArray<readonly [number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
]

/** `1284` → `1,284`. */
export const formatInteger = (value: number): string => grouped.format(Math.round(value))

/**
 * Short counts for axes and stats: `1284` → `1.3K`, `41_200_000` → `41.2M`. Below ten thousand the
 * full grouped number is shorter to read than an abbreviation, so it stays whole.
 */
export const formatCompact = (value: number): string => {
  const magnitude = Math.abs(value)
  if (magnitude < 10_000) return Number.isInteger(value) ? formatInteger(value) : value.toFixed(1)
  const unit = units.find(([size]) => magnitude >= size)
  if (unit === undefined) return formatInteger(value)
  const scaled = value / unit[0]
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/u, "")}${unit[1]}`
}

/** Milliseconds as the console writes durations: `0.9 ms`, `41 ms`, `1.8 s`, `4 m 12 s`. */
export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 10) return `${milliseconds.toFixed(1)} ms`
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  const seconds = milliseconds / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} m ${Math.round(seconds - minutes * 60)} s`
}

/** A share as a whole percentage, or one decimal below one percent: `0.41` → `41%`. */
export const formatPercent = (share: number): string => {
  const percent = share * 100
  return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`
}

/** Dollars and cents: `206.7` → `$206.70`. */
export const formatCurrency = (amount: number): string =>
  `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
