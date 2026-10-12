import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { compareMetric, type Metrics, type Result } from "./results.ts"

const finite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const nullable = Schema.NullOr(finite)
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Extra raw fields in a retained file are dropped; every field the comparison reads is checked. */
export const ResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sha: Schema.String,
  case: Schema.String,
  diagnostic: Schema.Boolean,
  attempts: count,
  successes: count,
  failures: count,
  refusals: count,
  timeouts: count,
  dropped: count,
  elapsedMs: finite,
  valid: Schema.Boolean,
  metrics: Schema.Struct({
    throughput: nullable,
    p50Ms: nullable,
    p95Ms: nullable,
    p99Ms: nullable,
    maxMs: nullable,
    appCpuMsPerSuccess: nullable,
    databaseCpuMsPerSuccess: nullable,
    sqlElapsedMsPerSuccess: nullable,
    flightsPerSuccess: nullable,
    statementsPerSuccess: nullable,
    rssBytesPerResident: nullable,
  }),
})

const decodeVerdict = Schema.decodeUnknownSync(
  Schema.Literals(["improved", "regressed", "overlapping"]),
)
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(ResultSchema))
const decodeOrder = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

export type Side = "base" | "head"
export type Verdict = "improved" | "regressed" | "overlapping" | "unknown" | "suppressed"

export interface RetainedRun {
  readonly file: string
  readonly side: Side
  readonly round: number
  readonly result: Result
}

export interface DiagnosticRun {
  readonly file: string
  readonly side: Side
  readonly result: Result
}

export interface SummaryInput {
  readonly baseSha: string
  readonly headSha: string
  readonly runs: ReadonlyArray<RetainedRun>
  readonly diagnostics: ReadonlyArray<DiagnosticRun>
  readonly order: ReadonlyArray<string> | null
  readonly githubActions: boolean
}

export interface Range {
  readonly median: number
  readonly min: number
  readonly max: number
}

export interface MetricSummary {
  readonly name: keyof Metrics
  readonly lowerIsBetter: boolean
  readonly baseRuns: ReadonlyArray<number | null>
  readonly headRuns: ReadonlyArray<number | null>
  readonly base: Range | null
  readonly head: Range | null
  readonly changePercent: number | null
  readonly verdict: Verdict
}

export interface Counters {
  readonly attempts: number
  readonly successes: number
  readonly failures: number
  readonly refusals: number
  readonly timeouts: number
  readonly dropped: number
}

export interface CaseSummary {
  readonly case: string
  readonly comparable: boolean
  readonly reasons: ReadonlyArray<string>
  readonly files: Readonly<Record<Side, ReadonlyArray<string>>>
  readonly counters: Readonly<Record<Side, Counters>>
  readonly metrics: ReadonlyArray<MetricSummary>
}

export interface Summary {
  readonly schemaVersion: 1
  readonly baseSha: string
  readonly headSha: string
  readonly environment: "github-actions" | "local"
  readonly repeats: number
  readonly valid: boolean
  readonly order: ReadonlyArray<string> | null
  readonly cases: ReadonlyArray<CaseSummary>
  readonly diagnostics: ReadonlyArray<DiagnosticRun>
  readonly limitations: ReadonlyArray<string>
}

const sides: ReadonlyArray<Side> = ["base", "head"]

/** Throughput is the only metric where a larger value is better. */
const metricNames: ReadonlyArray<keyof Metrics> = [
  "throughput",
  "p50Ms",
  "p95Ms",
  "p99Ms",
  "maxMs",
  "appCpuMsPerSuccess",
  "databaseCpuMsPerSuccess",
  "sqlElapsedMsPerSuccess",
  "flightsPerSuccess",
  "statementsPerSuccess",
  "rssBytesPerResident",
]

/** A run that refused, failed, timed out or dropped work cannot support a speed claim, so each counter is named instead of being excluded. */
const unhealthy = (result: Result): ReadonlyArray<string> => [
  ...(result.valid ? [] : ["invalid"]),
  ...(result.diagnostic ? ["diagnostic"] : []),
  ...(["failures", "refusals", "timeouts", "dropped"] as const).flatMap((name) =>
    result[name] > 0 ? [`${name}=${result[name]}`] : [],
  ),
]

const summarizeMetric = (
  name: keyof Metrics,
  baseRuns: ReadonlyArray<number | null>,
  headRuns: ReadonlyArray<number | null>,
  comparable: boolean,
): MetricSummary => {
  const lowerIsBetter = name !== "throughput"
  const unmeasured = {
    name,
    lowerIsBetter,
    baseRuns,
    headRuns,
    base: null,
    head: null,
    changePercent: null,
  }
  const base = baseRuns.filter((value) => value !== null)
  const head = headRuns.filter((value) => value !== null)
  if (base.length !== baseRuns.length || head.length !== headRuns.length)
    return { ...unmeasured, verdict: comparable ? "unknown" : "suppressed" }
  const compared = compareMetric(base, head, lowerIsBetter)
  return {
    ...unmeasured,
    base: compared.base,
    head: compared.head,
    changePercent: compared.changePercent,
    verdict: comparable ? decodeVerdict(compared.verdict) : "suppressed",
  }
}

const sum = (results: ReadonlyArray<Result>): Counters => {
  const total = (name: keyof Counters) =>
    results.reduce((accumulated, result) => accumulated + result[name], 0)
  return {
    attempts: total("attempts"),
    successes: total("successes"),
    failures: total("failures"),
    refusals: total("refusals"),
    timeouts: total("timeouts"),
    dropped: total("dropped"),
  }
}

/**
 * Rounds must be the same set 1..n on both sides for every case, with at least three
 * repeats, so a missing round, a missing side or a differing case set is rejected
 * rather than papered over. Diagnostic files are listed but never become a round.
 */
export const summarize = (input: SummaryInput): Summary => {
  const { baseSha, headSha } = input
  if (baseSha === "" || headSha === "") throw new Error("Base and head SHA are required")
  if (baseSha === headSha) throw new Error("Base and head SHA must differ")
  const shas: Readonly<Record<Side, string>> = { base: baseSha, head: headSha }
  const files = new Set<string>()
  const keys = new Set<string>()
  const grouped = new Map<string, Record<Side, Map<number, RetainedRun>>>()

  for (const run of input.runs) {
    if (!Number.isInteger(run.round) || run.round < 1)
      throw new Error(`${run.file}: round must be a positive integer`)
    if (run.result.sha !== shas[run.side])
      throw new Error(
        `${run.file}: sha ${run.result.sha} is not the ${run.side} sha ${shas[run.side]}`,
      )
    if (files.has(run.file)) throw new Error(`${run.file}: duplicate file`)
    files.add(run.file)
    const key = `${run.side}\0${run.round}\0${run.result.case}`
    if (keys.has(key))
      throw new Error(
        `${run.file}: duplicate ${run.side} round ${run.round} case ${run.result.case}`,
      )
    keys.add(key)
    const entry = grouped.get(run.result.case) ?? { base: new Map(), head: new Map() }
    entry[run.side].set(run.round, run)
    grouped.set(run.result.case, entry)
  }

  const repeats = Math.max(0, ...input.runs.map((run) => run.round))
  if (repeats < 3) throw new Error(`At least three rounds per side are required, found ${repeats}`)
  for (const [name, entry] of grouped)
    for (const side of sides)
      for (let round = 1; round <= repeats; round++)
        if (!entry[side].has(round))
          throw new Error(`Missing ${side} round ${round} for case ${name}`)

  const diagnosticKeys = new Set<string>()
  for (const diagnostic of input.diagnostics) {
    if (!diagnostic.result.diagnostic)
      throw new Error(`${diagnostic.file}: diagnostic file is not marked diagnostic`)
    if (diagnostic.result.sha !== shas[diagnostic.side])
      throw new Error(
        `${diagnostic.file}: sha ${diagnostic.result.sha} is not the ${diagnostic.side} sha`,
      )
    if (files.has(diagnostic.file)) throw new Error(`${diagnostic.file}: duplicate file`)
    files.add(diagnostic.file)
    const key = `${diagnostic.side}\0${diagnostic.result.case}`
    if (diagnosticKeys.has(key))
      throw new Error(
        `${diagnostic.file}: duplicate ${diagnostic.side} diagnostic for case ${diagnostic.result.case}`,
      )
    diagnosticKeys.add(key)
  }

  if (input.order !== null) {
    const listed = new Set<string>()
    for (const file of input.order) {
      if (!files.has(file)) throw new Error(`order.json names unknown file ${file}`)
      if (listed.has(file)) throw new Error(`order.json repeats file ${file}`)
      listed.add(file)
    }
  }

  const cases = [...grouped.keys()].sort().map((name): CaseSummary => {
    const entry = grouped.get(name)!
    const ordered = (side: Side) => [...entry[side].values()].sort((a, b) => a.round - b.round)
    const runs = { base: ordered("base"), head: ordered("head") }
    const reasons = sides.flatMap((side) =>
      runs[side].flatMap((run) => unhealthy(run.result).map((reason) => `${run.file}: ${reason}`)),
    )
    const comparable = reasons.length === 0
    return {
      case: name,
      comparable,
      reasons,
      files: { base: runs.base.map((run) => run.file), head: runs.head.map((run) => run.file) },
      counters: {
        base: sum(runs.base.map((run) => run.result)),
        head: sum(runs.head.map((run) => run.result)),
      },
      metrics: metricNames.map((metric) =>
        summarizeMetric(
          metric,
          runs.base.map((run) => run.result.metrics[metric]),
          runs.head.map((run) => run.result.metrics[metric]),
          comparable,
        ),
      ),
    }
  })

  return {
    schemaVersion: 1,
    baseSha,
    headSha,
    environment: input.githubActions ? "github-actions" : "local",
    repeats,
    valid: cases.every((entry) => entry.comparable),
    order: input.order,
    cases,
    diagnostics: [...input.diagnostics].sort((a, b) => a.file.localeCompare(b.file)),
    limitations: [
      ...(input.githubActions
        ? []
        : ["Shared host or local run: a quick signal, not a CI reference."]),
      "Verdicts compare independent per-run medians by [min, max] range overlap; they make no statistical-confidence claim.",
      "SQL elapsed comes from pg_stat_statements and is database time, not CPU.",
      "Diagnostic files are listed for context and never contribute to timing.",
    ],
  }
}

const number = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 1 ? 4 : 2)

const cell = (value: Range | null) =>
  value === null
    ? "unknown"
    : `${number(value.median)} [${number(value.min)}, ${number(value.max)}]`

/** Concise Markdown: case status, only the non-overlapping metrics, then reasons for suppressed verdicts. */
export const renderMarkdown = (summary: Summary): string => {
  const flagged = summary.cases.flatMap((entry) =>
    entry.metrics
      .filter((metric) => metric.verdict === "improved" || metric.verdict === "regressed")
      .map((metric) => {
        const change = metric.changePercent === null ? "n/a" : `${number(metric.changePercent)}%`
        return `| ${entry.case} | ${metric.name} | ${cell(metric.base)} | ${cell(metric.head)} | ${change} | ${metric.verdict} |`
      }),
  )
  const invalid = summary.cases.filter((entry) => !entry.comparable)
  const values = summary.cases.flatMap((entry) =>
    entry.metrics.map(
      (metric) =>
        `| ${entry.case} | ${metric.name} | ${cell(metric.base)} | ${cell(metric.head)} | ${metric.verdict} |`,
    ),
  )
  const tally = (entry: CaseSummary, verdict: Verdict) =>
    entry.metrics.filter((metric) => metric.verdict === verdict).length
  return [
    "# Benchmark repeat report",
    "",
    `Base \`${summary.baseSha}\` vs head \`${summary.headSha}\`, ${summary.repeats} repeats per side, ${summary.environment}.`,
    summary.valid
      ? "All cases are clean and comparable."
      : `${invalid.length} of ${summary.cases.length} cases are not comparable; they carry no speed verdict.`,
    "",
    "## Cases",
    "",
    "| Case | Status | Improved | Regressed | Overlapping | Unknown |",
    "| --- | --- | --- | --- | --- | --- |",
    ...summary.cases.map(
      (entry) =>
        `| ${entry.case} | ${entry.comparable ? "comparable" : "not comparable"} | ${tally(entry, "improved")} | ${tally(entry, "regressed")} | ${tally(entry, "overlapping")} | ${tally(entry, "unknown")} |`,
    ),
    "",
    "## Per-case medians and observed ranges",
    "",
    "| Case | Metric | Base median [min, max] | Head median [min, max] | Verdict |",
    "| --- | --- | --- | --- | --- |",
    ...values,
    "",
    "## Non-overlapping ranges",
    "",
    ...(flagged.length === 0
      ? ["None."]
      : [
          "| Case | Metric | Base median [min, max] | Head median [min, max] | Change | Verdict |",
          "| --- | --- | --- | --- | --- | --- |",
          ...flagged,
        ]),
    ...(invalid.length === 0
      ? []
      : [
          "",
          "## Not comparable",
          "",
          ...invalid.flatMap((entry) => [
            `- ${entry.case} (base refusals ${entry.counters.base.refusals}, head refusals ${entry.counters.head.refusals})`,
            ...entry.reasons.map((reason) => `  - ${reason}`),
          ]),
        ]),
    ...(summary.order === null
      ? []
      : ["", "## Repeat order", "", ...summary.order.map((file) => `- ${file}`)]),
    ...(summary.diagnostics.length === 0
      ? []
      : [
          "",
          "## Diagnostics (excluded from timing)",
          "",
          ...summary.diagnostics.map((entry) => `- ${entry.file}`),
        ]),
    "",
    "## Limitations",
    "",
    ...summary.limitations.map((limitation) => `- ${limitation}`),
    "",
  ].join("\n")
}

const retainedFile = /^(base|head)-r([1-9]\d*)-(.+)\.json$/
const diagnosticFile = /^diag-(base|head)-(.+)\.json$/

const decodeFile = async <A>(
  directory: string,
  file: string,
  decode: (text: string) => A,
): Promise<A> => {
  try {
    return decode(await readFile(join(directory, file), "utf8"))
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

/** Reads retained results by file name, requiring each name to agree with the case inside the file. */
export const report = async (
  directory: string,
  baseSha: string,
  headSha: string,
  githubActions: boolean,
) => {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()
  const runs: Array<RetainedRun> = []
  const diagnostics: Array<DiagnosticRun> = []
  for (const file of names) {
    if (file.endsWith(".mounts.json")) continue
    const retained = retainedFile.exec(file)
    const diagnostic = diagnosticFile.exec(file)
    if (retained === null && diagnostic === null) {
      if (/^(base|head|diag)-/.test(file))
        throw new Error(`${file}: unrecognised retained file name`)
      continue
    }
    const result = await decodeFile(directory, file, decodeResult)
    const name = retained?.[3] ?? diagnostic?.[2]
    if (result.case !== name) throw new Error(`${file}: file case differs from case ${result.case}`)
    if (retained !== null)
      runs.push({
        file,
        side: retained[1] === "base" ? "base" : "head",
        round: Number(retained[2]),
        result,
      })
    else if (diagnostic !== null)
      diagnostics.push({ file, side: diagnostic[1] === "base" ? "base" : "head", result })
  }
  const order = names.includes("order.json")
    ? await decodeFile(directory, "order.json", decodeOrder)
    : null
  const summary = summarize({ baseSha, headSha, runs, diagnostics, order, githubActions })
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "report.json"), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(join(directory, "report.md"), renderMarkdown(summary))
  return summary
}

const main = async (argv: ReadonlyArray<string>) => {
  const [directory, baseSha, headSha] = argv
  if (directory === undefined || baseSha === undefined || headSha === undefined) {
    console.error("Usage: bun report.ts <output-directory> <baseSHA> <headSHA>")
    process.exitCode = 2
    return
  }
  try {
    const summary = await report(directory, baseSha, headSha, process.env.GITHUB_ACTIONS === "true")
    console.log(
      `${join(directory, "report.md")} written; ${summary.valid ? "valid" : "not all cases comparable"}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (import.meta.main) await main(process.argv.slice(2))
