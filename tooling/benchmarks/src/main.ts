import { BunServices } from "@effect/platform-bun"
import {
  Config,
  Console,
  DateTime,
  Effect,
  FileSystem,
  ManagedRuntime,
  Option,
  Path,
  Schema,
} from "effect"
import { type Backend, type BackendName, pglite, postgres } from "./backend.ts"
import { machine, runtimeVersions, source } from "./environment.ts"
import { type CaseResult, type Scenario, withRuntime } from "./scenario.ts"
import { coldActivation } from "./scenarios/cold-activation.ts"
import { effectRoundTrip } from "./scenarios/effect-round-trip.ts"
import { events } from "./scenarios/events.ts"
import { hotActor } from "./scenarios/hot-actor.ts"
import { ownedRows } from "./scenarios/owned-rows.ts"
import { multiRunner } from "./scenarios/multi-runner.ts"
import { outbox } from "./scenarios/outbox.ts"
import { queryLatency } from "./scenarios/query-latency.ts"
import { receiptReplay } from "./scenarios/receipt-replay.ts"
import { reducers } from "./scenarios/reducers.ts"
import { capacity } from "./scenarios/scale/capacity.ts"
import { manyActors } from "./scenarios/scale/many-actors.ts"
import { retainedHeap } from "./scenarios/scale/retained-heap.ts"
import { stateSize } from "./scenarios/state-size.ts"

/** Every scenario, in run order. A new slice adds its scenario here. */
const SCENARIOS: ReadonlyArray<Scenario> = [
  hotActor,
  coldActivation,
  queryLatency,
  receiptReplay,
  stateSize,
  events,
  manyActors,
  retainedHeap,
  outbox,
  ownedRows,
  effectRoundTrip,
  multiRunner,
  reducers,
  capacity,
]

const RESULT_SCHEMA = 2

const flag = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)

  return index === -1 ? undefined : process.argv[index + 1]
}

const describeCase = (scenario: string, result: CaseResult) => {
  const latency = result.latencyMs

  const statements =
    result.statementsPerOperation === null ? "" : ` stmts/op=${result.statementsPerOperation}`

  const cpu =
    result.cpu.clientMsPerOperation === null ? "" : ` cpu/op=${result.cpu.clientMsPerOperation} ms`

  const errors = result.errors === 0 ? "" : ` errors=${JSON.stringify(result.errorKinds)}`

  return `  ${scenario}/${result.name}: ${result.throughput} op/s p50=${latency.p50} p95=${latency.p95} p99=${latency.p99} ms${statements}${cpu}${errors}`
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const profile = yield* Schema.decodeUnknownEffect(Schema.Literals(["quick", "full"]))(
    flag("profile") ?? "full",
  ).pipe(Effect.orDie)

  const requested = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["all", "postgres", "pglite"]),
  )(flag("backend") ?? "all").pipe(Effect.orDie)

  const only = flag("scenario")?.split(",")

  const unknown = only?.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name))

  if (unknown !== undefined && unknown.length > 0)
    return yield* Effect.die(
      new Error(
        `Unknown scenario ${unknown.join(", ")}; known: ${SCENARIOS.map((s) => s.name).join(", ")}`,
      ),
    )

  const label = flag("label")
  const note = flag("note")
  const external = Option.getOrUndefined(yield* Config.option(Config.String("BENCH_DATABASE_URL")))

  const backends: ReadonlyArray<BackendName> =
    requested === "all" ? ["postgres", "pglite"] : [requested]

  const selected = SCENARIOS.filter(
    (scenario) => only === undefined || only.includes(scenario.name),
  )

  if (selected.length === 0)
    return yield* Effect.die(
      new Error(`No scenario matches; known: ${SCENARIOS.map((s) => s.name).join(", ")}`),
    )

  const code = yield* source
  const host = yield* machine(external !== undefined)

  if (code.dirty)
    yield* Console.warn(
      "warning: tracked files have uncommitted changes; this result is recorded as dirty and is not a baseline",
    )
  const versions = yield* runtimeVersions
  const root = path.resolve(import.meta.dir, "../../..")
  const directory = path.resolve(root, flag("out") ?? "benchmarks/results")
  yield* fs.makeDirectory(directory, { recursive: true })

  for (const name of backends)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const backend: Backend = name === "postgres" ? yield* postgres(external) : yield* pglite
        const startedAt = DateTime.formatIso(yield* DateTime.now)
        yield* Console.log(`${backend.name}: ${backend.version}`)

        const scenarios = []

        for (const scenario of selected) {
          yield* Console.log(`${scenario.name} (${profile})`)

          const cases = yield* scenario.run({
            backend,
            profile,
            withRuntime: withRuntime(backend),
          })

          for (const result of cases) yield* Console.log(describeCase(scenario.name, result))
          scenarios.push({ name: scenario.name, description: scenario.description, cases })
        }

        const file = [
          startedAt.slice(0, 10),
          code.shortSha,
          ...(label === undefined ? [] : [label]),
          backend.name,
          ...(profile === "quick" ? ["quick"] : []),
        ].join("-")

        const output = path.join(directory, `${file}.json`)

        const json = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown, { space: 2 }),
        )({
          schema: RESULT_SCHEMA,
          label: label ?? null,
          note: note ?? null,
          profile,
          startedAt,
          finishedAt: DateTime.formatIso(yield* DateTime.now),
          git: code,
          backend: {
            name: backend.name,
            version: backend.version,
            settings: backend.settings,
            external: backend.name === "postgres" && external !== undefined,
          },
          runtime: versions,
          machine: host,
          scenarios,
        }).pipe(Effect.orDie)

        yield* fs.writeFileString(output, `${json}\n`)
        yield* Console.log(`wrote ${path.relative(root, output)}`)
      }),
    )
})

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  await runtime.runPromise(program).finally(() => runtime.dispose())
}
