import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Path, Schema } from "effect"

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

const consumerMain = `import { BunCrypto } from "@effect/platform-bun"
import { Actor, User } from "@durable-actors/core"
import { Actors, Database } from "@durable-actors/core/runtime"
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
  Layer.provide(BunCrypto.layer),
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
  const root = path.resolve(import.meta.dirname, "../../..")
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "durable-actors-smoke-" })

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
    name: "durable-actors-smoke",
    private: true,
    type: "module",
    dependencies: {
      [staged.name]: `file:${path.join(tarballs, tarball)}`,
      ...staged.peerDependencies,
      "@effect/platform-bun": pinned("@effect/platform-bun"),
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
  yield* fs.writeFileString(path.join(consumer, "main.ts"), consumerMain)

  yield* run(["bun", "install", "--ignore-scripts"], consumer)

  const nested = path.join(consumer, "node_modules", staged.name, "node_modules", "effect")

  if (yield* fs.exists(nested))
    return yield* Effect.die(new Error(`${staged.name} installed a second copy of effect`))

  yield* run(["bunx", "--bun", "tsc", "-p", "tsconfig.json"], consumer)

  const output = (yield* run(["bun", "main.ts"], consumer)).trim()

  if (output !== "[2,5]") return yield* Effect.die(new Error(`Expected [2,5], got ${output}`))

  yield* Console.log(
    `${staged.name}@${staged.version}: ${tarball} installs into a clean project, typechecks, and ran a command on PGlite (${output})`,
  )
}).pipe(Effect.scoped)

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(program)
} finally {
  await runtime.dispose()
}
