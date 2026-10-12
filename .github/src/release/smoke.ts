import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, FileSystem, Layer, Path, Schema } from "effect"

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

const environment: Environment = Schema.decodeUnknownSync(Environment)({ name: "staging", projectId: project, currentDeploymentId: null })
assert.deepEqual(environment, { name: "staging", projectId: project, currentDeploymentId: null })
assert.throws(() => Schema.decodeUnknownSync(Environment, { onExcessProperty: "error" })({ ...environment, database: { source: "customer" } }))
assert.equal(Schema.decodeUnknownSync(UsageMeterName)("runnerHours"), "runnerHours")
assert.throws(() => Schema.decodeUnknownSync(UsageMeterName)("storageGb"))
assert.deepEqual(Schema.decodeUnknownSync(UsagePricing)({ computeCentsPerUnitHour: 1.5 }), { computeCentsPerUnitHour: 1.5 })
assert.throws(() => Schema.decodeUnknownSync(UsagePricing, { onExcessProperty: "error" })({ computeCentsPerUnitHour: 1.5, storageCentsPerGbMonth: 50 }))

// @ts-expect-error Role is a finite union, not an arbitrary string.
const invalidRole: Role = "operator"
void invalidRole
console.log("cloud-api contract passed")
`

const consumerMain = `import assert from "node:assert/strict"
import { Actor, ActorError, InvalidInput, User } from "@rikalabs/akter"
import { ASSERTION_HEADER, requestDigest, Store } from "@rikalabs/akter/server"
import { Simulation } from "@rikalabs/akter/testing"
import { Effect, Schema } from "effect"

const caller = Schema.decodeUnknownSync(User)({ _tag: "User", subject: "smoke" })
assert.equal(caller.subject, "smoke")
assert.throws(() => Schema.decodeUnknownSync(User)({ _tag: "User", subject: "" }))
assert.equal(ASSERTION_HEADER, "durable-assertion")

const failure = ActorError.make({ reason: InvalidInput.make({ code: "decode" }) })
assert.equal(failure.reason._tag, "InvalidInput")

const digest = (body: string) =>
  Effect.runPromise(
    requestDigest({ method: "POST", target: "/rpc", idempotencyKey: undefined, body: new TextEncoder().encode(body) }),
  )
const [first, again, other] = await Promise.all([digest("a"), digest("a"), digest("b")])
assert.match(first, /^[0-9a-f]{64}$/)
assert.equal(first, again)
assert.notEqual(first, other)
assert.equal(typeof Store.memory, "function")

const Counter = Actor.make("Counter", {
  state: Schema.Struct({ n: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  actions: { bump: Actor.action({ success: Schema.Finite }) },
})
const counted = await Simulation.run(
  { actors: [Counter], seed: 1 },
  Effect.gen(function* () {
    const counter = yield* Counter.client("c")
    assert.equal(yield* counter.bump(), 1)
    yield* Simulation.settle
    return (yield* Simulation.state(Counter, "c")).n
  }).pipe(Effect.scoped),
  Counter.toLayer({
    bump: (counter) => {
      counter.n += 1
      return counter.n
    },
  }),
)
assert.equal(counted, 1)
console.log("root, server and testing entries passed")
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
  if (!help.includes("Akter Cloud"))
    return yield* Effect.die(new Error("akter --help did not print the public command tree"))

  const loginHelp = yield* run(
    [engine, bin, "login", "--api-url", "http://127.0.0.1:9", "--help"],
    consumer,
  )
  if (!loginHelp.includes("--api-url"))
    return yield* Effect.die(new Error("akter login --help did not print --api-url"))
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const engine = yield* Config.String("SMOKE_RUNTIME").pipe(Config.withDefault("bun"))

  if (engine !== "bun" && engine !== "node")
    return yield* Effect.die(new Error("SMOKE_RUNTIME must be bun or node"))
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
  yield* fs.writeFileString(path.join(consumer, "main.ts"), consumerMain)
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

  if (output !== "root, server and testing entries passed")
    return yield* Effect.die(new Error(`Entry check failed: ${output}`))

  yield* cliSmoke({ engine, consumer, bin: path.join(consumer, "node_modules/.bin/akter") }).pipe(
    Effect.scoped,
  )

  yield* Console.log(
    `${staged.name}@${staged.version}: ${tarball} installs into a clean project, typechecks, and its root, server and testing entries run on ${engine}; ${cliStaged.name}@${cliStaged.version}: cloud-api types, import, endpoint and schema checks, help and offline login help pass`,
  )
}).pipe(Effect.scoped)

Effect.gen(function* () {
  const services = yield* Layer.build(BunServices.layer)
  return yield* program.pipe(Effect.provideContext(services))
}).pipe(Effect.scoped, BunRuntime.runMain)
