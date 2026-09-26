import { describe, expect, it } from "vitest"
import { stressSummary, tallyFlakes, type StressRun } from "./stress.ts"

const run = (name: string, results: ReadonlyArray<[string, string]>): StressRun => ({
  run: name,
  report: {
    testResults: [
      {
        name: "suite.test.ts",
        assertionResults: results.map(([fullName, status]) => ({ fullName, status })),
      },
    ],
  },
})

describe("stress tally", () => {
  it("names each failed case with the runs it failed in, worst first", () => {
    const flakes = tallyFlakes([
      run("1", [
        ["a", "passed"],
        ["b", "failed"],
      ]),
      run("2", [
        ["a", "failed"],
        ["b", "failed"],
      ]),
      run("3", [
        ["a", "passed"],
        ["b", "passed"],
      ]),
    ])

    expect(flakes).toEqual([
      { name: "suite.test.ts > b", failed: ["1", "2"] },
      { name: "suite.test.ts > a", failed: ["2"] },
    ])
  })

  it("counts a run without a report as a failure", () => {
    expect(tallyFlakes([{ run: "4", report: undefined }])).toEqual([
      { name: "(no report: the run died before Vitest finished)", failed: ["4"] },
    ])
  })

  it("summarizes a clean stress run and a flaky one", () => {
    expect(stressSummary(10, [])).toBe("No case failed in 10 runs under CPU load.\n")
    expect(stressSummary(10, [{ name: "x | y", failed: ["3"] }])).toContain(
      "| x \\| y | 1/10 | 3 |",
    )
  })
})
