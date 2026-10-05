import report from "../../../../BENCHMARKS.md?raw"
import type { Reading } from "./parse-report.ts"
import { cellAt, parseReading, rowFor, tableUnder } from "./parse-report.ts"

/** The systems the report compares, as its tables name them and as the chart labels them. */
const SYSTEMS = [
  { column: "Akter", name: "Akter" },
  { column: "Rivet default", name: "Rivet" },
  { column: "workerd local", name: "workerd" },
  { column: "Restate", name: "Restate" },
  { column: "Temporal", name: "Temporal" },
  { column: "DBOS", name: "DBOS" },
] as const

/** One system's bar in the hot-key case. */
export interface Measurement {
  readonly system: string
  readonly operationsPerSecond: number
}

const required = (row: ReadonlyArray<string>, column: number): number => {
  const parsed = parseReading(cellAt(row, column))

  if (parsed === null)
    throw new Error(`BENCHMARKS.md row "${row[0] ?? ""}" has no number in column ${column}`)

  return parsed.median
}

const hotKeyTable = tableUnder(report, "One hot key, 64 callers")

/**
 * Successful writes per second for each system in the hot-key case, fastest first. A system the
 * report did not collect is left out rather than drawn as zero.
 */
export const hotKey: ReadonlyArray<Measurement> = SYSTEMS.flatMap(({ column, name }) => {
  const reading: Reading | null = parseReading(cellAt(rowFor(hotKeyTable, column), 2))

  return reading === null ? [] : [{ system: name, operationsPerSecond: reading.median }]
}).toSorted((a, b) => b.operationsPerSecond - a.operationsPerSecond)

/** Akter's median latencies in milliseconds, from the report's sequential write and read tables. */
export const latency = {
  write: required(
    rowFor(tableUnder(report, "Sequential counter write (acknowledgement modes differ)"), "Akter"),
    3,
  ),
  freshRead: required(rowFor(tableUnder(report, "Sequential acknowledged-state read"), "Akter"), 3),
}

/** The round whose three drills form the final crash and partition control. */
const FINAL_ROUND = "correctedfailure"

const finalDrills = tableUnder(report, "Failure and retry results").flatMap((row) =>
  row[0] === "Akter" && cellAt(row, 1) === FINAL_ROUND
    ? [
        {
          acknowledged: required(row, 3),
          missing: required(row, 4),
          repeated: required(row, 6),
          unknown: required(row, 7),
        },
      ]
    : [],
)

const total = (count: (drill: (typeof finalDrills)[number]) => number): number =>
  finalDrills.reduce((sum, drill) => sum + count(drill), 0)

/** Verification totals across the final control's drills; `acknowledged` is the report's headline. */
export const crashTest = {
  acknowledged: total((drill) => drill.acknowledged),
  missing: total((drill) => drill.missing),
  repeated: total((drill) => drill.repeated),
  unknown: total((drill) => drill.unknown),
}
