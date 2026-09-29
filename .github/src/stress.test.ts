import { describe, expect, it } from "vitest"
import { stressSummary, tallyFlakes, type StressRun } from "./stress.ts"

const run = (name: string, results: ReadonlyArray<[string, string]>): StressRun => ({
  run: name,
  suite: "test",
  started: true,
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
      tallyFlakes([
        {
          run: "4",
          suite: "test",
          started: true,
          report: undefined,
          status: 124,
          unhandledErrors: false,
        },
      ]),
    ).toEqual([{ name: "test (no report: the run died before Vitest finished)", failed: ["4"] }])
  })

  it("counts a file that failed outside its cases and a run that failed outside any file", () => {
    expect(
      tallyFlakes([
        {
          run: "5",
          suite: "test",
          started: true,
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
          suite: "test",
          started: true,
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
      { name: "broken.test.ts (file failed)", failed: ["5"] },
      { name: "test (run failed without a failing case: see its log)", failed: ["6"] },
    ])
  })

  it("keeps unhandled errors and file errors beside the failed cases of the same run", () => {
    expect(
      tallyFlakes([
        {
          run: "7",
          suite: "test",
          started: true,
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
      { name: "suite.test.ts (file failed)", failed: ["7"] },
      { name: "suite.test.ts > a", failed: ["7"] },
      { name: "test (unhandled errors: see its log)", failed: ["7"] },
    ])
  })

  it("names a run the step's time budget cut off before it started apart from one that died", () => {
    expect(
      tallyFlakes([
        {
          run: "test-9",
          suite: "test",
          started: false,
          report: undefined,
          status: undefined,
          unhandledErrors: false,
        },
        {
          run: "test-8",
          suite: "test",
          started: true,
          report: undefined,
          status: undefined,
          unhandledErrors: false,
        },
      ]),
    ).toEqual([
      {
        name: "test (never started: the step ran out of time before this run)",
        failed: ["test-9"],
      },
      { name: "test (no report: the run died before Vitest finished)", failed: ["test-8"] },
    ])
  })

  it("counts a passing report without an exit status as cut off", () => {
    expect(tallyFlakes([{ ...run("8", [["a", "passed"]]), status: undefined }])).toEqual([
      { name: "test (no exit status: the run was cut off)", failed: ["8"] },
    ])
  })

  it("keeps failures without a case apart per suite", () => {
    expect(
      tallyFlakes([
        {
          run: "test-1",
          suite: "test",
          started: true,
          report: undefined,
          status: 124,
          unhandledErrors: false,
        },
        {
          run: "test:integration-1",
          suite: "test:integration",
          started: true,
          report: undefined,
          status: 124,
          unhandledErrors: false,
        },
      ]),
    ).toEqual([
      { name: "test (no report: the run died before Vitest finished)", failed: ["test-1"] },
      {
        name: "test:integration (no report: the run died before Vitest finished)",
        failed: ["test:integration-1"],
      },
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
