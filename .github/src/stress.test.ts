import { describe, expect, it } from "vitest"
import { stressSummary, tallyFlakes, type StressRun } from "./stress.ts"

const run = (name: string, results: ReadonlyArray<[string, string]>): StressRun => ({
  run: name,
  status: results.some(([, status]) => status === "failed") ? 1 : 0,
  unhandledErrors: false,
  report: {
    success: results.every(([, status]) => status !== "failed"),
    testResults: [
      {
        name: "suite.test.ts",
        message: "",
        status: results.some(([, status]) => status === "failed") ? "failed" : "passed",
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
    expect(
      tallyFlakes([{ run: "4", report: undefined, status: 124, unhandledErrors: false }]),
    ).toEqual([{ name: "(no report: the run died before Vitest finished)", failed: ["4"] }])
  })

  it("counts a file that failed outside its cases and a run that failed outside any file", () => {
    expect(
      tallyFlakes([
        {
          run: "5",
          status: 1,
          unhandledErrors: false,
          report: {
            success: false,
            testResults: [
              { name: "broken.test.ts", status: "failed", message: "import", assertionResults: [] },
            ],
          },
        },
        {
          run: "6",
          status: 1,
          unhandledErrors: false,
          report: {
            success: true,
            testResults: [
              {
                name: "suite.test.ts",
                status: "passed",
                message: "",
                assertionResults: [{ fullName: "a", status: "passed" }],
              },
            ],
          },
        },
      ]),
    ).toEqual([
      { name: "(run failed without a failing case: see its log)", failed: ["6"] },
      { name: "broken.test.ts (file failed)", failed: ["5"] },
    ])
  })

  it("keeps unhandled errors and file errors beside the failed cases of the same run", () => {
    expect(
      tallyFlakes([
        {
          run: "7",
          status: 1,
          unhandledErrors: true,
          report: {
            success: false,
            testResults: [
              {
                name: "suite.test.ts",
                status: "failed",
                message: "afterAll hook failed",
                assertionResults: [{ fullName: "a", status: "failed" }],
              },
            ],
          },
        },
      ]),
    ).toEqual([
      { name: "(unhandled errors: see its log)", failed: ["7"] },
      { name: "suite.test.ts (file failed)", failed: ["7"] },
      { name: "suite.test.ts > a", failed: ["7"] },
    ])
  })

  it("summarizes a clean stress run and a flaky one", () => {
    expect(stressSummary({ runs: 10, flakes: [] })).toBe(
      "No case failed in 10 runs under CPU load.\n",
    )
    expect(stressSummary({ runs: 10, flakes: [{ name: "x | y", failed: ["3"] }] })).toContain(
      "| x \\| y | 1/10 | 3 |",
    )
  })
})
