/** A linear axis from zero to a rounded maximum, with the tick values drawn on it. */
export interface Axis {
  readonly max: number
  readonly ticks: ReadonlyArray<number>
}

const STEPS = [1, 2, 2.5, 5, 10]

/**
 * Chooses a rounded axis maximum at or above `largest`, with three to five evenly spaced ticks, so
 * gridlines fall on numbers a reader can say aloud.
 */
export const niceAxis = (largest: number): Axis => {
  if (largest <= 0) return { max: 1, ticks: [0, 1] }

  const magnitude = 10 ** Math.floor(Math.log10(largest / 4))
  const step =
    STEPS.map((factor) => factor * magnitude).find((candidate) => candidate * 5 >= largest) ??
    10 * magnitude
  const count = Math.ceil(largest / step - 1e-9)
  const ticks = Array.from({ length: count + 1 }, (_, index) =>
    Number((index * step).toPrecision(12)),
  )

  return { max: Number((count * step).toPrecision(12)), ticks }
}

/** A value's position along the axis as a percentage, clamped so a nonzero bar stays visible. */
export const percentOf = (value: number, axis: Axis): number =>
  Math.max(0, Math.min(100, (value / axis.max) * 100))

/** Formats a measurement the way the report prints it: grouped digits, trailing zeros trimmed. */
export const formatMeasurement = (value: number, unit: "op/s" | "ms"): string =>
  value.toLocaleString("en-US", {
    maximumFractionDigits: value >= 100 ? 0 : unit === "ms" ? 3 : 1,
  })
