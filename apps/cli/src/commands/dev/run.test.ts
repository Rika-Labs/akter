import { Actor, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Effect, Exit, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { INSPECTOR_PATH, appOf, devRoutes, parseDev } from "./run.ts"

const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

const Tally = Actor.make("Tally", {
  key: Schema.String,
  state: Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
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
  Layer.provideMerge(ActorTest.layer({ as: User.make({ subject: "alice" }) })),
  Layer.provideMerge(BunCrypto.layer),
)

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const decodeMinted = Schema.decodeUnknownEffect(Schema.Struct({ commandId: Schema.String }))

describe("durable dev", () => {
  it("parses its options with PGlite in memory, port 3000, loopback, and the default tenant", () =>
    Effect.gen(function* () {
      expect(yield* parseDev(["--entry", "app.ts"])).toEqual({
        entry: "app.ts",
        databaseUrl: undefined,
        dataDir: undefined,
        port: 3000,
        hostname: "127.0.0.1",
        tenant: "default",
      })
      expect(
        yield* parseDev([
          "--entry",
          "app.ts",
          "--database-url",
          "postgres://localhost/app",
          "--port",
          "0",
          "--hostname",
          "0.0.0.0",
          "--tenant",
          "acme",
        ]),
      ).toEqual({
        entry: "app.ts",
        databaseUrl: "postgres://localhost/app",
        dataDir: undefined,
        port: 0,
        hostname: "0.0.0.0",
        tenant: "acme",
      })

      for (const [args, message] of [
        [[], "--entry is required"],
        [["--entry"], "--entry needs a value"],
        [["--entry", "a.ts", "--json"], "Unknown argument: --json"],
        [["--entry", "a.ts", "--port", "70000"], "--port must be an integer 0-65535"],
        [["--entry", "a.ts", "--port", "1.5"], "--port must be an integer 0-65535"],
        [
          ["--entry", "a.ts", "--database-url", "postgres://x", "--data-dir", "d"],
          "--data-dir is for PGlite; drop it or --database-url",
        ],
      ] as const)
        expect(yield* parseDev(args).pipe(Effect.flip)).toMatchObject({ message })
    }).pipe(Effect.runPromise))

  it("requires the entry to export an app layer", () =>
    Effect.gen(function* () {
      const app = Layer.empty

      expect(yield* appOf({ module: { app }, entry: "app.ts" })).toBe(app)

      for (const module of [{}, { app: () => app }, { routes: app }])
        expect(Exit.isFailure(yield* appOf({ module, entry: "app.ts" }).pipe(Effect.exit))).toBe(
          true,
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
