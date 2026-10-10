import { BunRuntime, BunServices } from "@effect/platform-bun"
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const args = process.argv.slice(2)

const packageIndex = args.indexOf("--package")
const cliPackageIndex = args.indexOf("--cli-package")

const Versions = Schema.Record(Schema.String, Schema.String)

const StagedManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    peerDependencies: Schema.optionalKey(Versions),
  }),
)

const WorkspaceManifest = Schema.fromJsonString(
  Schema.Struct({
    workspaces: Schema.optionalKey(Schema.Struct({ catalog: Schema.optionalKey(Versions) })),
    devDependencies: Schema.optionalKey(Versions),
  }),
)

const run = Effect.fn("run")(function* (command: ReadonlyArray<string>, cwd: string) {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "inherit" })
  const stdout = yield* Effect.promise(() => new Response(child.stdout).text())

  if ((yield* Effect.promise(() => child.exited)) !== 0)
    return yield* Effect.die(new Error(`${command.join(" ")} failed:\n${stdout}`))

  return stdout
})

const consumerTsconfig = {
  compilerOptions: {
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["bun"],
  },
  include: ["main.ts", "cloud-api.ts"],
}

const cloudApiMain = `import assert from "node:assert/strict"
import { CloudApi, Environment, ProjectId, Role, LogLimit, UsageMeterName, UsagePricing } from "@rikalabs/akter-cli/cloud-api"
import { Schema } from "effect"

const project: ProjectId = Schema.decodeUnknownSync(ProjectId)("project-smoke")
assert.equal(project, "project-smoke")
assert.equal(CloudApi.groups.projects.endpoints.get.path, "/api/projects/:projectId")
assert.equal(Schema.decodeUnknownSync(Role)("viewer"), "viewer")
assert.throws(() => Schema.decodeUnknownSync(Role)("operator"))
assert.equal(Schema.decodeUnknownSync(LogLimit)(200), 200)
assert.throws(() => Schema.decodeUnknownSync(LogLimit)(201))

const database = { source: "customer", state: "reachable", latency: 7.25, latencyWarning: true, runnerCap: 13 }
const environment: Environment = Schema.decodeUnknownSync(Environment)({ name: "staging", projectId: project, currentDeploymentId: null, database })
assert.deepEqual(environment.database, database)
assert.throws(() => Schema.decodeUnknownSync(Environment)({ ...environment, database: { ...database, source: "managed" } }))
assert.equal(Schema.decodeUnknownSync(UsageMeterName)("runnerHours"), "runnerHours")
assert.throws(() => Schema.decodeUnknownSync(UsageMeterName)("storageGb"))
assert.deepEqual(Schema.decodeUnknownSync(UsagePricing)({ computeCentsPerUnitHour: 1.5 }), { computeCentsPerUnitHour: 1.5 })
assert.throws(() => Schema.decodeUnknownSync(UsagePricing, { onExcessProperty: "error" })({ computeCentsPerUnitHour: 1.5, storageCentsPerGbMonth: 50 }))

// @ts-expect-error Role is a finite union, not an arbitrary string.
const invalidRole: Role = "operator"
void invalidRole
console.log("cloud-api contract passed")
`

const consumerMain = (
  engine: "bun" | "node",
) => `import { ${engine === "bun" ? "BunCrypto" : "NodeCrypto"} as PlatformCrypto } from "@effect/platform-${engine}"
const cryptoLayer = PlatformCrypto.layer
import { Actor, User } from "@rikalabs/akter"
import { Actors, Database } from "@rikalabs/akter/runtime"
import { Effect, Layer, Schema } from "effect"

const Increment = Actor.command("Increment", { payload: Schema.Int, success: Schema.Int })

const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment },
})

const CounterLive = Counter.toLayer({
  Increment: Effect.fn(function* (amount) {
    const turn = yield* Counter.Turn
    yield* turn.state.set({ count: turn.state.count + amount })

    return turn.state.count
  }),
})

const live = CounterLive.pipe(
  Layer.provideMerge(Actors.layer({ authorize: () => Effect.succeed(true) })),
  Layer.provide(Database.pglite()),
  Layer.provide(cryptoLayer),
)

const program = Effect.gen(function* () {
  const counter = yield* Counter.get("smoke").pipe(
    Actor.tenant("smoke"),
    Actor.as(User.make({ subject: "smoke" })),
  )

  // @ts-expect-error Increment takes an integer.
  void counter.Increment("2")

  const first = yield* counter.Increment(2)
  const second = yield* counter.Increment(3)
  console.log(JSON.stringify([first, second]))
})

await Effect.runPromise(Effect.scoped(Layer.build(live).pipe(Effect.flatMap((context) => program.pipe(Effect.provide(context))))))
`

const cliMain = `import { Actor } from "@rikalabs/akter"
import { Actors, Auth } from "@rikalabs/akter/runtime"
import { Effect, Layer, Schema } from "effect"

const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })
const Counter = Actor.make("Counter", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  access: Actor.access.public,
  api: { Add },
})
const CounterLive = Counter.toLayer({
  Add: Effect.fn(function* (amount) {
    const turn = yield* Counter.Turn
    yield* turn.state.set({ count: turn.state.count + amount })
    return turn.state.count
  }),
})
export const app = Actors.serve({ actors: [Counter], auth: Auth.none }).pipe(
  Layer.provide(CounterLive.pipe(Layer.provideMerge(Actors.layer()))),
)
`

const cliSmoke = Effect.fn("cliSmoke")(function* ({
  engine,
  consumer,
  bin,
}: {
  readonly engine: "node" | "bun"
  readonly consumer: string
  readonly bin: string
}) {
  const help = yield* run([engine, bin, "--help"], consumer)
  if (!help.includes("Akter Cloud") || !help.includes("/_akter/inspector"))
    return yield* Effect.die(new Error("akter --help did not print the public command tree"))

  const loginHelp = yield* run(
    [engine, bin, "login", "--api-url", "http://127.0.0.1:9", "--help"],
    consumer,
  )
  if (!loginHelp.includes("--api-url"))
    return yield* Effect.die(new Error("akter login --help did not print --api-url"))

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(
    ChildProcess.make(engine, [bin, "dev", "--entry", "app.ts", "--port", "0"], {
      cwd: consumer,
      forceKillAfter: "5 seconds",
    }),
  )
  const printed = { stdout: "", stderr: "" }
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        printed.stdout += text
      }),
    ),
    Effect.forkScoped,
  )
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        printed.stderr += text
      }),
    ),
    Effect.forkScoped,
  )
  const origin = yield* Effect.gen(function* () {
    if (!(yield* child.isRunning))
      return yield* Effect.die(
        new Error(`akter dev exited before readiness: ${printed.stdout}\n${printed.stderr}`),
      )
    return Option.fromUndefinedOr(/^ {2}app +(http:\/\/\S+)$/m.exec(printed.stdout)?.[1])
  }).pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: Option.isSome }),
    Effect.timeout("60 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error("akter dev printed no origin")),
        onSome: Effect.succeed,
      }),
    ),
  )
  const client = yield* HttpClient.HttpClient
  yield* Effect.gen(function* () {
    const response = yield* client.get(`${origin}/ready`)
    const body = yield* HttpClientResponse.schemaBodyJson(Schema.Struct({ ready: Schema.Boolean }))(
      response,
    )
    if (response.status === 200 && body.ready) return true
    if (response.status !== 503 || body.ready)
      return yield* Effect.die(new Error("akter dev returned an invalid readiness response"))
    return false
  }).pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (ready) => ready }),
    Effect.timeout("60 seconds"),
  )
  for (const [amount, expected] of [
    [7, 7],
    [2, 9],
  ] as const) {
    const minted = yield* client.post(`${origin}/command-ids`)
    if (minted.status !== 200)
      return yield* Effect.die(new Error("akter dev could not mint a command id"))
    const { commandId } = yield* HttpClientResponse.schemaBodyJson(
      Schema.Struct({ commandId: Schema.String }),
    )(minted)
    const response = yield* client.execute(
      HttpClientRequest.post(`${origin}/actors/Counter/smoke/Add`).pipe(
        HttpClientRequest.setHeader("idempotency-key", commandId),
        HttpClientRequest.bodyJsonUnsafe(amount),
      ),
    )
    if (
      response.status !== 200 ||
      (yield* HttpClientResponse.schemaBodyJson(Schema.Int)(response)) !== expected
    )
      return yield* Effect.die(
        new Error(`akter dev counter increment ${amount} did not return ${expected}`),
      )
  }
  const inspector = yield* client.get(`${origin}/_akter/inspector`)
  if (
    inspector.status !== 200 ||
    !(yield* inspector.text).includes('data-api="/_akter/inspector/api"')
  )
    return yield* Effect.die(new Error("akter dev inspector page failed"))
  const script = yield* client.get(`${origin}/_akter/inspector/client.js`)
  if (script.status !== 200 || (yield* script.text).includes('from "effect"'))
    return yield* Effect.die(new Error("akter dev inspector asset is not bundled"))
  const legacy = yield* client.get(`${origin}/_durable/inspector`)
  if (legacy.status !== 404)
    return yield* Effect.die(new Error("the legacy inspector path still exists"))
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const engine = yield* Config.String("SMOKE_RUNTIME").pipe(Config.withDefault("bun"))

  if (engine !== "bun" && engine !== "node")
    return yield* Effect.die(new Error("SMOKE_RUNTIME must be bun or node"))
  const main = consumerMain(engine)
  const root = path.resolve(import.meta.dirname, "../../..")
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "akter-smoke-" })

  const given = args[packageIndex + 1]

  if (packageIndex !== -1 && (given === undefined || given === "" || given.startsWith("--")))
    return yield* Effect.die(new Error("--package needs a staged package directory"))

  const stage = packageIndex === -1 ? path.join(work, "package") : path.resolve(given ?? "")

  const cliGiven = args[cliPackageIndex + 1]
  if (
    cliPackageIndex !== -1 &&
    (cliGiven === undefined || cliGiven === "" || cliGiven.startsWith("--"))
  )
    return yield* Effect.die(new Error("--cli-package needs a staged CLI directory"))
  const cliStage = cliPackageIndex === -1 ? `${stage}-cli` : path.resolve(cliGiven ?? "")

  if (packageIndex === -1)
    yield* run(["bun", ".github/src/pack.ts", "--out", stage, "--cli-out", cliStage], root)

  const staged = yield* Schema.decodeEffect(StagedManifest)(
    yield* fs.readFileString(path.join(stage, "package.json")),
  )

  const workspace = yield* Schema.decodeEffect(WorkspaceManifest)(
    yield* fs.readFileString(path.join(root, "package.json")),
  )

  const catalog = workspace.workspaces?.catalog ?? {}

  const pinned = (name: string) => {
    const version = catalog[name] ?? workspace.devDependencies?.[name]

    if (version === undefined) throw new Error(`${name} has no pinned version in the root manifest`)

    return version
  }

  const tarballs = path.join(work, "tarballs")
  yield* fs.makeDirectory(tarballs, { recursive: true })

  const tarball = (yield* run(
    ["npm", "pack", "--ignore-scripts", "--pack-destination", tarballs, stage],
    root,
  ))
    .trim()
    .split("\n")
    .at(-1)

  if (tarball === undefined || tarball === "")
    return yield* Effect.die(new Error("npm pack printed no tarball"))

  const cliStaged = yield* Schema.decodeEffect(StagedManifest)(
    yield* fs.readFileString(path.join(cliStage, "package.json")),
  )
  if (cliStaged.version !== staged.version)
    return yield* Effect.die(new Error("CLI version does not match the framework"))
  const cliTarball = (yield* run(
    ["npm", "pack", "--ignore-scripts", "--pack-destination", tarballs, cliStage],
    root,
  ))
    .trim()
    .split("\n")
    .at(-1)
  if (cliTarball === undefined || cliTarball === "")
    return yield* Effect.die(new Error("npm pack printed no CLI tarball"))

  const consumer = path.join(work, "consumer")
  yield* fs.makeDirectory(consumer, { recursive: true })

  const consumerManifest = {
    name: "akter-smoke",
    private: true,
    type: "module",
    dependencies: {
      [staged.name]: `file:${path.join(tarballs, tarball)}`,
      [cliStaged.name]: `file:${path.join(tarballs, cliTarball)}`,
      ...Object.fromEntries(
        Object.entries(staged.peerDependencies ?? {}).filter(
          ([name]) => name !== "@effect/platform-bun" && name !== "@effect/platform-node",
        ),
      ),
      [`@effect/platform-${engine}`]: pinned(`@effect/platform-${engine}`),
      "@effect/platform-node-shared": pinned("@effect/platform-node-shared"),
    },
    overrides: {
      [staged.name]: `file:${path.join(tarballs, tarball)}`,
    },
    devDependencies: {
      "@types/bun": pinned("@types/bun"),
      typescript: pinned("typescript"),
    },
  }

  const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
  yield* fs.writeFileString(
    path.join(consumer, "package.json"),
    `${yield* encode(consumerManifest)}\n`,
  )
  yield* fs.writeFileString(
    path.join(consumer, "tsconfig.json"),
    `${yield* encode(consumerTsconfig)}\n`,
  )
  yield* fs.writeFileString(path.join(consumer, "main.ts"), main)
  yield* fs.writeFileString(path.join(consumer, "app.ts"), cliMain)
  yield* fs.writeFileString(path.join(consumer, "cloud-api.ts"), cloudApiMain)

  yield* run(["bun", "install", "--ignore-scripts"], consumer)

  const nested = path.join(consumer, "node_modules", staged.name, "node_modules", "effect")

  if (yield* fs.exists(nested))
    return yield* Effect.die(new Error(`${staged.name} installed a second copy of effect`))

  yield* run(["bunx", "--bun", "tsc", "-p", "tsconfig.json"], consumer)

  const contract = (yield* run([engine, "cloud-api.ts"], consumer)).trim()
  if (contract !== "cloud-api contract passed")
    return yield* Effect.die(new Error(`Cloud API contract import failed: ${contract}`))

  const output = (yield* run([engine, "main.ts"], consumer)).trim()

  if (output !== "[2,5]") return yield* Effect.die(new Error(`Expected [2,5], got ${output}`))

  yield* fs.writeFileString(
    path.join(consumer, "main.ts"),
    main.replace("Database.pglite()", 'Database.pglite({ dataDir: "./.data" })'),
  )
  const first = (yield* run([engine, "main.ts"], consumer)).trim()
  const restarted = (yield* run([engine, "main.ts"], consumer)).trim()

  if (first !== "[2,5]" || restarted !== "[7,10]")
    return yield* Effect.die(
      new Error(`Quickstart restart expected [2,5] then [7,10], got ${first} then ${restarted}`),
    )

  yield* fs.writeFileString(
    path.join(consumer, "test.ts"),
    `${main.slice(0, main.indexOf("const live ="))}
import assert from "node:assert/strict"
import { ActorTest } from "@rikalabs/akter/testing"
import { ManagedRuntime } from "effect"

const runtime = ManagedRuntime.make(CounterLive.pipe(
  Layer.provideMerge(ActorTest.layer()),
  Layer.provide(cryptoLayer),
))

try {
  await runtime.runPromise(Effect.gen(function* () {
    const test = yield* ActorTest
    const counter = yield* Counter.get("retry")
    const call = counter.Increment(2)
    assert.equal(yield* call, 2)
    assert.equal(yield* call, 2)
    yield* test.crashNext("beforeCommit")
    assert.equal(yield* counter.Increment(7), 9)
    yield* test.crashNext("afterCommit")
    const after = counter.Increment(3)
    assert.equal(yield* after, 12)
    assert.equal(yield* after, 12)
    const stored = yield* test.inspect(counter.ref)
    assert.deepEqual(stored.state, { count: 12 })
    assert.equal(stored.receipts, 3)
  }))
} finally {
  await runtime.dispose()
}
console.log("quickstart retry and rollback passed")
`,
  )
  yield* run([engine, "test.ts"], consumer)
  yield* cliSmoke({ engine, consumer, bin: path.join(consumer, "node_modules/.bin/akter") }).pipe(
    Effect.scoped,
  )

  yield* Console.log(
    `${staged.name}@${staged.version}: ${tarball} installs into a clean project, typechecks, and runs on ${engine}: memory ${output}, quickstart restart ${first} -> ${restarted}; ${cliStaged.name}@${cliStaged.version}: cloud-api types, import, endpoint and schema checks, help, offline login help, dev readiness, counter [7,9], inspector asset, and old-route refusal pass`,
  )
}).pipe(Effect.scoped)

Effect.gen(function* () {
  const services = yield* Layer.build(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))
  return yield* program.pipe(Effect.provideContext(services))
}).pipe(Effect.scoped, BunRuntime.runMain)
