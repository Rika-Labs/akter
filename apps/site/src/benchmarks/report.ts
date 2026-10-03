import report from "../../../../BENCHMARKS.md?raw"
import type { Reading } from "./parse-report.ts"
import { cellAt, parseReading, rowFor, tableUnder } from "./parse-report.ts"

/** The systems the report compares, as its tables name them and as the charts label them. */
const SYSTEMS = [
  { column: "Akter", name: "Akter" },
  { column: "Rivet default", name: "Rivet default" },
  { column: "Rivet saved", name: "Rivet saved" },
  { column: "workerd local", name: "workerd (local)" },
  { column: "Restate", name: "Restate" },
  { column: "Temporal", name: "Temporal" },
  { column: "DBOS", name: "DBOS" },
] as const

const BASELINES = [
  { column: "Postgres baseline", name: "Postgres" },
  { column: "Redis AOF-always", name: "Redis" },
] as const

/** One system's bar in a case: a reading, or `null` when the report did not collect it. */
export interface Measurement {
  readonly system: string
  readonly reading: Reading | null
  readonly errors: number
}

/** A plain-store baseline, which the charts print beside a case but never draw as a bar. */
export interface Baseline {
  readonly name: string
  readonly value: number
}

/** A benchmark case ready to chart. */
export interface BenchmarkCase {
  readonly title: string
  readonly lead: string
  readonly unit: "op/s" | "ms"
  readonly better: "higher" | "lower"
  readonly rows: ReadonlyArray<Measurement>
  readonly baselines: ReadonlyArray<Baseline>
  readonly note?: string | undefined
}

interface CaseSource {
  readonly table: string
  readonly valueColumn: number
  readonly errorColumn?: number
  readonly title: string
  readonly lead: string
  readonly unit: "op/s" | "ms"
  readonly note?: string
}

const SOURCES: ReadonlyArray<CaseSource> = [
  {
    table: "Sequential counter write (acknowledgement modes differ)",
    valueColumn: 2,
    errorColumn: 5,
    title: "Sequential write",
    lead: "One caller, one key. Successful acknowledged writes per second.",
    unit: "op/s",
  },
  {
    table: "One hot key, 64 callers",
    valueColumn: 2,
    errorColumn: 5,
    title: "One hot key, 64 callers",
    lead: "Every caller writes to the same identity. Successful writes per second.",
    unit: "op/s",
  },
  {
    table: "10,000 keys, 64 callers",
    valueColumn: 2,
    errorColumn: 5,
    title: "10,000 keys, 64 callers",
    lead: "Writes spread across many fresh identities. Successful writes per second.",
    unit: "op/s",
  },
  {
    table: "Sequential acknowledged-state read",
    valueColumn: 3,
    errorColumn: 5,
    title: "Sequential read",
    lead: "Committed-state read through HTTP. Median latency, lower is better.",
    unit: "ms",
  },
  {
    table: "Creation and idle wake",
    valueColumn: 1,
    errorColumn: 3,
    title: "First command to a new key",
    lead: "Creating an identity while the process is running. Median latency, lower is better.",
    unit: "ms",
  },
  {
    table: "Creation and idle wake",
    valueColumn: 4,
    title: "Wake after idle",
    lead: "First command after 15 s idle. Median latency, lower is better.",
    unit: "ms",
    note: "Only measured where an actor can hibernate.",
  },
]

const reading = (row: ReadonlyArray<string>, column: number): Reading | null =>
  parseReading(cellAt(row, column))

const required = (row: ReadonlyArray<string>, column: number): number => {
  const parsed = reading(row, column)

  if (parsed === null)
    throw new Error(`BENCHMARKS.md row "${row[0] ?? ""}" has no number in column ${column}`)

  return parsed.median
}

const ordered = (
  rows: ReadonlyArray<Measurement>,
  better: "higher" | "lower",
): ReadonlyArray<Measurement> => {
  const collected = rows
    .flatMap((row) => (row.reading === null ? [] : [row]))
    .toSorted((a, b) => {
      const left = a.reading?.median ?? 0
      const right = b.reading?.median ?? 0

      return better === "higher" ? right - left : left - right
    })

  return [...collected, ...rows.filter((row) => row.reading === null)]
}

const build = (source: CaseSource): BenchmarkCase => {
  const table = tableUnder(report, source.table)
  const better = source.unit === "op/s" ? "higher" : "lower"
  const measurements = SYSTEMS.map(({ column, name }): Measurement => {
    const row = rowFor(table, column)

    return {
      system: name,
      reading: reading(row, source.valueColumn),
      errors:
        source.errorColumn === undefined ? 0 : (reading(row, source.errorColumn)?.median ?? 0),
    }
  })
  const baselines =
    source.note === undefined
      ? BASELINES.flatMap(({ column, name }) => {
          const parsed = reading(rowFor(table, column), source.valueColumn)

          return parsed === null ? [] : [{ name, value: parsed.median }]
        })
      : []

  return {
    title: source.title,
    lead: source.lead,
    unit: source.unit,
    better,
    rows: ordered(measurements, better),
    baselines,
    note: source.note,
  }
}

/** The six charted cases, read from the report's head-to-head tables at build time. */
export const cases: ReadonlyArray<BenchmarkCase> = SOURCES.map(build)

/** The case with `title`; throws when the site's own source list no longer has it. */
export const caseTitled = (title: string): BenchmarkCase => {
  const found = cases.find((candidate) => candidate.title === title)

  if (found === undefined) throw new Error(`No benchmark case titled "${title}"`)

  return found
}

/** The hot-key case, which the landing page charts. */
export const hotKey: BenchmarkCase = caseTitled("One hot key, 64 callers")

const akterReading = (title: string): Reading => {
  const found = caseTitled(title).rows.find((row) => row.system === "Akter")?.reading

  if (found === null || found === undefined)
    throw new Error(`The report has no Akter reading for "${title}"`)

  return found
}

/** The four headline numbers, each read from Akter's row of the report's tables. */
export const headlines = {
  sequentialWriteP50: required(
    rowFor(tableUnder(report, "Sequential counter write (acknowledgement modes differ)"), "Akter"),
    3,
  ),
  hotKey: akterReading("One hot key, 64 callers").median,
  freshKeys: akterReading("10,000 keys, 64 callers").median,
  freshReadP50: akterReading("Sequential read").median,
  newKeyP50: akterReading("First command to a new key").median,
}

/** One failure drill's verification counts, per acknowledged append ID. */
export interface Drill {
  readonly round: string
  readonly drill: string
  readonly acknowledged: number
  readonly missing: number
  readonly repeated: number
  readonly unknown: number
}

/** Akter's failure drills, read from the report's failure table. */
export const drills: ReadonlyArray<Drill> = tableUnder(report, "Failure and retry results").flatMap(
  (row) =>
    row[0] === "Akter"
      ? [
          {
            round: cellAt(row, 1),
            drill: cellAt(row, 2),
            acknowledged: required(row, 3),
            missing: required(row, 4),
            repeated: required(row, 6),
            unknown: required(row, 7),
          },
        ]
      : [],
)

/** The round whose three drills form the final crash and partition control. */
const FINAL_ROUND = "correctedfailure"

/** Whether a drill belongs to the final control, so the table can set it apart. */
export const isFinalControl = (drill: Drill): boolean => drill.round === FINAL_ROUND

const finalDrills = drills.filter(isFinalControl)

const total = (count: (drill: Drill) => number): number =>
  finalDrills.reduce((sum, drill) => sum + count(drill), 0)

/** Verification totals across the final control's drills; `acknowledged` is the report's headline. */
export const finalControl = {
  acknowledged: total((drill) => drill.acknowledged),
  missing: total((drill) => drill.missing),
  repeated: total((drill) => drill.repeated),
  unknown: total((drill) => drill.unknown),
}
