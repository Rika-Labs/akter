import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, FileSystem, ManagedRuntime, Schema } from "effect"
import { afterAll, expect, it } from "vitest"
import { runChecks } from "./verify.ts"

const runtime = ManagedRuntime.make(BunServices.layer)
const literal = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
afterAll(() => runtime.dispose())

it("starts both independent checks before either completes and passes each child its own replica environment", () =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-verify-" })
        const path = yield* literal(`${directory}/`)
        const script = (self: "node" | "bun", other: "node" | "bun") => `
    await Bun.write(${path} + "${self}", process.env.TEST_DATABASE_URL + ":" + process.env.TEST_REPLICA_DATABASE_URL);
    while (!(await Bun.file(${path} + "${other}").exists())) await Bun.sleep(10);
  `
        yield* runChecks([
          {
            command: ["bun", "-e", script("node", "bun")],
            env: { TEST_DATABASE_URL: "node-primary", TEST_REPLICA_DATABASE_URL: "node-replica" },
          },
          {
            command: ["bun", "-e", script("bun", "node")],
            env: { TEST_DATABASE_URL: "bun-primary", TEST_REPLICA_DATABASE_URL: "bun-replica" },
          },
        ]).pipe(Effect.timeout("5 seconds"))
        expect(yield* fs.readFileString(`${directory}/node`)).toBe("node-primary:node-replica")
        expect(yield* fs.readFileString(`${directory}/bun`)).toBe("bun-primary:bun-replica")
      }),
    ),
  ))

it("fails verification and terminates the sibling process instead of leaving it running", () =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-verify-failure-" })
        const started = yield* literal(`${directory}/started`)
        const stopped = yield* literal(`${directory}/stopped`)
        const descendant = yield* literal(
          `process.on("SIGTERM", () => { Bun.write(${stopped}, "terminated").then(() => process.exit(0)); }); await Bun.write(${started}, "ready"); while (true) await Bun.sleep(1000);`,
        )
        const exit = yield* runChecks([
          {
            command: [
              "bun",
              "-e",
              `while (!(await Bun.file(${started}).exists())) await Bun.sleep(10); process.exit(7);`,
            ],
          },
          {
            command: [
              "bun",
              "-e",
              `process.on("SIGTERM", () => process.exit(0)); const child = Bun.spawn(["bun", "-e", ${descendant}], { stdout: "inherit", stderr: "inherit" }); await child.exited;`,
            ],
          },
        ]).pipe(Effect.exit, Effect.timeout("10 seconds"))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* fs.readFileString(`${directory}/stopped`)).toBe("terminated")
      }),
    ),
  ))
