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
import { blobs } from "./scenarios/storage/blobs.ts"
import { coldActivation } from "./scenarios/cold-activation.ts"
import { connections } from "./scenarios/connections.ts"
import { effectConcurrency } from "./scenarios/effect-concurrency.ts"
import { effectRoundTrip } from "./scenarios/effect-round-trip.ts"
import { events } from "./scenarios/events.ts"
import { retention } from "./scenarios/retention.ts"
import { hotActor } from "./scenarios/hot-actor.ts"
import { turnBatches } from "./scenarios/turn-batches.ts"
import { http } from "./scenarios/http.ts"
import { inspectionViews } from "./scenarios/inspection-views.ts"
import { ownedRows } from "./scenarios/storage/owned-rows.ts"
import { multiRunner } from "./scenarios/multi-runner.ts"
import { outbox } from "./scenarios/outbox.ts"
import { queryLatency } from "./scenarios/query-latency.ts"
import { receiptReplay } from "./scenarios/receipt-replay.ts"
import { reducers } from "./scenarios/reducers.ts"
import { capacity } from "./scenarios/scale/capacity.ts"
import { manyActors } from "./scenarios/scale/many-actors.ts"
import { singletonFailover } from "./scenarios/singleton-failover.ts"
import { retainedHeap } from "./scenarios/scale/retained-heap.ts"
import { stateSize } from "./scenarios/state-size.ts"
import { storedOverhead } from "./scenarios/scale/stored-overhead.ts"
import { subscriptions } from "./scenarios/subscriptions.ts"
import { workflowCheck } from "./scenarios/workflow-check.ts"
import { workflows } from "./scenarios/workflows.ts"
import { mint } from "./scenarios/mint.ts"
import { orders } from "./scenarios/orders.ts"

/** Every scenario, in run order. A new slice adds its scenario here. */
const SCENARIOS: ReadonlyArray<Scenario> = [
  hotActor,
  turnBatches,
  coldActivation,
  queryLatency,
  receiptReplay,
  stateSize,
  events,
  manyActors,
  retainedHeap,
  storedOverhead,
  outbox,
  ownedRows,
  effectRoundTrip,
  effectConcurrency,
  multiRunner,
  singletonFailover,
  blobs,
  reducers,
  capacity,
  inspectionViews,
  retention,
  http,
  subscriptions,
  workflows,
  connections,
  workflowCheck,
  mint,
  orders,
]

/**
 * Scenarios whose statements per operation the CI gate checks against the
 * committed baseline. The rest measure memory or scale, which statement
 * counts don't describe, and take too long for every pull request.
 */
const STATEMENT_GATE: ReadonlyArray<string> = [
  "hot-actor",
  "turn-batches",
  "cold-activation",
  "query-latency",
  "receipt-replay",
  "events",
  "outbox",
  "owned-rows",
  "effect-round-trip",
]

const RESULT_SCHEMA = 2

const flag = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)

  return index === -1 ? undefined : process.argv[index + 1]
}

const describeCase = (scenario: string, result: CaseResult) => {
  const latency = result.latencyMs

  const statements =
    (result.statementsPerOperation === null ? "" : ` stmts/op=${result.statementsPerOperation}`) +
    (result.roundTripsPerOperation === null ? "" : ` rt/op=${result.roundTripsPerOperation}`)

  const cpu =
    result.cpu.clientMsPerOperation === null ? "" : ` cpu/op=${result.cpu.clientMsPerOperation} ms`

  const errors = result.errors === 0 ? "" : ` errors=${JSON.stringify(result.errorKinds)}`

  return `  ${scenario}/${result.name}: ${result.throughput} op/s p50=${latency.p50} p95=${latency.p95} p99=${latency.p99} ms${statements}${cpu}${errors}`
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const profile = yield* Schema.decodeUnknownEffect(Schema.Literals(["quick", "ci", "full"]))(
    flag("profile") ?? "full",
  ).pipe(Effect.orDie)

  const requested = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["all", "postgres", "pglite"]),
  )(flag("backend") ?? (profile === "ci" ? "postgres" : "all")).pipe(Effect.orDie)

  if (profile === "ci" && requested !== "postgres")
    return yield* Effect.die(
      new Error("--profile ci counts statements, which only the postgres backend records"),
    )

  const only = flag("scenario")?.split(",") ?? (profile === "ci" ? STATEMENT_GATE : undefined)

  const unknown = only?.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name))

  if (unknown !== undefined && unknown.length > 0)
    return yield* Effect.die(
      new Error(
        `Unknown scenario ${unknown.join(", ")}; known: ${SCENARIOS.map((s) => s.name).join(", ")}`,
      ),
    )

  const runnerCounts = (flag("runners") ?? "1").split(",").map(Number)

  if (runnerCounts.some((count) => !Number.isInteger(count) || count < 1))
    return yield* Effect.die(new Error("--runners takes positive integers, e.g. 1,2,4"))

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
          const cases = []

          // One runner keeps the embedded runtime and the case names the baselines use.
          for (const runners of scenario.multiRunner === true ? runnerCounts : [1]) {
            if (runners > 1 && backend.name !== "postgres") continue
            yield* Console.log(`${scenario.name} (${profile}, ${runners} runner(s))`)

            const measured = yield* scenario.run({
              backend,
              profile: profile === "ci" ? "quick" : profile,
              runners,
              withRuntime: withRuntime({ backend, runners }),
            })

            for (const result of measured) {
              const named =
                runners === 1
                  ? result
                  : {
                      ...result,
                      name: `${result.name}-runners-${runners}`,
                      parameters: { ...result.parameters, runners },
                    }

              yield* Console.log(describeCase(scenario.name, named))
              cases.push(named)
            }
          }

          scenarios.push({ name: scenario.name, description: scenario.description, cases })
        }

        const file = [
          startedAt.slice(0, 10),
          code.shortSha,
          ...(label === undefined ? [] : [label]),
          backend.name,
          ...(profile === "full" ? [] : [profile]),
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
