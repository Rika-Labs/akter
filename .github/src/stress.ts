import { Schema } from "effect"

/** The part of Vitest's JSON reporter output a stress run reads. */
export const VitestReport = Schema.fromJsonString(
  Schema.Struct({
    success: Schema.Boolean,
    testResults: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        /** The file's own error, e.g. at import or in a hook, or "" when it has none. */
        message: Schema.String,
        assertionResults: Schema.Array(
          Schema.Struct({ fullName: Schema.String, status: Schema.String }),
        ),
      }),
    ),
  }),
)

export interface StressRun {
  readonly run: string
  /** The suite the run executed; it names failures that no file or case accounts for. */
  readonly suite: string
  /** Whether the run began, i.e. wrote a log; false for a run the step's time budget cut off before it started. */
  readonly started: boolean
  /** Undefined when the run died before Vitest wrote its report. */
  readonly report: typeof VitestReport.Type | undefined
  /** The suite's exit status, or undefined when it was not recorded. */
  readonly status: number | undefined
  /** Vitest reports unhandled errors only in its log, never in the JSON report. */
  readonly unhandledErrors: boolean
}

export interface Flake {
  readonly name: string
  readonly failed: ReadonlyArray<string>
}

/** Every case that failed in at least one run, with the runs it failed in, worst first. */
export function tallyFlakes(runs: ReadonlyArray<StressRun>): ReadonlyArray<Flake> {
  const failed = new Map<string, Array<string>>()

  const record = (name: string, run: string) => failed.set(name, [...(failed.get(name) ?? []), run])

  for (const { run, suite, started, report, status, unhandledErrors } of runs) {
    const before = [...failed.values()].flat().length

    if (unhandledErrors) record(`${suite} (unhandled errors: see its log)`, run)

    if (report === undefined) {
      record(
        started
          ? `${suite} (no report: the run died before Vitest finished)`
          : `${suite} (never started: the step ran out of time before this run)`,
        run,
      )
      continue
    }

    if (status === undefined) record(`${suite} (no exit status: the run was cut off)`, run)

    for (const file of report.testResults) {
      const cases = file.assertionResults.filter((test) => test.status === "failed")

      for (const test of cases) record(`${file.name} > ${test.fullName}`, run)

      // A file can fail outside its cases, e.g. at import or in a hook, as well as in them.
      if (file.status === "failed" && (cases.length === 0 || file.message !== ""))
        record(`${file.name} (file failed)`, run)
    }

    const nothingRecorded = [...failed.values()].flat().length === before

    if (nothingRecorded && (!report.success || status !== 0))
      record(`${suite} (run failed without a failing case: see its log)`, run)
  }

  return [...failed]
    .map(([name, runs]) => ({ name, failed: runs }))
    .toSorted((a, b) => b.failed.length - a.failed.length || a.name.localeCompare(b.name))
}

export function stressSummary({
  runs,
  flakes,
}: {
  readonly runs: number
  readonly flakes: ReadonlyArray<Flake>
}) {
  if (flakes.length === 0) return `No case failed in ${runs} runs under CPU load.\n`

  const rows = flakes.map(
    ({ name, failed }) =>
      `| ${name.replaceAll("|", "\\|")} | ${failed.length}/${runs} | ${failed.join(", ")} |`,
  )

  return [
    `${flakes.length} case(s) failed across ${runs} runs under CPU load.`,
    "",
    "| Case | Failed | Runs |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n")
}
