import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  type DiagnosticRun,
  report,
  type RetainedRun,
  renderMarkdown,
  type Side,
  summarize,
  type SummaryInput,
} from "./report.ts"
import type { Metrics, Result } from "./results.ts"

const base = "a".repeat(40)
const head = "b".repeat(40)
const shas = { base, head }

const metrics = (overrides: Partial<Metrics> = {}): Metrics => ({
  throughput: 100,
  p50Ms: 5,
  p95Ms: 10,
  p99Ms: 20,
  maxMs: 40,
  appCpuMsPerSuccess: 1,
  databaseCpuMsPerSuccess: 2,
  sqlElapsedMsPerSuccess: 3,
  flightsPerSuccess: 4,
  statementsPerSuccess: 5,
  rssBytesPerResident: 6,
  ...overrides,
})

const result = (
  side: Side,
  name: string,
  overrides: Partial<Result>,
  values: Partial<Metrics>,
): Result => ({
  schemaVersion: 1,
  sha: shas[side],
  case: name,
  diagnostic: false,
  attempts: 100,
  successes: 100,
  failures: 0,
  refusals: 0,
  timeouts: 0,
  dropped: 0,
  elapsedMs: 1000,
  valid: true,
  ...overrides,
  metrics: metrics(values),
})

const series = (
  side: Side,
  name: string,
  rounds: ReadonlyArray<Partial<Metrics>>,
  overrides: Partial<Result> = {},
): ReadonlyArray<RetainedRun> =>
  rounds.map((values, index) => ({
    file: `${side}-r${index + 1}-${name}.json`,
    side,
    round: index + 1,
    result: result(side, name, overrides, values),
  }))

const input = (
  runs: ReadonlyArray<RetainedRun>,
  extra: Partial<SummaryInput> = {},
): SummaryInput => ({
  baseSha: base,
  headSha: head,
  runs,
  diagnostics: [],
  order: null,
  githubActions: false,
  ...extra,
})

const metric = (summary: ReturnType<typeof summarize>, name: string, key: keyof Metrics) =>
  summary.cases.find((entry) => entry.case === name)!.metrics.find((entry) => entry.name === key)!

describe("repeat summaries", () => {
  it("compares independent per-run medians with nearest-rank quantiles and no pooled or favorable pick", () => {
    const summary = summarize(
      input([
        ...series("base", "spread-write", [
          { p95Ms: 10, throughput: 400 },
          { p95Ms: 40, throughput: 100 },
          { p95Ms: 20, throughput: 300 },
          { p95Ms: 30, throughput: 200 },
        ]),
        ...series("head", "spread-write", [
          { p95Ms: 5, throughput: 100 },
          { p95Ms: 6, throughput: 150 },
          { p95Ms: 8, throughput: 90 },
          { p95Ms: 7, throughput: 110 },
        ]),
      ]),
    )
    const latency = metric(summary, "spread-write", "p95Ms")
    expect(latency.base).toEqual({ median: 25, min: 10, max: 40 })
    expect(latency.head).toEqual({ median: 6.5, min: 5, max: 8 })
    expect(latency.baseRuns).toEqual([10, 40, 20, 30])
    expect(latency.verdict).toBe("improved")
    const throughput = metric(summary, "spread-write", "throughput")
    expect(throughput.base).toEqual({ median: 250, min: 100, max: 400 })
    expect(throughput.head).toEqual({ median: 105, min: 90, max: 150 })
    expect(throughput.verdict).toBe("overlapping")
    expect(summary.repeats).toBe(4)
    expect(summary.valid).toBe(true)
  })

  it("treats every metric but throughput as lower-is-better and flags only disjoint ranges", () => {
    const summary = summarize(
      input([
        ...series("base", "hot-write", [
          { throughput: 100, p50Ms: 10, maxMs: 40 },
          { throughput: 110, p50Ms: 11, maxMs: 41 },
          { throughput: 120, p50Ms: 12, maxMs: 42 },
        ]),
        ...series("head", "hot-write", [
          { throughput: 130, p50Ms: 13, maxMs: 30 },
          { throughput: 140, p50Ms: 14, maxMs: 31 },
          { throughput: 150, p50Ms: 15, maxMs: 32 },
        ]),
      ]),
    )
    expect(metric(summary, "hot-write", "throughput").verdict).toBe("improved")
    expect(metric(summary, "hot-write", "p50Ms").verdict).toBe("regressed")
    expect(metric(summary, "hot-write", "maxMs").verdict).toBe("improved")
    expect(metric(summary, "hot-write", "p95Ms").verdict).toBe("overlapping")
    expect(metric(summary, "hot-write", "throughput").changePercent).toBeCloseTo(27.2727, 3)
    expect(metric(summary, "hot-write", "p50Ms").lowerIsBetter).toBe(true)
    expect(metric(summary, "hot-write", "throughput").lowerIsBetter).toBe(false)
  })

  it("keeps touching ranges overlapping on both sides of the equality boundary", () => {
    const summary = summarize(
      input([
        ...series("base", "boundary", [
          { p95Ms: 10, throughput: 12 },
          { p95Ms: 11, throughput: 11 },
          { p95Ms: 12, throughput: 10 },
        ]),
        ...series("head", "boundary", [
          { p95Ms: 12, throughput: 10 },
          { p95Ms: 13, throughput: 9 },
          { p95Ms: 14, throughput: 8 },
        ]),
      ]),
    )
    expect(metric(summary, "boundary", "p95Ms").verdict).toBe("overlapping")
    expect(metric(summary, "boundary", "throughput").verdict).toBe("overlapping")
  })

  it("rejects missing rounds, missing sides, differing case sets and too few repeats", () => {
    const clean = [...series("base", "a", [{}, {}, {}]), ...series("head", "a", [{}, {}, {}])]
    expect(summarize(input(clean)).cases).toHaveLength(1)
    expect(() => summarize(input(clean.filter((run) => run.file !== "base-r2-a.json")))).toThrow(
      "Missing base round 2 for case a",
    )
    expect(() =>
      summarize(
        input([...series("base", "a", [{}, {}, {}]), ...series("head", "a", [{}, {}, {}, {}])]),
      ),
    ).toThrow("Missing base round 4 for case a")
    expect(() => summarize(input(clean.filter((run) => run.side === "base")))).toThrow(
      "Missing head round 1 for case a",
    )
    expect(() => summarize(input([...clean, ...series("head", "extra", [{}, {}, {}])]))).toThrow(
      "Missing base round 1 for case extra",
    )
    expect(() =>
      summarize(input([...series("base", "a", [{}, {}]), ...series("head", "a", [{}, {}])])),
    ).toThrow("At least three rounds")
  })

  it("rejects duplicates, wrong or equal shas and unknown manifest files", () => {
    const clean = [...series("base", "a", [{}, {}, {}]), ...series("head", "a", [{}, {}, {}])]
    expect(() =>
      summarize(input([...clean, { ...clean[0]!, file: "base-r1-a-copy.json" }])),
    ).toThrow("duplicate base round 1")
    expect(() => summarize(input([...clean, clean[0]!]))).toThrow("duplicate file")
    expect(() =>
      summarize(
        input([
          ...series("base", "a", [{}, {}, {}], { sha: head }),
          ...series("head", "a", [{}, {}, {}]),
        ]),
      ),
    ).toThrow("is not the base sha")
    expect(() => summarize(input(clean, { headSha: base }))).toThrow("must differ")
    expect(() => summarize(input(clean, { order: ["base-r9-a.json"] }))).toThrow("unknown file")
    expect(() => summarize(input(clean, { order: [clean[0]!.file, clean[0]!.file] }))).toThrow(
      "repeats file",
    )
    expect(summarize(input(clean, { order: [clean[3]!.file, clean[0]!.file] })).order).toEqual([
      "head-r1-a.json",
      "base-r1-a.json",
    ])
  })

  it("never substitutes a diagnostic file for a missing round and keeps it out of timing", () => {
    const diagnostic = (side: Side, overrides: Partial<Result> = {}): DiagnosticRun => ({
      file: `diag-${side}-a.json`,
      side,
      result: result(
        side,
        "a",
        { diagnostic: true, ...overrides },
        { throughput: 1_000_000, p95Ms: 0 },
      ),
    })
    const missing = [...series("base", "a", [{}, {}]), ...series("head", "a", [{}, {}, {}])]
    expect(() => summarize(input(missing, { diagnostics: [diagnostic("base")] }))).toThrow(
      "Missing base round 3",
    )

    const clean = [...series("base", "a", [{}, {}, {}]), ...series("head", "a", [{}, {}, {}])]
    const summary = summarize(
      input(clean, { diagnostics: [diagnostic("base"), diagnostic("head")] }),
    )
    expect(summary.diagnostics.map((entry) => entry.file)).toEqual([
      "diag-base-a.json",
      "diag-head-a.json",
    ])
    expect(metric(summary, "a", "throughput").baseRuns).toEqual([100, 100, 100])
    expect(() =>
      summarize(input(clean, { diagnostics: [diagnostic("base", { diagnostic: false })] })),
    ).toThrow("not marked diagnostic")
    expect(() =>
      summarize(
        input(clean, {
          diagnostics: [diagnostic("base"), { ...diagnostic("base"), file: "diag-base-a-2.json" }],
        }),
      ),
    ).toThrow("duplicate base diagnostic")
  })

  it.each([
    ["failures", { failures: 1 }, "failures=1"],
    ["timeouts", { timeouts: 2 }, "timeouts=2"],
    ["dropped", { dropped: 3 }, "dropped=3"],
    ["refusals", { refusals: 4 }, "refusals=4"],
    ["invalid", { valid: false }, "invalid"],
    ["diagnostic", { diagnostic: true }, "diagnostic"],
  ] as const)(
    "suppresses every verdict for a run with %s while retaining its counters",
    (_, overrides, reason) => {
      const slow = { throughput: 10, p95Ms: 100 }
      const fast = { throughput: 1000, p95Ms: 1 }
      const dirty = series("head", "bad", [fast, fast, fast]).map((run, index) =>
        index === 1 ? { ...run, result: { ...run.result, ...overrides } } : run,
      )
      const summary = summarize(
        input([
          ...series("base", "bad", [slow, slow, slow]),
          ...dirty,
          ...series("base", "good", [slow, slow, slow]),
          ...series("head", "good", [fast, fast, fast]),
        ]),
      )
      const bad = summary.cases.find((entry) => entry.case === "bad")!
      expect(bad.comparable).toBe(false)
      expect(bad.reasons).toEqual([`head-r2-bad.json: ${reason}`])
      expect(bad.metrics.every((entry) => entry.verdict === "suppressed")).toBe(true)
      expect(bad.metrics.find((entry) => entry.name === "throughput")!.base).toEqual({
        median: 10,
        min: 10,
        max: 10,
      })
      expect(bad.metrics.find((entry) => entry.name === "throughput")!.headRuns).toEqual([
        1000, 1000, 1000,
      ])
      expect(bad.counters.head.failures).toBe("failures" in overrides ? 1 : 0)
      expect(bad.counters.head.refusals).toBe("refusals" in overrides ? 4 : 0)
      expect(metric(summary, "good", "throughput").verdict).toBe("improved")
      expect(summary.valid).toBe(false)
      expect(renderMarkdown(summary)).toContain(`head-r2-bad.json: ${reason}`)
    },
  )

  it("keeps a missing CPU measurement unknown instead of comparing the remaining runs", () => {
    const summary = summarize(
      input([
        ...series("base", "a", [
          { appCpuMsPerSuccess: 10 },
          { appCpuMsPerSuccess: 11 },
          { appCpuMsPerSuccess: 12 },
        ]),
        ...series("head", "a", [
          { appCpuMsPerSuccess: 1 },
          { appCpuMsPerSuccess: null },
          { appCpuMsPerSuccess: 3 },
        ]),
      ]),
    )
    const cpu = metric(summary, "a", "appCpuMsPerSuccess")
    expect(cpu.verdict).toBe("unknown")
    expect(cpu.headRuns).toEqual([1, null, 3])
    expect(cpu.head).toBeNull()
    expect(metric(summary, "a", "databaseCpuMsPerSuccess").verdict).toBe("overlapping")
    expect(summary.valid).toBe(true)
  })

  it("states the local quick-signal limitation unless GITHUB_ACTIONS and always the SQL elapsed meaning", () => {
    const clean = [...series("base", "a", [{}, {}, {}]), ...series("head", "a", [{}, {}, {}])]
    const local = summarize(input(clean))
    const ci = summarize(input(clean, { githubActions: true }))
    expect(local.environment).toBe("local")
    expect(local.limitations.join("\n")).toContain("not a CI reference")
    expect(ci.environment).toBe("github-actions")
    expect(ci.limitations.join("\n")).not.toContain("not a CI reference")
    for (const summary of [local, ci]) {
      expect(summary.limitations.join("\n")).toContain("pg_stat_statements")
      expect(summary.limitations.join("\n")).toContain("not CPU")
      expect(summary.limitations.join("\n")).toContain("no statistical-confidence claim")
    }
  })
})

describe("retained directory", () => {
  const directories: Array<string> = []
  const directory = async () => {
    const created = await mkdtemp(join(tmpdir(), "bench-report-"))
    directories.push(created)
    return created
  }
  const write = async (dir: string, file: string, text: string) => writeFile(join(dir, file), text)
  const populate = async (dir: string) => {
    for (const run of [
      ...series("base", "hot-write", [{ p95Ms: 20 }, { p95Ms: 21 }, { p95Ms: 22 }]),
      ...series("head", "hot-write", [{ p95Ms: 10 }, { p95Ms: 11 }, { p95Ms: 12 }]),
    ])
      await write(
        dir,
        run.file,
        JSON.stringify({ ...run.result, rawSamples: [1, 2, 3], note: "extra" }),
      )
    await write(
      dir,
      "diag-head-hot-write.json",
      JSON.stringify(result("head", "hot-write", { diagnostic: true }, {})),
    )
  }

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((created) => rm(created, { recursive: true, force: true })),
    )
  })

  it("reads case files through the schema, ignores extra raw fields and writes both outputs", async () => {
    const dir = await directory()
    await populate(dir)
    await write(dir, "base-r1-hot-write.mounts.json", JSON.stringify([{ Type: "volume" }]))
    await write(
      dir,
      "order.json",
      JSON.stringify(["head-r1-hot-write.json", "base-r1-hot-write.json"]),
    )
    const summary = await report(dir, base, head, false)
    expect(summary.order).toEqual(["head-r1-hot-write.json", "base-r1-hot-write.json"])
    expect(summary.diagnostics.map((entry) => entry.file)).toEqual(["diag-head-hot-write.json"])
    const json = JSON.parse(await readFile(join(dir, "report.json"), "utf8"))
    expect(json.cases[0].files.base).toEqual([
      "base-r1-hot-write.json",
      "base-r2-hot-write.json",
      "base-r3-hot-write.json",
    ])
    expect(
      json.cases[0].metrics.find((entry: { name: string }) => entry.name === "p95Ms").verdict,
    ).toBe("improved")
    const markdown = await readFile(join(dir, "report.md"), "utf8")
    expect(markdown).toContain(`\`${base}\``)
    expect(markdown).toContain(
      "| hot-write | p95Ms | 21 [20, 22] | 11 [10, 12] | -47.62% | improved |",
    )
    expect(markdown).toContain("head-r1-hot-write.json")
    await expect(report(dir, base, head, false)).resolves.toMatchObject({ repeats: 3 })
  })

  it("rejects malformed boundaries naming the file", async () => {
    const dir = await directory()
    await populate(dir)
    await write(
      dir,
      "head-r2-hot-write.json",
      JSON.stringify({
        ...result("head", "hot-write", {}, {}),
        failures: "none",
      }),
    )
    await expect(report(dir, base, head, false)).rejects.toThrow("head-r2-hot-write.json")

    await write(dir, "head-r2-hot-write.json", JSON.stringify(result("head", "other", {}, {})))
    await expect(report(dir, base, head, false)).rejects.toThrow("file case differs")

    await write(
      dir,
      "head-r2-hot-write.json",
      JSON.stringify({
        ...result("head", "hot-write", {}, {}),
        metrics: { throughput: 1 },
      }),
    )
    await expect(report(dir, base, head, false)).rejects.toThrow("head-r2-hot-write.json")

    await write(dir, "head-r2-hot-write.json", JSON.stringify(result("head", "hot-write", {}, {})))
    await write(dir, "head-r02-hot-write.json", JSON.stringify(result("head", "hot-write", {}, {})))
    await expect(report(dir, base, head, false)).rejects.toThrow("unrecognised retained file name")
  })

  it("runs as a Bun entry that takes the directory and both SHAs", async () => {
    const dir = await directory()
    await populate(dir)
    const entry = join(import.meta.dirname, "report.ts")
    const usage = spawnSync("bun", [entry, dir], { encoding: "utf8" })
    expect(usage.status).toBe(2)
    expect(usage.stderr).toContain("Usage")
    const ran = spawnSync("bun", [entry, dir, base, head], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true" },
    })
    expect(ran.status).toBe(0)
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).environment).toBe(
      "github-actions",
    )
    const failed = spawnSync("bun", [entry, dir, base, base], { encoding: "utf8" })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("must differ")
  })
})
