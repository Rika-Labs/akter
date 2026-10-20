/** The vertical interval of one entry's text in the contents list, in pixels from its top. */
export interface Span {
  readonly top: number
  readonly bottom: number
}

/** The two indents of the list: the entry and the entry under it. */
const level = (depth: number): 2 | 3 => (depth >= 3 ? 3 : 2)

const LINE = 20

const GAP = 6

/**
 * Where each entry's text sits when every entry fits on one line, which is what the server can
 * know. The first entry has no space above it and the last none below it, and every other
 * entry has 6 px of space above and below, so each entry's text begins one line and two gaps
 * after the one before it.
 */
export const estimatedSpans = (count: number): ReadonlyArray<Span> =>
  Array.from({ length: count }, (_, index) => ({
    top: index * (LINE + GAP * 2),
    bottom: index * (LINE + GAP * 2) + LINE,
  }))

/**
 * The one path that runs down the left of the entries: a vertical stroke beside the text of
 * each entry, joined to the next entry's stroke by a straight line, which is vertical where the
 * level stays and a slant where it changes.
 */
export const railPath = (spans: ReadonlyArray<Span>, depths: ReadonlyArray<number>): string =>
  spans
    .map(({ top, bottom }, index) => {
      const x = level(depths[index] ?? 2) === 2 ? 0.5 : 12.5

      return `${index === 0 ? "M" : "L"}${x} ${top} L${x} ${bottom}`
    })
    .join(" ")

/**
 * The part of the rail the thumb covers: from the top of the first entry in view to the bottom
 * of the last, or nothing when no entry is in view. It covers the text of those entries and not
 * the space around them, so the stroke past the last entry's text keeps the colour of the rest.
 */
export const thumbRange = (
  spans: ReadonlyArray<Span>,
  active: ReadonlyArray<boolean>,
): readonly [number, number] => {
  const first = active.indexOf(true)
  const last = active.lastIndexOf(true)

  return first === -1 ? [0, 0] : [spans[first]?.top ?? 0, spans[last]?.bottom ?? 0]
}
