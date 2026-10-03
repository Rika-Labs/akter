/** A table cell read as the report prints it: the median of three rounds and the range. */
export interface Reading {
  readonly median: number
  readonly low: number
  readonly high: number
}

const NUMBER = "-?[\\d,]*\\.?\\d+"

const READING = new RegExp(`^(${NUMBER})(?:\\s*\\[(${NUMBER})\\s*[–-]\\s*(${NUMBER})\\])?$`)

const toNumber = (text: string): number => Number(text.replaceAll(",", ""))

/**
 * Reads a `median [low–high]` cell, or a bare number. Returns `null` for "not collected" and for
 * anything else that is not a measurement, so a missing case can never be mistaken for a zero.
 */
export const parseReading = (cell: string): Reading | null => {
  const match = READING.exec(cell.trim())

  if (match === null) return null

  const median = toNumber(match[1] ?? "")

  return {
    median,
    low: match[2] === undefined ? median : toNumber(match[2]),
    high: match[3] === undefined ? median : toNumber(match[3]),
  }
}

const splitRow = (line: string): ReadonlyArray<string> =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim())

/**
 * The data rows of the first table under the `##` or `###` heading `title`, each split into trimmed
 * cells.
 * Throws when the heading or its table is missing, so a reworded report fails the build instead of
 * silently publishing stale numbers.
 */
export const tableUnder = (
  markdown: string,
  title: string,
): ReadonlyArray<ReadonlyArray<string>> => {
  const lines = markdown.split("\n")
  const start = lines.findIndex(
    (line) => line.trim() === `### ${title}` || line.trim() === `## ${title}`,
  )

  if (start === -1) throw new Error(`BENCHMARKS.md has no "${title}" section`)

  const rows: Array<ReadonlyArray<string>> = []
  let seenTable = false

  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break

    if (line.trim().startsWith("|")) {
      seenTable = true
      rows.push(splitRow(line))
      continue
    }

    if (seenTable) break
  }

  const dataRows = rows.slice(2)

  if (dataRows.length === 0) throw new Error(`BENCHMARKS.md "${title}" has no table rows`)

  return dataRows
}

/** The cell of `row` at `column`, or a thrown error naming the table, never `undefined`. */
export const cellAt = (row: ReadonlyArray<string>, column: number): string => {
  const cell = row[column]

  if (cell === undefined)
    throw new Error(`BENCHMARKS.md row "${row[0] ?? ""}" has no column ${column}`)

  return cell
}

/** The row for `system` in a head-to-head table; throws when the report omits it. */
export const rowFor = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  system: string,
): ReadonlyArray<string> => {
  const row = rows.find((candidate) => candidate[0] === system)

  if (row === undefined) throw new Error(`BENCHMARKS.md table has no row for "${system}"`)

  return row
}
