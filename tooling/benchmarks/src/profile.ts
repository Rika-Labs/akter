import { Session } from "node:inspector/promises"
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
import { type Backend, pglite, postgres } from "./backend.ts"
import { source } from "./environment.ts"
import { load } from "./measure.ts"
import { Probe } from "./probe/contract.ts"
import { withRuntime } from "./scenario.ts"

const CpuProfile = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      callFrame: Schema.Struct({
        functionName: Schema.String,
        url: Schema.String,
        lineNumber: Schema.Finite,
      }),
      children: Schema.optional(Schema.Array(Schema.Finite)),
    }),
  ),
  samples: Schema.Array(Schema.Finite),
  timeDeltas: Schema.Array(Schema.Finite),
})

type CpuProfile = typeof CpuProfile.Type

type CallFrame = CpuProfile["nodes"][number]["callFrame"]

const flag = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)

  return index === -1 ? undefined : process.argv[index + 1]
}

/** The package or source area a frame belongs to, so a profile reads by layer. */
const area = (url: string) => {
  if (url === "" || url === "[native code]") return "native"

  const modules = /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\/(.*)$/.exec(
    url,
  )

  if (modules !== null) {
    const [, name, rest] = modules

    if (name === "effect") {
      if (/^dist\/(Schema|internal\/schema)/.test(rest!)) return "effect/schema"

      const module = /^dist\/([a-z-]+)\//.exec(rest!)

      return module !== null && module[1] !== "internal" ? `effect/${module[1]}` : "effect/core"
    }

    return name!
  }

  const workspace = /\/packages\/durable-actors\/src\/(.*)$/.exec(url)

  if (workspace !== null) return `durable-actors/${workspace[1]!.split("/")[0]}`

  return url.startsWith("node:") || url.startsWith("internal:") ? "runtime builtins" : "other"
}

const location = (frame: CallFrame) => {
  if (frame.url === "" || frame.url === "[native code]") return "[native code]"
  const short = frame.url.replace(/^.*node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?/, "")

  return `${short.replace(/^.*\/packages\/durable-actors\//, "durable-actors/")}:${frame.lineNumber + 1}`
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 1000) / 10}%`

/**
 * Self time by function and by area, and inclusive time for the runtime's
 * own functions, over the profiled window only.
 */
const summarize = (
  profile: CpuProfile,
  context: { readonly title: string; readonly lines: ReadonlyArray<string> },
) => {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()

  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id)

  const self = new Map<number, number>()
  const total = profile.timeDeltas.reduce((sum, delta) => sum + delta, 0)

  profile.samples.forEach((id, index) => {
    const delta = profile.timeDeltas[index + 1] ?? 0
    self.set(id, (self.get(id) ?? 0) + delta)
  })

  const idle = [...self].reduce(
    (sum, [id, time]) => (byId.get(id)!.callFrame.functionName === "(idle)" ? sum + time : sum),
    0,
  )

  const busy = total - idle
  const functions = new Map<string, { self: number; area: string }>()
  const areas = new Map<string, number>()
  const inclusive = new Map<string, number>()

  for (const [id, time] of self) {
    const frame = byId.get(id)!.callFrame

    if (frame.functionName === "(idle)") continue
    const key = `\`${frame.functionName || "(anonymous)"}\` | ${location(frame)}`
    const entry = functions.get(key) ?? { self: 0, area: area(frame.url) }
    functions.set(key, { ...entry, self: entry.self + time })
    areas.set(entry.area, (areas.get(entry.area) ?? 0) + time)

    const seen = new Set<string>()

    for (let cursor: number | undefined = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const ancestor = byId.get(cursor)!.callFrame

      if (!ancestor.url.includes("/packages/durable-actors/src/")) continue
      const name = `\`${ancestor.functionName || "(anonymous)"}\` | ${location(ancestor)}`

      if (seen.has(name)) continue
      seen.add(name)
      inclusive.set(name, (inclusive.get(name) ?? 0) + time)
    }
  }

  const ms = (micros: number) => `${Math.round(micros / 100) / 10} ms`

  const table = (header: string, rows: ReadonlyArray<readonly [string, number]>, limit: number) => [
    header,
    ...rows
      .toSorted(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([name, time]) => `| ${pct(time, busy)} | ${ms(time)} | ${name} |`),
  ]

  return [
    `# ${context.title}`,
    "",
    ...context.lines,
    "",
    `Sampled ${ms(total)}, of which ${ms(busy)} on the CPU. Percentages are of CPU time.`,
    "",
    "## Self time by area",
    "",
    ...table(
      "| Share | Time | Area |\n| ---: | ---: | --- |",
      [...areas].map(([name, time]) => [`\`${name}\``, time] as const),
      40,
    ),
    "",
    "## Inclusive time in the runtime's own functions",
    "",
    ...table(
      "| Share | Time | Function | Location |\n| ---: | ---: | --- | --- |",
      [...inclusive],
      30,
    ),
    "",
    "## Hottest functions by self time",
    "",
    ...table(
      "| Share | Time | Function | Location |\n| ---: | ---: | --- | --- |",
      [...functions].map(([name, { self: time }]) => [name, time] as const),
      50,
    ),
    "",
  ].join("\n")
}

/**
 * Profiles warm `hot-actor` turns: one caller sending `Add` to one resident
 * actor. Only the measured window is sampled, so setup, migrations, and the
 * warm-up never appear in the profile.
 */
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const backendName = yield* Schema.decodeUnknownEffect(Schema.Literals(["postgres", "pglite"]))(
    flag("backend") ?? "postgres",
  ).pipe(Effect.orDie)

  const operations = Number(flag("operations") ?? "5000")
  const label = flag("label")
  const external = Option.getOrUndefined(yield* Config.option(Config.String("BENCH_DATABASE_URL")))
  const code = yield* source

  if (code.dirty)
    yield* Console.warn("warning: tracked files have uncommitted changes; this profile is dirty")
  const root = path.resolve(import.meta.dir, "../../..")
  const directory = path.resolve(root, flag("out") ?? "benchmarks/profiles")
  yield* fs.makeDirectory(directory, { recursive: true })

  const backend: Backend = backendName === "postgres" ? yield* postgres(external) : yield* pglite
  const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10)

  const { profile, cpuMs, elapsedMs } = yield* withRuntime({ backend, runners: 1 })({}, () =>
    Effect.gen(function* () {
      const probe = yield* Probe.get("hot")
      yield* load({ workers: 1, operations: 500, operation: () => probe.Add(1) })

      const session = new Session()
      session.connect()
      yield* Effect.promise(() => session.post("Profiler.enable"))
      yield* Effect.promise(() => session.post("Profiler.setSamplingInterval", { interval: 100 }))
      yield* Effect.promise(() => session.post("Profiler.start"))
      const before = process.cpuUsage()
      const started = performance.now()
      const result = yield* load({ workers: 1, operations, operation: () => probe.Add(1) })
      const elapsed = performance.now() - started
      const cpu = process.cpuUsage(before)
      const stopped = yield* Effect.promise(() => session.post("Profiler.stop"))
      session.disconnect()

      if (result.errors > 0)
        return yield* Effect.die(new Error(`${result.errors} turns failed while profiling`))

      return {
        profile: stopped.profile,
        cpuMs: (cpu.user + cpu.system) / 1000,
        elapsedMs: elapsed,
      }
    }),
  )

  const file = [
    date,
    code.shortSha,
    ...(label === undefined ? [] : [label]),
    backend.name,
    "hot-actor",
  ].join("-")

  const round = (value: number) => Math.round(value * 1000) / 1000

  const parsed = yield* Schema.decodeUnknownEffect(CpuProfile)(profile).pipe(Effect.orDie)

  const markdown = summarize(parsed, {
    title: `hot-actor warm turns, ${code.shortSha}${label === undefined ? "" : ` (${label})`}, ${backend.name}`,
    lines: [
      `${operations} sequential \`Add\` turns on one resident actor after 500 warm-up turns, sampled every 100 µs. The process spent ${round(cpuMs / operations)} CPU ms per turn (profiler overhead included) over ${round(elapsedMs / operations)} ms of wall time per turn.`,
      "",
      `Commit \`${code.sha}\`${code.dirty ? " (dirty)" : ""}, ${backend.version.split(" on ")[0]}.`,
    ],
  })

  yield* fs.writeFileString(path.join(directory, `${file}.md`), markdown)

  const raw = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(profile).pipe(
    Effect.orDie,
  )

  yield* fs.writeFileString(path.join(directory, `${file}.cpuprofile`), raw)
  yield* Console.log(`wrote ${path.relative(root, path.join(directory, file))}.{md,cpuprofile}`)
})

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  await runtime.runPromise(Effect.scoped(program)).finally(() => runtime.dispose())
}
