import { describe, expect, it } from "vitest"
import { parseReading, rowFor, tableUnder } from "./parse-report.ts"

const report = `
## Head-to-head results

### One case

Cells are medians.

| System | Rounds | Successful op/s |
| ------ | ------ | --------------- |
| Akter | 3 | 1647.2 [1351.1–1688.9] |
| Rivet default | 0 | not collected |
| Redis AOF-always | 3 | 24293.4 [21682.7–24952.7] |

### Next case

| System | Rounds |
| --- | --- |
| Other | 9 |
`

describe("parseReading", () => {
  it("reads a median and its range", () => {
    expect(parseReading("1647.2 [1351.1–1688.9]")).toEqual({
      median: 1647.2,
      low: 1351.1,
      high: 1688.9,
    })
  })

  it("reads a bare number and a grouped count as a degenerate range", () => {
    expect(parseReading("72551")).toEqual({ median: 72551, low: 72551, high: 72551 })
    expect(parseReading("1,406")).toEqual({ median: 1406, low: 1406, high: 1406 })
  })

  it("never turns a missing case into a number", () => {
    expect(parseReading("not collected")).toBeNull()
    expect(parseReading("unknown (194 apparent)")).toBeNull()
    expect(parseReading("not required/unknown")).toBeNull()
  })
})

describe("tableUnder", () => {
  it("returns only the first table under its own heading", () => {
    const rows = tableUnder(report, "One case")

    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row[0])).toEqual(["Akter", "Rivet default", "Redis AOF-always"])
  })

  it("fails loudly when the heading was renamed", () => {
    expect(() => tableUnder(report, "Renamed case")).toThrow(/no "Renamed case" section/)
  })

  it("finds a row by system and fails when it is absent", () => {
    const rows = tableUnder(report, "One case")

    expect(rowFor(rows, "Akter")[2]).toBe("1647.2 [1351.1–1688.9]")
    expect(() => rowFor(rows, "Temporal")).toThrow(/no row for "Temporal"/)
  })
})
