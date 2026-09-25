import { describe, expect, it } from "vitest"
import { comparability, compare, type Result } from "./compare.ts"

const result = (
  cases: ReadonlyArray<{
    name: string
    throughput: number
    p99: number
    errors?: number
    statements?: number
  }>,
): Result => ({
  schema: 1,
  label: null,
  profile: "full",
  git: { shortSha: "abc1234" },
  backend: { name: "postgres" },
  machine: { cpuModel: "cpu", logicalCpus: 4 },
  scenarios: [
    {
      name: "hot-actor",
      cases: cases.map(({ name, throughput, p99, errors, statements }) => ({
        name,
        throughput,
        errors: errors ?? 0,
        statementsPerOperation: statements ?? 11,
        latencyMs: { p50: 1, p95: 2, p99 },
      })),
    },
  ],
})

describe("compare", () => {
  it("flags throughput drops and latency rises beyond the threshold", () => {
    const { changes } = compare({
      before: result([{ name: "sequential", throughput: 300, p99: 10 }]),
      after: result([{ name: "sequential", throughput: 240, p99: 12 }]),
      threshold: 0.1,
    })

    const byMetric = Object.fromEntries(changes.map((change) => [change.metric, change]))
    expect(byMetric["throughput"]).toMatchObject({ worse: 0.2, regression: true })
    expect(byMetric["p99"]).toMatchObject({ regression: true })
    expect(byMetric["p50"]).toMatchObject({ worse: 0, regression: false })
  })

  it("treats improvements and changes within the threshold as passing", () => {
    const { changes } = compare({
      before: result([{ name: "sequential", throughput: 300, p99: 10 }]),
      after: result([{ name: "sequential", throughput: 320, p99: 10.5 }]),
      threshold: 0.1,
    })

    expect(changes.some((change) => change.regression)).toBe(false)
  })

  it("reports new cases and new errors", () => {
    const { changes, added, removed } = compare({
      before: result([{ name: "sequential", throughput: 300, p99: 10 }]),
      after: result([
        { name: "sequential", throughput: 300, p99: 10, errors: 2 },
        { name: "concurrent-8", throughput: 400, p99: 30 },
      ]),
      threshold: 0.1,
    })

    expect(added).toEqual(["hot-actor/concurrent-8"])
    expect(removed).toEqual([])
    expect(changes.find((change) => change.metric === "errors")).toMatchObject({ regression: true })
  })

  it("flags added statements per operation regardless of the latency threshold", () => {
    const { changes, removed } = compare({
      before: result([
        { name: "sequential", throughput: 300, p99: 10, statements: 11 },
        { name: "gone", throughput: 1, p99: 1 },
      ]),
      after: result([{ name: "sequential", throughput: 300, p99: 10, statements: 12 }]),
      threshold: 0.5,
    })

    expect(changes.find((change) => change.metric === "statements")).toMatchObject({
      worse: 1,
      regression: true,
    })
    expect(removed).toEqual(["hot-actor/gone"])
  })
})

describe("comparability", () => {
  it("refuses different backends and warns on different machines", () => {
    const postgres = result([])
    const pglite = { ...postgres, backend: { name: "pglite" } }
    const elsewhere = { ...postgres, machine: { cpuModel: "other", logicalCpus: 8 } }

    expect(comparability({ before: postgres, after: pglite }).refuse).toEqual([
      "backend postgres vs pglite",
    ])
    expect(comparability({ before: postgres, after: elsewhere })).toMatchObject({ refuse: [] })
    expect(comparability({ before: postgres, after: elsewhere }).warn).toHaveLength(1)
  })
})
