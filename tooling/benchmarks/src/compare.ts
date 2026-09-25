import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Schema } from "effect"

const Case = Schema.Struct({
  name: Schema.String,
  throughput: Schema.Finite,
  errors: Schema.Finite,
  statementsPerOperation: Schema.optional(Schema.NullOr(Schema.Finite)),
  latencyMs: Schema.Struct({ p50: Schema.Finite, p95: Schema.Finite, p99: Schema.Finite }),
})

const Result = Schema.Struct({
  schema: Schema.Finite,
  label: Schema.NullOr(Schema.String),
  profile: Schema.String,
  git: Schema.Struct({ shortSha: Schema.String }),
  backend: Schema.Struct({ name: Schema.String }),
  machine: Schema.Struct({
    cpuModel: Schema.String,
    logicalCpus: Schema.Finite,
    hostname: Schema.optional(Schema.String),
  }),
  scenarios: Schema.Array(Schema.Struct({ name: Schema.String, cases: Schema.Array(Case) })),
})

export type Result = typeof Result.Type

export interface Change {
  readonly key: string
  readonly metric: "throughput" | "p50" | "p95" | "p99" | "statements" | "errors"
  readonly before: number
  readonly after: number
  /**
   * How much worse the metric got, positive when worse: a fraction for
   * throughput and latency, an absolute count for statements per operation.
   */
  readonly worse: number
  readonly regression: boolean
}

const flatten = (result: Result) =>
  new Map(
    result.scenarios.flatMap((scenario) =>
      scenario.cases.map((entry) => [`${scenario.name}/${entry.name}`, entry] as const),
    ),
  )

/** Statements per operation do not depend on the machine, so any rise beyond rounding is real. */
const STATEMENT_THRESHOLD = 0.5

/**
 * Pairs cases by scenario and case name. Latency is worse when it rises and
 * throughput when it falls; either beyond `threshold` (a fraction) is a
 * regression, as are more statements per operation and any new error.
 */
export const compare = (input: {
  readonly before: Result
  readonly after: Result
  readonly threshold: number
}) => {
  const { before, after, threshold } = input
  const previous = flatten(before)
  const changes: Array<Change> = []
  const added: Array<string> = []
  const current = flatten(after)
  const removed = [...previous.keys()].filter((key) => !current.has(key))

  for (const [key, next] of current) {
    const prior = previous.get(key)

    if (prior === undefined) {
      added.push(key)
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

    const statementsBefore = prior.statementsPerOperation ?? null
    const statementsAfter = next.statementsPerOperation ?? null

    if (statementsBefore !== null && statementsAfter !== null)
      changes.push({
        key,
        metric: "statements",
        before: statementsBefore,
        after: statementsAfter,
        worse: statementsAfter - statementsBefore,
        regression: statementsAfter - statementsBefore > STATEMENT_THRESHOLD,
      })

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

  return { changes, added, removed }
}

/**
 * The committed statement counts the CI gate holds every pull request to: one
 * `ci` profile run on Postgres, reduced to statements per operation by case.
 */
const Baseline = Schema.Struct({
  profile: Schema.Literal("ci"),
  backend: Schema.Literal("postgres"),
  sha: Schema.String,
  statementsPerOperation: Schema.Record(Schema.String, Schema.Finite),
})

export type Baseline = typeof Baseline.Type

/**
 * How far a case's statements per operation may drift from the baseline
 * before the gate fails. Relay passes and Cluster retries land inside the
 * measured window a varying number of times, so repeat runs of one commit
 * differ by up to 0.13 under CPU load; one extra statement in every fourth
 * operation still fails.
 */
export const STATEMENT_TOLERANCE = 0.25

export const toBaseline = (result: Result): Baseline => {
  if (result.profile !== "ci" || result.backend.name !== "postgres")
    throw new Error(
      `a baseline comes from a ci profile run on postgres, not ${result.profile} on ${result.backend.name}`,
    )

  return {
    profile: "ci",
    backend: "postgres",
    sha: result.git.shortSha,
    statementsPerOperation: Object.fromEntries(
      [...flatten(result)].map(([key, entry]) => {
        if (entry.statementsPerOperation == null) throw new Error(`${key} has no statement count`)

        return [key, entry.statementsPerOperation]
      }),
    ),
  }
}

/**
 * Every case whose statements per operation moved beyond the tolerance, in
 * either direction: a rise is a new round trip, and a fall left unrecorded
 * would let a later rise back to the old count pass.
 */
export const compareStatements = (input: {
  readonly baseline: Baseline
  readonly result: Result
}) => {
  const expected = input.baseline.statementsPerOperation
  const current = toBaseline(input.result).statementsPerOperation

  const cases = Object.entries(current).flatMap(([key, after]) => {
    const before = expected[key]

    return before === undefined
      ? []
      : [{ key, before, after, changed: Math.abs(after - before) > STATEMENT_TOLERANCE }]
  })

  return {
    cases,
    added: Object.keys(current).filter((key) => !(key in expected)),
    removed: Object.keys(expected).filter((key) => !(key in current)),
  }
}

/** Reasons two results cannot be compared at all, and differences worth a warning. */
export const comparability = ({
  before,
  after,
}: {
  readonly before: Result
  readonly after: Result
}) => ({
  refuse: [
    before.schema === after.schema
      ? undefined
      : `result schema ${before.schema} vs ${after.schema}`,
    before.backend.name === after.backend.name
      ? undefined
      : `backend ${before.backend.name} vs ${after.backend.name}`,
    before.profile === after.profile ? undefined : `profile ${before.profile} vs ${after.profile}`,
  ].filter((reason) => reason !== undefined),
  warn:
    before.machine.cpuModel === after.machine.cpuModel &&
    before.machine.logicalCpus === after.machine.logicalCpus &&
    before.machine.hostname === after.machine.hostname
      ? []
      : ["the runs come from different machines; latency and throughput are not comparable"],
})

const percent = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 1000) / 10}%`

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const args = process.argv.slice(2)
  const positional: Array<string> = []
  let percentThreshold = 10

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!

    if (arg === "--threshold") {
      percentThreshold = Number(args[index + 1])
      index += 1
    } else if (!["--fail", "--statements", "--update"].includes(arg)) positional.push(arg)
  }

  if (!Number.isFinite(percentThreshold) || percentThreshold <= 0)
    return yield* Effect.die(new Error("--threshold takes a positive percentage"))

  const threshold = percentThreshold / 100
  const [beforePath, afterPath] = positional

  if (beforePath === undefined || afterPath === undefined || positional.length !== 2)
    return yield* Effect.die(
      new Error(
        "usage: bun run bench:compare <before.json> <after.json> [--threshold 10] [--fail]\n" +
          "       bun run bench:compare --statements <baseline.json> <ci-result.json> [--fail | --update]",
      ),
    )

  const read = (path: string) =>
    fs
      .readFileString(path)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Result))), Effect.orDie)

  const after = yield* read(afterPath)

  if (process.argv.includes("--statements")) return yield* statements(beforePath, after)

  const before = yield* read(beforePath)

  const name = (result: Result) =>
    `${result.git.shortSha}${result.label === null ? "" : ` (${result.label})`} ${result.backend.name}/${result.profile}`

  yield* Console.log(`before: ${name(before)}\nafter:  ${name(after)}\n`)

  const { refuse, warn } = comparability({ before, after })

  if (refuse.length > 0)
    return yield* Effect.die(new Error(`Results are not comparable: ${refuse.join("; ")}`))

  for (const warning of warn) yield* Console.warn(`warning: ${warning}\n`)

  const { changes, added, removed } = compare({ before, after, threshold })

  const rows = new Map<string, Array<Change>>()

  for (const change of changes) rows.set(change.key, [...(rows.get(change.key) ?? []), change])

  for (const [key, entries] of rows) {
    const cells = entries.map(
      (change) =>
        `${change.metric} ${change.before}→${change.after} (${
          change.metric === "statements"
            ? `${change.worse > 0 ? "+" : ""}${Math.round(change.worse * 100) / 100}`
            : percent(change.metric === "throughput" ? -change.worse : change.worse)
        })${change.regression ? " REGRESSION" : ""}`,
    )

    yield* Console.log(`${key}\n  ${cells.join("\n  ")}`)
  }

  for (const key of added) yield* Console.log(`${key}: new case, no baseline`)

  for (const key of removed) yield* Console.log(`${key}: in the baseline, missing from this run`)

  const regressions = changes.filter((change) => change.regression)

  yield* Console.log(
    `\n${regressions.length} regression(s) beyond ${Math.round(threshold * 100)}% across ${rows.size} case(s)`,
  )

  if (regressions.length > 0 && process.argv.includes("--fail"))
    return yield* Effect.die(new Error("Regressions found"))
})

const statements = Effect.fnUntraced(function* (baselinePath: string, result: Result) {
  const fs = yield* FileSystem.FileSystem

  if (process.argv.includes("--update")) {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(Baseline, { space: 2 }))(
      toBaseline(result),
    ).pipe(Effect.orDie)

    yield* fs.writeFileString(baselinePath, `${json}\n`).pipe(Effect.orDie)

    return yield* Console.log(`wrote ${baselinePath} from ${result.git.shortSha}`)
  }

  const baseline = yield* fs
    .readFileString(baselinePath)
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Baseline))), Effect.orDie)

  yield* Console.log(
    `baseline: ${baseline.sha}\nrun:      ${result.git.shortSha}\ntolerance: ±${STATEMENT_TOLERANCE} statements per operation\n`,
  )

  const { cases, added, removed } = compareStatements({ baseline, result })

  for (const { key, before, after, changed } of cases) {
    const delta = Math.round((after - before) * 100) / 100

    yield* Console.log(
      `${changed ? "CHANGED " : "        "}${key}: ${before}→${after} (${delta > 0 ? "+" : ""}${delta})`,
    )
  }

  for (const key of added) yield* Console.log(`ADDED   ${key}: not in the baseline`)

  for (const key of removed)
    yield* Console.log(`REMOVED ${key}: in the baseline, missing from this run`)

  const failures = cases.filter((entry) => entry.changed).length + added.length + removed.length

  if (failures === 0) return yield* Console.log(`\nstatements match the baseline`)

  yield* Console.log(
    `\n${failures} case(s) differ from the baseline. If the change is intended, update the baseline in this pull request and say why:\n` +
      `  bun run bench --profile ci --out /tmp/statements\n` +
      `  bun run bench:compare --statements ${baselinePath} /tmp/statements/<file>.json --update`,
  )

  if (process.argv.includes("--fail"))
    return yield* Effect.die(new Error("Statements per operation differ from the baseline"))
})

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  await runtime.runPromise(program).finally(() => runtime.dispose())
}
