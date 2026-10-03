/** A closed interval, low end first. */
export type Interval = readonly [number, number]

/** Maps a data interval onto a pixel (or percentage) interval and back. */
export interface LinearScale {
  readonly domain: Interval
  readonly range: Interval
  readonly map: (value: number) => number
  readonly invert: (position: number) => number
}

/**
 * A linear scale. A zero-width domain maps everything to the middle of the range rather than
 * dividing by zero, so a flat series still draws as a centred line.
 */
export const linearScale = (
  input: Readonly<{ domain: Interval; range: Interval }>,
): LinearScale => {
  const [d0, d1] = input.domain
  const [r0, r1] = input.range
  const span = d1 - d0
  return {
    domain: input.domain,
    range: input.range,
    map: (value) => (span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0)),
    invert: (position) => (r1 === r0 ? d0 : d0 + ((position - r0) / (r1 - r0)) * span),
  }
}

/**
 * A base-10 logarithmic scale for values spanning orders of magnitude, such as latency buckets.
 * Values at or below zero clamp to the domain's low end.
 */
export const logScale = (input: Readonly<{ domain: Interval; range: Interval }>): LinearScale => {
  const [d0, d1] = input.domain
  const inner = linearScale({ domain: [Math.log10(d0), Math.log10(d1)], range: input.range })
  return {
    domain: input.domain,
    range: input.range,
    map: (value) => inner.map(Math.log10(Math.max(value, d0))),
    invert: (position) => 10 ** inner.invert(position),
  }
}

/** Evenly spaced bands for bar charts: where each band starts and how wide its bar is. */
export interface BandScale {
  readonly step: number
  readonly bandwidth: number
  readonly start: (index: number) => number
  readonly center: (index: number) => number
}

/**
 * Splits `range` into `count` bands. `padding` is the share of each step left empty between bars,
 * split evenly on both sides so the first and last bars sit as far from the edges as from each other.
 */
export const bandScale = (
  input: Readonly<{ count: number; range: Interval; padding: number }>,
): BandScale => {
  const [r0, r1] = input.range
  const step = input.count === 0 ? 0 : (r1 - r0) / input.count
  const bandwidth = step * (1 - input.padding)
  const inset = (step - bandwidth) / 2
  return {
    step,
    bandwidth,
    start: (index) => r0 + index * step + inset,
    center: (index) => r0 + index * step + step / 2,
  }
}

/** The smallest and largest of `values`; an empty list is the unit interval at zero. */
export const extent = (values: ReadonlyArray<number>): Interval =>
  values.length === 0 ? [0, 0] : [Math.min(...values), Math.max(...values)]
