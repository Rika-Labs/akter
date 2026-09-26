import { Schema } from "effect"

/** The part of Vitest's JSON reporter output a stress run reads. */
export const VitestReport = Schema.fromJsonString(
  Schema.Struct({
    success: Schema.Boolean,
    testResults: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        assertionResults: Schema.Array(
          Schema.Struct({ fullName: Schema.String, status: Schema.String }),
        ),
      }),
    ),
  }),
)

export interface StressRun {
  readonly run: string
  /** Undefined when the run died before Vitest wrote its report. */
  readonly report: typeof VitestReport.Type | undefined
}

export interface Flake {
  readonly name: string
  readonly failed: ReadonlyArray<string>
}

/** Every case that failed in at least one run, with the runs it failed in, worst first. */
export function tallyFlakes(runs: ReadonlyArray<StressRun>): ReadonlyArray<Flake> {
  const failed = new Map<string, Array<string>>()

  const record = (name: string, run: string) => failed.set(name, [...(failed.get(name) ?? []), run])

  for (const { run, report } of runs) {
    if (report === undefined) {
      record("(no report: the run died before Vitest finished)", run)
      continue
    }

    const before = [...failed.values()].flat().length

    for (const file of report.testResults) {
      const cases = file.assertionResults.filter((test) => test.status === "failed")

      for (const test of cases) record(`${file.name} > ${test.fullName}`, run)

      // A file that fails outside its cases, e.g. at import, names no case.
      if (file.status === "failed" && cases.length === 0) record(`${file.name} (file failed)`, run)
    }

    // Vitest also fails a run for errors outside any file, e.g. an unhandled rejection.
    if (!report.success && [...failed.values()].flat().length === before)
      record("(run failed without a failing case: see its log)", run)
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
