/**
 * The tick step nearest to `span / count` on a log scale, drawn from 1, 2, 2.5 and 5 times a power
 * of ten so axis labels read as round numbers. Each threshold is the geometric mean of its two
 * neighbouring factors, so a raw step of 1.05 rounds down to 1 rather than up to 2.
 */
export const niceStep = (input: Readonly<{ span: number; count: number }>): number => {
  if (input.span <= 0 || input.count <= 0) return 1
  const raw = input.span / input.count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const residual = raw / magnitude
  const factor =
    residual < Math.SQRT2
      ? 1
      : residual < Math.sqrt(5)
        ? 2
        : residual < Math.sqrt(12.5)
          ? 2.5
          : residual < Math.sqrt(50)
            ? 5
            : 10
  return factor * magnitude
}

/** A domain widened to round ends and the ticks inside it, low to high. */
export interface NiceTicks {
  readonly min: number
  readonly max: number
  readonly step: number
  readonly ticks: ReadonlyArray<number>
}

const round = (value: number, step: number): number => {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  return Number(value.toFixed(decimals))
}

/**
 * Round ticks covering `[min, max]` with roughly `count` intervals. The domain grows outward to the
 * nearest ticks; a flat domain grows by one step above so a constant series still has an axis.
 */
export const niceTicks = (
  input: Readonly<{ min: number; max: number; count: number }>,
): NiceTicks => {
  const flat = input.max === input.min
  const span = flat ? Math.max(Math.abs(input.max), 1) : input.max - input.min
  const step = niceStep({ span, count: input.count })
  const min = Math.floor(input.min / step) * step
  const max = flat ? min + step * Math.max(1, input.count) : Math.ceil(input.max / step) * step
  const ticks: Array<number> = []
  for (let tick = min; tick <= max + step / 2; tick += step) ticks.push(round(tick, step))
  return { min: round(min, step), max: round(max, step), step, ticks }
}

/** Index positions for at most `count` evenly spread labels across `length` points, ends included. */
export const labelIndices = (
  input: Readonly<{ length: number; count: number }>,
): ReadonlyArray<number> => {
  if (input.length <= 0) return []
  if (input.length <= input.count) return Array.from({ length: input.length }, (_, index) => index)
  const last = input.length - 1
  const slots = Math.max(1, input.count - 1)
  return Array.from({ length: slots + 1 }, (_, slot) => Math.round((slot * last) / slots))
}
