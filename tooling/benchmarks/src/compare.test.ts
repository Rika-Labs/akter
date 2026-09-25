import { describe, expect, it } from "vitest"
import { compare, type Result } from "./compare.ts"

const result = (
  cases: ReadonlyArray<{ name: string; throughput: number; p99: number; errors?: number }>,
): Result => ({
  label: null,
  profile: "full",
  git: { shortSha: "abc1234" },
  backend: { name: "postgres" },
  scenarios: [
    {
      name: "hot-actor",
      cases: cases.map(({ name, throughput, p99, errors }) => ({
        name,
        throughput,
        errors: errors ?? 0,
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
    const { changes, missing } = compare({
      before: result([{ name: "sequential", throughput: 300, p99: 10 }]),
      after: result([
        { name: "sequential", throughput: 300, p99: 10, errors: 2 },
        { name: "concurrent-8", throughput: 400, p99: 30 },
      ]),
      threshold: 0.1,
    })

    expect(missing).toEqual(["hot-actor/concurrent-8"])
    expect(changes.find((change) => change.metric === "errors")).toMatchObject({ regression: true })
  })
})
