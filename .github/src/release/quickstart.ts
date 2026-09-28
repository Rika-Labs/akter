import { BunServices } from "@effect/platform-bun"
import { SQL } from "bun"
import {
  Clock,
  Config,
  Console,
  Effect,
  FileSystem,
  ManagedRuntime,
  Option,
  Path,
  Random,
  Schema,
} from "effect"

const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), { space: 2 })

const Dependencies = Schema.Record(Schema.String, Schema.String)

type Environment = Readonly<Record<string, string | undefined>>

const run = Effect.fn("run")(function* (
  command: ReadonlyArray<string>,
  cwd: string,
  env: Environment = process.env,
) {
  const child = Bun.spawn([...command], { cwd, env, stdout: "pipe", stderr: "inherit" })
  const stdout = yield* Effect.promise(() => new Response(child.stdout).text())

  if ((yield* Effect.promise(() => child.exited)) !== 0)
    return yield* Effect.die(new Error(`${command.join(" ")} failed in ${cwd}:\n${stdout}`))

  return stdout
})

const lastLine = (output: string) => output.trim().split("\n").at(-1) ?? ""

/** What `bun start` prints on a first and second run against the same database. */
const expected = {
  counter: [["visits: 1"], ["visits: 2"]],
  chat: [["1 ada: hello"], ["1 ada: hello", "2 ada: hello"]],
} as const

/** A fresh database on the server `TEST_DATABASE_URL` names, dropped when the scope closes. */
const database = Effect.fn("database")(function* (base: string, name: string) {
  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new SQL(base)),
    (sql) => Effect.promise(() => sql.close()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.unsafe(`CREATE DATABASE ${name}`)),
    () =>
      Effect.tryPromise(() => admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).pipe(
        Effect.ignore,
      ),
  )
  const url = new URL(base)
  url.pathname = `/${name}`

  return url.toString()
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "../../..")
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "durable-actors-quickstart-" })
  const postgres = Option.getOrUndefined(yield* Config.option(Config.String("TEST_DATABASE_URL")))

  if (postgres === undefined && Option.isSome(yield* Config.option(Config.String("CI"))))
    return yield* Effect.die(new Error("TEST_DATABASE_URL is required in CI"))

  const tarballs = path.join(work, "tarballs")
  const stage = path.join(work, "core")
  yield* fs.makeDirectory(tarballs, { recursive: true })
  yield* run(["bun", ".github/src/pack.ts", "--out", stage], root)

  const core = path.join(
    tarballs,
    lastLine(
      yield* run(["npm", "pack", "--ignore-scripts", "--pack-destination", tarballs, stage], root),
    ),
  )

  const create = path.resolve(
    tarballs,
    lastLine(
      yield* run(
        ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballs],
        path.join(root, "packages/create"),
      ),
    ),
  )

  // A fresh install would take a newer `@effect/platform-node-shared` than the catalog's `effect`
  // supports, through `@effect/platform-bun`'s caret range; generated apps pin it the same way.
  const { workspaces } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ workspaces: Schema.Struct({ catalog: Dependencies }) }),
  )(yield* Schema.decodeEffect(Manifest)(yield* fs.readFileString(path.join(root, "package.json"))))

  const effect = workspaces.catalog["effect"]!

  // `bun create @durable-actors` runs the `@durable-actors/create` bin; install that bin from its tarball.
  const runner = path.join(work, "runner")
  yield* fs.makeDirectory(runner)
  yield* fs.writeFileString(
    path.join(runner, "package.json"),
    yield* Schema.encodeEffect(Manifest)({
      name: "runner",
      private: true,
      dependencies: { "@durable-actors/create": `file:${create}` },
      overrides: { "@effect/platform-node-shared": effect },
    }),
  )
  yield* run(["bun", "install", "--ignore-scripts"], runner)

  const bin = path.join(runner, "node_modules", ".bin", "create-durable-actors")

  for (const template of ["counter", "chat"] as const) {
    const app = path.join(work, `${template}-app`)
    yield* run(["bun", bin, app, "--template", template], work)

    const manifestPath = path.join(app, "package.json")
    const manifest = yield* Schema.decodeEffect(Manifest)(yield* fs.readFileString(manifestPath))
    const dependencies = yield* Schema.decodeUnknownEffect(Dependencies)(manifest.dependencies)
    yield* fs.writeFileString(
      manifestPath,
      yield* Schema.encodeEffect(Manifest)({
        ...manifest,
        dependencies: { ...dependencies, "@durable-actors/core": `file:${core}` },
      }),
    )

    yield* run(["bun", "install", "--ignore-scripts"], app)

    if (yield* fs.exists(path.join(app, "node_modules/@durable-actors/core/node_modules/effect")))
      return yield* Effect.die(new Error(`${template}: installed a second copy of effect`))

    yield* run(["bun", "run", "typecheck"], app)

    const backends: Array<readonly [string, Environment]> = [
      ["PGlite", { ...process.env, DATABASE_URL: undefined, DATA_DIR: undefined }],
    ]

    if (postgres !== undefined)
      backends.push([
        "Postgres",
        {
          ...process.env,
          DATABASE_URL: yield* database(
            postgres,
            `quickstart_${template}_${yield* Clock.currentTimeMillis}_${(yield* Random.nextIntBetween(0, 2 ** 31)).toString(36)}`,
          ),
        },
      ])

    for (const [backend, env] of backends) {
      yield* run(["bun", "test"], app, env)

      for (const lines of expected[template]) {
        const output = (yield* run(["bun", "start"], app, env)).trim().split("\n")

        if (output.join("\n") !== lines.join("\n"))
          return yield* Effect.die(
            new Error(
              `${template} on ${backend}: expected ${lines.join(" | ")}, got ${output.join(" | ")}`,
            ),
          )
      }

      yield* Console.log(
        `${template} on ${backend}: scaffolded, installed, typechecked, tested, and kept state across restarts`,
      )
    }

    yield* fs.remove(path.join(app, ".data"), { recursive: true })
  }
}).pipe(Effect.scoped)

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(program)
} finally {
  await runtime.dispose()
}
