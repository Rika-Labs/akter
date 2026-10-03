import { BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, FileSystem, ManagedRuntime, Path, Schema } from "effect"

const args = process.argv.slice(2)

const packageIndex = args.indexOf("--package")

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
  include: ["main.ts"],
}

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

  if (packageIndex === -1) yield* run(["bun", ".github/src/pack.ts", "--out", stage], root)

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

  const consumer = path.join(work, "consumer")
  yield* fs.makeDirectory(consumer, { recursive: true })

  const consumerManifest = {
    name: "akter-smoke",
    private: true,
    type: "module",
    dependencies: {
      [staged.name]: `file:${path.join(tarballs, tarball)}`,
      ...Object.fromEntries(
        Object.entries(staged.peerDependencies ?? {}).filter(
          ([name]) => name !== "@effect/platform-bun" && name !== "@effect/platform-node",
        ),
      ),
      [`@effect/platform-${engine}`]: pinned(`@effect/platform-${engine}`),
      "@effect/platform-node-shared": pinned("@effect/platform-node-shared"),
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

  yield* run(["bun", "install", "--ignore-scripts"], consumer)

  const nested = path.join(consumer, "node_modules", staged.name, "node_modules", "effect")

  if (yield* fs.exists(nested))
    return yield* Effect.die(new Error(`${staged.name} installed a second copy of effect`))

  yield* run(["bunx", "--bun", "tsc", "-p", "tsconfig.json"], consumer)

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

  yield* Console.log(
    `${staged.name}@${staged.version}: ${tarball} installs into a clean project, typechecks, and runs on ${engine}: memory ${output}, quickstart restart ${first} -> ${restarted}`,
  )
}).pipe(Effect.scoped)

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(program)
} finally {
  await runtime.dispose()
}
