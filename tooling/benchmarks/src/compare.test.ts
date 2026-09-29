import { describe, expect, it } from "vitest"
import {
  comparability,
  compare,
  compareStatements,
  type Result,
  STATEMENT_TOLERANCE,
  toleranceOf,
  toBaseline,
} from "./compare.ts"

const result = (
  cases: ReadonlyArray<{
    name: string
    throughput: number
    p99: number
    errors?: number
    statements?: number
    cpu?: number
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
      cases: cases.map(({ name, throughput, p99, errors, statements, cpu }) => ({
        name,
        throughput,
        errors: errors ?? 0,
        statementsPerOperation: statements ?? 11,
        latencyMs: { p50: 1, p95: 2, p99 },
        cpu: { clientMsPerOperation: cpu ?? null },
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

  it("compares CPU per operation when both runs report it", () => {
    const { changes } = compare({
      before: result([{ name: "sequential", throughput: 300, p99: 10, cpu: 1 }]),
      after: result([{ name: "sequential", throughput: 300, p99: 10, cpu: 1.2 }]),
      threshold: 0.1,
    })

    expect(changes.find((change) => change.metric === "cpu")).toMatchObject({
      before: 1,
      after: 1.2,
      regression: true,
    })

    const { changes: older } = compare({
      before: result([{ name: "sequential", throughput: 300, p99: 10 }]),
      after: result([{ name: "sequential", throughput: 300, p99: 10, cpu: 1 }]),
      threshold: 0.1,
    })

    expect(older.some((change) => change.metric === "cpu")).toBe(false)
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

describe("compareStatements", () => {
  const ci = (statements: Readonly<Record<string, number>>): Result => ({
    ...result(
      Object.entries(statements).map(([name, count]) => ({
        name,
        throughput: 1,
        p99: 1,
        statements: count,
      })),
    ),
    profile: "ci",
  })

  const baseline = toBaseline(ci({ sequential: 7.01, "concurrent-8": 7.02 }))

  it("passes counts within the tolerance", () => {
    const { cases, added, removed } = compareStatements({
      baseline,
      result: ci({ sequential: 7.01 + STATEMENT_TOLERANCE, "concurrent-8": 6.9 }),
    })

    expect(cases.some((entry) => entry.changed)).toBe(false)
    expect([...added, ...removed]).toEqual([])
  })

  it("gives concurrent cases a share of the baseline and keeps the rest exact", () => {
    expect(toleranceOf("hot-actor/sequential", 8)).toBe(STATEMENT_TOLERANCE)
    expect(toleranceOf("cold-activation/new-actor", 10)).toBe(STATEMENT_TOLERANCE)
    expect(toleranceOf("hot-actor/concurrent-64", 3.37)).toBe(STATEMENT_TOLERANCE)
    expect(toleranceOf("outbox/delivery-concurrent-16", 14.58)).toBeCloseTo(0.729)
    expect(toleranceOf("effect-round-trip/concurrent-64", 17.35)).toBeCloseTo(0.8675)
    expect(toleranceOf("hot-actor/concurrent-8", 4.79)).toBeCloseTo(0.5748)
  })

  it("passes a concurrent case's scheduling noise and fails a deterministic case's one statement", () => {
    const recorded = toBaseline(ci({ sequential: 8, "concurrent-8": 4.79, "concurrent-64": 3.37 }))

    const { cases } = compareStatements({
      baseline: recorded,
      result: ci({ sequential: 8.25, "concurrent-8": 4.27, "concurrent-64": 3.47 }),
    })

    expect(cases.filter((entry) => entry.changed).map((entry) => entry.key)).toEqual([
      "hot-actor/sequential",
    ])
  })

  it("fails one extra statement in every fourth operation", () => {
    const { cases } = compareStatements({
      baseline,
      result: ci({ sequential: 7.26, "concurrent-8": 7.02 }),
    })

    expect(cases.find((entry) => entry.key === "hot-actor/sequential")).toMatchObject({
      changed: true,
    })
  })

  it("fails an extra statement and a stale baseline alike", () => {
    const { cases } = compareStatements({
      baseline,
      result: ci({ sequential: 8.01, "concurrent-8": 6.02 }),
    })

    expect(cases.filter((entry) => entry.changed).map((entry) => entry.key)).toEqual([
      "hot-actor/sequential",
      "hot-actor/concurrent-8",
    ])
  })

  it("reports cases the baseline lacks or the run dropped", () => {
    const { added, removed } = compareStatements({
      baseline,
      result: ci({ sequential: 7.01, "concurrent-64": 7.01 }),
    })

    expect(added).toEqual(["hot-actor/concurrent-64"])
    expect(removed).toEqual(["hot-actor/concurrent-8"])
  })

  it("fails a round-trip change the baseline records, and ignores cases without a count", () => {
    const counted = (sequential: number): Result => {
      const run = ci({ sequential: 7 })
      const [scenario] = run.scenarios

      return {
        ...run,
        scenarios: [
          {
            ...scenario!,
            cases: [{ ...scenario!.cases[0]!, roundTripsPerOperation: sequential }],
          },
        ],
      }
    }

    const recorded = toBaseline(counted(2))

    expect(recorded.roundTripsPerOperation).toEqual({ "hot-actor/sequential": 2 })
    expect(
      compareStatements({ baseline: recorded, result: counted(2.1) }).cases.some(
        (entry) => entry.changed,
      ),
    ).toBe(false)
    expect(
      compareStatements({ baseline: recorded, result: counted(3) }).cases.filter(
        (entry) => entry.changed,
      ),
    ).toMatchObject([{ key: "hot-actor/sequential", metric: "round trips", before: 2, after: 3 }])
    expect(
      compareStatements({ baseline, result: counted(3) }).cases.some(
        (entry) => entry.metric === "round trips",
      ),
    ).toBe(false)
    expect(
      compareStatements({ baseline: recorded, result: ci({ sequential: 7 }) }).unmeasured,
    ).toEqual(["hot-actor/sequential"])
    expect(compareStatements({ baseline: recorded, result: counted(2) }).unmeasured).toEqual([])
  })

  it("builds a baseline only from a ci run on postgres", () => {
    expect(baseline).toEqual({
      profile: "ci",
      backend: "postgres",
      sha: "abc1234",
      statementsPerOperation: { "hot-actor/sequential": 7.01, "hot-actor/concurrent-8": 7.02 },
    })
    expect(() => toBaseline({ ...ci({}), profile: "quick" })).toThrow()

    const uncounted = ci({ sequential: 7 })
    const [scenario] = uncounted.scenarios

    expect(() =>
      toBaseline({
        ...uncounted,
        scenarios: [
          { ...scenario!, cases: [{ ...scenario!.cases[0]!, statementsPerOperation: null }] },
        ],
      }),
    ).toThrow("has no statement count")
  })
})
