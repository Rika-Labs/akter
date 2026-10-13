import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect"
import { Actor, user } from "@rikalabs/akter"
import { pageRunner, Library } from "../../../../../tooling/conformance/src/conformance/pages.ts"
import { fileSystemBucket } from "../../../../../packages/akter/src/store/file-system.ts"
import { runCliWith } from "../../testing.ts"
import { Engine } from "../../../../../packages/akter/src/execution/engine.ts"
import { Transports } from "../../../../../packages/akter/src/execution/transport.ts"
import { Store, storeOf } from "../../../../../packages/akter/src/store/service.ts"

const Numeric = Actor.make("Numeric", {
  key: Schema.Union([Schema.String, Schema.Int]),
  state: Schema.Struct({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  actions: { add: Actor.action(Schema.Int) },
})
const NumericLive = Numeric.toLayer({
  add: (state, value) => {
    state.total += value
  },
})

describe("akter fork", () => {
  it.live(
    "forks schema-encoded numeric ids without turning them into string ids",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-fork-key-" })
        const app = `${directory}/app.mjs`
        const source = `${directory}/source`
        const target = `${directory}/target`
        const quote = Schema.encodeResult(Schema.fromJsonString(Schema.String))
        const effect = Result.getOrThrow(
          quote(new URL("../../../../../node_modules/effect/dist/index.js", import.meta.url).href),
        )
        const root = Result.getOrThrow(
          quote(new URL("../../../../../packages/akter/src/index.ts", import.meta.url).href),
        )
        const server = Result.getOrThrow(
          quote(new URL("../../../../../packages/akter/src/server.ts", import.meta.url).href),
        )
        yield* fs.writeFileString(
          app,
          `import { Effect, Schema } from ${effect}; import { Actor } from ${root}; import { App } from ${server}; const Numeric = Actor.make("Numeric", {key:Schema.Union([Schema.String,Schema.Int]),state:Schema.Struct({total:Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0)))}),actions:{add:Actor.action(Schema.Int)}}); const live = Numeric.toLayer({add:(state,value)=>{state.total+=value}}); export default App.make({actors:[Numeric],layer:live}); export const authorizeOperator = () => Effect.succeed({operator:"operator:keys",capabilities:[{action:"fork",tenant:"default",actorId:17}]});`,
        )
        const context = yield* Layer.build(NumericLive)
        const catalog = {
          actors: new Map([
            [
              Numeric.name,
              { actor: Numeric, registered: Context.get(context, Numeric.implementation) },
            ],
          ]),
          shards: 1,
        }
        const options = {
          shards: 1,
          policy: "matching" as const,
          maxBatch: 64,
          checkpointEvery: 0,
          cronSkipIfOlderThan: 3_600_000,
          doubleRun: false,
          observer: undefined,
        }
        const store = yield* storeOf(yield* fileSystemBucket(source), {
          shards: 1,
          writer: "numeric-source",
        })
        const engine = yield* Engine.make(catalog, options).pipe(
          Effect.provideService(Store, store),
        )
        yield* engine.assign([0])
        yield* Transports.client(engine, user("keys")).call({
          actor: Numeric,
          id: 17,
          member: "add",
          payload: 31,
        })
        yield* Transports.client(engine, user("keys")).call({
          actor: Numeric,
          id: "17",
          member: "add",
          payload: 401,
        })
        expect((yield* engine.drain("10 seconds")).outcome).toBe("clean")
        const printed = yield* runCliWith({ env: { AKTER_OPERATOR_TOKEN: "fixture-only" } })([
          "fork",
          "Numeric",
          "17",
          "--app",
          app,
          "--directory",
          source,
          "--to-directory",
          target,
          "--at",
          "1",
          "--to",
          "29",
          "--json-ids",
        ])
        expect(printed.exitCode).toBe(0)
        const denied = yield* runCliWith({ env: { AKTER_OPERATOR_TOKEN: "fixture-only" } })([
          "fork",
          "Numeric",
          "17",
          "--app",
          app,
          "--directory",
          source,
          "--to-directory",
          target,
          "--at",
          "1",
          "--to",
          "outside",
        ])
        expect(denied.exitCode).toBe(1)
        expect(denied.reason).toBe("ForkRefused")
        expect(
          Result.getOrThrow(
            Schema.decodeResult(Schema.fromJsonString(Schema.Struct({ id: Schema.Int })))(
              printed.stdout.trim(),
            ),
          ).id,
        ).toBe(29)
        const copied = yield* storeOf(yield* fileSystemBucket(target), { writer: "numeric-reader" })
        const reopened = yield* Engine.make(catalog, options).pipe(
          Effect.provideService(Store, copied),
        )
        yield* reopened.assign([0])
        expect((yield* reopened.durableRecord(Numeric, 29)).image.state.total).toBe(31)
      }).pipe(Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    "forks retained history into a new directory through effect/cli and refuses unauthenticated or malformed positions without leaking the credential",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-fork-cli-" })
        const source = `${directory}/source`
        const target = `${directory}/target`
        const app = `${directory}/app.mjs`
        const effect = new URL("../../../../../node_modules/effect/dist/index.js", import.meta.url)
          .href
        const framework = new URL("../../../../../packages/akter/src/server.ts", import.meta.url)
          .href
        const fixture = new URL(
          "../../../../../tooling/conformance/src/conformance/pages.ts",
          import.meta.url,
        ).href
        const quote = Schema.encodeResult(Schema.fromJsonString(Schema.String))
        yield* fs.writeFileString(
          app,
          `import { Effect } from ${Result.getOrThrow(quote(effect))}; import { App } from ${Result.getOrThrow(quote(framework))}; import { Library, LibraryLive } from ${Result.getOrThrow(quote(fixture))}; export default App.make({actors:[Library],layer:LibraryLive}); export const authorizeOperator = token => token === "fixture-only" ? Effect.succeed({operator:"operator:cli",capabilities:[{action:"fork",tenant:"default"}]}) : Effect.fail(new Error(token));`,
        )
        const first = yield* pageRunner(yield* fileSystemBucket(source))
        yield* first.call("source", "fill", 90)
        expect((yield* first.engine.drain("10 seconds")).outcome).toBe("clean")
        const args = [
          "fork",
          "Library",
          "source",
          "--app",
          app,
          "--directory",
          source,
          "--to-directory",
          target,
          "--at",
          "1",
          "--to",
          "branch",
        ]
        const printed = yield* runCliWith({ env: { AKTER_OPERATOR_TOKEN: "fixture-only" } })(args)
        expect(printed.exitCode).toBe(0)
        const result = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
        )(printed.stdout.trim())
        expect(result.id).toBe("branch")
        expect(printed.stdout + printed.stderr).not.toContain("fixture-only")
        const restored = yield* pageRunner(yield* fileSystemBucket(target), { writer: "cli-read" })
        expect((yield* restored.engine.durableRecord(Library, "branch")).image.state.count).toBe(90)
        expect(yield* restored.range("branch", 35, 40, 2)).toEqual([
          { id: 55, at: 35, text: "55:" + "x".repeat(1100) },
          { id: 54, at: 36, text: "54:" + "x".repeat(1100) },
        ])
        const refused = yield* runCliWith({ env: { AKTER_OPERATOR_TOKEN: "invalid-fixture" } })(
          args,
        )
        expect(refused.exitCode).toBe(2)
        expect(refused.stdout + refused.stderr).not.toContain("invalid-fixture")
        const position = yield* runCliWith({ env: {} })([
          "fork",
          "Library",
          "source",
          "--directory",
          source,
          "--offset",
          "2",
        ])
        expect(position.exitCode).toBe(2)
        expect(position.reason).toBe("Position")
      }).pipe(Effect.provide(BunServices.layer)),
    30_000,
  )
})
