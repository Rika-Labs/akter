import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Schema } from "effect"

const Case = Schema.Struct({
  name: Schema.String,
  throughput: Schema.Finite,
  errors: Schema.Finite,
  latencyMs: Schema.Struct({ p50: Schema.Finite, p95: Schema.Finite, p99: Schema.Finite }),
})

const Result = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  profile: Schema.String,
  git: Schema.Struct({ shortSha: Schema.String }),
  backend: Schema.Struct({ name: Schema.String }),
  scenarios: Schema.Array(Schema.Struct({ name: Schema.String, cases: Schema.Array(Case) })),
})

export type Result = typeof Result.Type

export interface Change {
  readonly key: string
  readonly metric: "throughput" | "p50" | "p95" | "p99" | "errors"
  readonly before: number
  readonly after: number
  /** Relative change, positive when the metric got worse. */
  readonly worse: number
  readonly regression: boolean
}

const flatten = (result: Result) =>
  new Map(
    result.scenarios.flatMap((scenario) =>
      scenario.cases.map((entry) => [`${scenario.name}/${entry.name}`, entry] as const),
    ),
  )

/**
 * Pairs cases by scenario and case name. Latency is worse when it rises and
 * throughput when it falls; either beyond `threshold` (a fraction) is a
 * regression, as is any new error.
 */
export const compare = (input: {
  readonly before: Result
  readonly after: Result
  readonly threshold: number
}) => {
  const { before, after, threshold } = input
  const previous = flatten(before)
  const changes: Array<Change> = []
  const missing: Array<string> = []

  for (const [key, next] of flatten(after)) {
    const prior = previous.get(key)

    if (prior === undefined) {
      missing.push(key)
      continue
    }

    const relative = (from: number, to: number) => (from === 0 ? 0 : (to - from) / from)

    const metrics = [
      [
        "throughput",
        prior.throughput,
        next.throughput,
        -relative(prior.throughput, next.throughput),
      ],
      [
        "p50",
        prior.latencyMs.p50,
        next.latencyMs.p50,
        relative(prior.latencyMs.p50, next.latencyMs.p50),
      ],
      [
        "p95",
        prior.latencyMs.p95,
        next.latencyMs.p95,
        relative(prior.latencyMs.p95, next.latencyMs.p95),
      ],
      [
        "p99",
        prior.latencyMs.p99,
        next.latencyMs.p99,
        relative(prior.latencyMs.p99, next.latencyMs.p99),
      ],
    ] as const

    for (const [metric, from, to, worse] of metrics)
      changes.push({ key, metric, before: from, after: to, worse, regression: worse > threshold })

    if (next.errors > prior.errors)
      changes.push({
        key,
        metric: "errors",
        before: prior.errors,
        after: next.errors,
        worse: 1,
        regression: true,
      })
  }

  return { changes, missing }
}

const percent = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 1000) / 10}%`

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const [beforePath, afterPath] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const thresholdIndex = process.argv.indexOf("--threshold")
  const threshold = thresholdIndex === -1 ? 0.1 : Number(process.argv[thresholdIndex + 1]) / 100

  if (beforePath === undefined || afterPath === undefined)
    return yield* Effect.die(
      new Error(
        "usage: bun run bench:compare <before.json> <after.json> [--threshold 10] [--fail]",
      ),
    )

  const read = (path: string) =>
    fs
      .readFileString(path)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Result))), Effect.orDie)

  const before = yield* read(beforePath)
  const after = yield* read(afterPath)

  const name = (result: Result) =>
    `${result.git.shortSha}${result.label === null ? "" : ` (${result.label})`} ${result.backend.name}/${result.profile}`

  yield* Console.log(`before: ${name(before)}\nafter:  ${name(after)}\n`)

  const { changes, missing } = compare({ before, after, threshold })

  const rows = new Map<string, Array<Change>>()

  for (const change of changes) rows.set(change.key, [...(rows.get(change.key) ?? []), change])

  for (const [key, entries] of rows) {
    const cells = entries.map(
      (change) =>
        `${change.metric} ${change.before}→${change.after} (${percent(change.metric === "throughput" ? -change.worse : change.worse)})${change.regression ? " REGRESSION" : ""}`,
    )

    yield* Console.log(`${key}\n  ${cells.join("\n  ")}`)
  }

  for (const key of missing) yield* Console.log(`${key}: new case, no baseline`)

  const regressions = changes.filter((change) => change.regression)

  yield* Console.log(
    `\n${regressions.length} regression(s) beyond ${Math.round(threshold * 100)}% across ${rows.size} case(s)`,
  )

  if (regressions.length > 0 && process.argv.includes("--fail"))
    return yield* Effect.die(new Error("Regressions found"))
})

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  await runtime.runPromise(program).finally(() => runtime.dispose())
}
