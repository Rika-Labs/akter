import { Actor } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import { Context, Effect, Fiber, FileSystem, Layer, Schedule, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { UsageError } from "../../failure.ts"
import { runCli, startCli } from "../../testing.ts"
import { INSPECTOR_PATH, appOf, devRoutes } from "./run.ts"

const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

const Tally = Actor.make("Tally", {
  key: Schema.String,
  state: Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  access: () => true,
  api: { Add },
})

const TallyLive = Tally.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Tally.Turn
      yield* turn.state.set({ total: turn.state.total + amount })

      return turn.state.total
    }),
  }),
)

const runtime = TallyLive.pipe(
  Layer.provideMerge(ActorTest.layer()),
  Layer.provideMerge(BunCrypto.layer),
)

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const decodeMinted = Schema.decodeUnknownEffect(Schema.Struct({ commandId: Schema.String }))

describe("durable dev", () => {
  it(
    "runs the entry on PGlite in memory on loopback for the default tenant, and refuses bad options",
    () =>
      Effect.gen(function* () {
        const fs = Context.get(yield* Layer.build(BunFileSystem.layer), FileSystem.FileSystem)
        const cache = new URL("../../../.cache", import.meta.url).pathname
        yield* fs.makeDirectory(cache, { recursive: true })
        const directory = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: "dev-" })
        const entry = `${directory}/app.ts`
        yield* fs.writeFileString(
          entry,
          'import { Layer } from "effect"\nexport const app = Layer.empty\n',
        )

        const help = yield* runCli(["dev", "--help"])
        expect(help.stdout).toMatch(/--port integer +.*\(default 3000\)/)
        expect(help.stdout).toMatch(/--hostname string +.*\(default 127\.0\.0\.1\)/)
        expect(help.stdout).toMatch(/--tenant string +.*\(default default\)/)
        expect(help.stdout).toMatch(/--data-dir directory +.*\(default in memory\)/)

        const { printed, fiber } = yield* startCli(["dev", "--entry", entry, "--port", "0"])

        const origin = yield* Effect.suspend(() => {
          const found = /^ {2}app +(http:\/\/\S+)$/m.exec(printed.stdout)

          return found === null ? Effect.fail("not listening yet") : Effect.succeed(found[1]!)
        }).pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }))

        expect(printed.stdout.split("\n")[0]).toBe(`durable dev: ${entry} on PGlite (in memory)`)
        expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect(printed.stdout).toContain(`  inspector  ${origin}${INSPECTOR_PATH} (tenant default)`)

        yield* Fiber.interrupt(fiber)

        for (const [args, reason, message] of [
          [[], "MissingOption", "Missing required flag: --entry"],
          [["--entry"], "InvalidValue", "Missing value for flag --entry"],
          [["--entry", entry, "--json"], "UnrecognizedOption", "Unrecognized flag: --json"],
          [
            ["--entry", entry, "--port", "70000"],
            "InvalidValue",
            'Invalid value for flag --port: "70000"',
          ],
          [
            ["--entry", entry, "--port", "1.5"],
            "InvalidValue",
            'Invalid value for flag --port: "1.5"',
          ],
          [
            ["--entry", entry, "--database-url", "postgres://x", "--data-dir", directory],
            "UsageError",
            "--data-dir is for PGlite; drop it or --database-url",
          ],
        ] as const) {
          const refused = yield* runCli(["dev", ...args])

          expect(refused).toMatchObject({ exitCode: 2, reason })
          expect(refused.stderr).toContain(message)
        }
      }).pipe(Effect.scoped, Effect.runPromise),
    60_000,
  )

  it("requires the entry to export an app layer", () =>
    Effect.gen(function* () {
      const app = Layer.empty

      expect(yield* appOf({ module: { app }, entry: "app.ts" })).toBe(app)

      for (const module of [{}, { app: () => app }, { routes: app }])
        expect(yield* appOf({ module, entry: "app.ts" }).pipe(Effect.flip)).toEqual(
          UsageError.make({
            message: "app.ts must export `app`: a Layer of its routes that needs only the database",
          }),
        )
    }).pipe(Effect.runPromise))

  it("serves the app's commands and an inspector that reads only its tenant", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(runtime)

      const app = Actor.serve({ actors: [Tally], auth: Actor.auth.none }).pipe(
        Layer.provide(Layer.succeedContext(context)),
      )

      const web = HttpRouter.toWebHandler(
        devRoutes({ app, tenant: "default" }).pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const send = (path: string, init?: RequestInit) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            web.handler(new Request(`http://localhost${path}`, init)),
          )

          const body = yield* decodeJson(yield* Effect.promise(() => response.text()))

          return { status: response.status, body }
        })

      const { commandId } = yield* decodeMinted(
        (yield* send("/command-ids", { method: "POST" })).body,
      )

      const added = yield* send("/actors/Tally/t1/Add", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": commandId },
        body: "5",
      })

      expect(added).toEqual({ status: 200, body: 5 })

      yield* Effect.gen(function* () {
        yield* (yield* Tally.get("t2").pipe(Actor.tenant("elsewhere"))).Add(1)
      }).pipe(Effect.provideContext(context))

      const inspected = yield* send(`${INSPECTOR_PATH}/api/actor?type=Tally&id=t1`)
      expect(inspected.status).toBe(200)
      expect(inspected.body).toMatchObject({
        actor: { actorType: "Tally", actorId: "t1", generation: 1 },
        state: [{ key: "total", value: { json: 5 } }],
        receipts: [{ command: "Add", outcomeTag: "Success" }],
      })

      expect((yield* send(`${INSPECTOR_PATH}/api/actor?type=Tally&id=t2`)).status).toBe(404)
      expect((yield* send(`${INSPECTOR_PATH}/api/overview`)).body).toMatchObject({
        tenant: "default",
        counts: { actors: 1, receipts: 1 },
      })
    }).pipe(Effect.scoped, Effect.runPromise))
})
