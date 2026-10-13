import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Akter, Auth, OperatorAuth, Store } from "@rikalabs/akter/server"
import { Context, Effect, Exit, Layer, Redacted, Schema, Scope } from "effect"
import { AuditRecord } from "../../../../packages/akter/src/store/audit.ts"
import { HttpServer } from "effect/http"
import { Client } from "../../../../packages/akter/src/contract/handle.ts"
import { user } from "@rikalabs/akter"
import { Engine } from "../../../../packages/akter/src/execution/engine.ts"
import { Transports } from "../../../../packages/akter/src/execution/transport.ts"
import { memoryBucket } from "../../../../packages/akter/src/store/memory.ts"
import { storeOf } from "../../../../packages/akter/src/store/service.ts"
import app, { Meter, MeterLive } from "../fixtures/operator-app.ts"
import { runCliWith } from "../testing.ts"

const allowed = ["inspect", "log.read", "snapshot.read", "replay"] as const
const fixture = Effect.gen(function* () {
  const bucket = memoryBucket()
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  yield* Scope.provide(scope)(
    Effect.gen(function* () {
      const store = yield* storeOf(bucket, {
        shards: 1,
        build: { bundle: "old", framework: "test" },
        writer: "old",
      })
      const context = yield* Layer.build(MeterLive)
      const engine = yield* Engine.make(
        {
          actors: new Map([
            [Meter.name, { actor: Meter, registered: Context.get(context, Meter.implementation) }],
          ]),
          shards: 1,
        },
        {
          shards: 1,
          policy: "matching",
          maxBatch: 64,
          checkpointEvery: 0,
          cronSkipIfOlderThan: 3_600_000,
          doubleRun: false,
          observer: undefined,
        },
      ).pipe(Effect.provideService(Store.Store, store))
      yield* engine.assign([0])
      yield* Effect.flatMap(Meter.client("one"), (meter) => meter.add(37)).pipe(
        Effect.provideService(Client, Transports.client(engine, user("application-user"))),
      )
    }),
  )
  yield* Scope.close(scope, Exit.void)
  const store = yield* storeOf(bucket, {
    shards: 1,
    build: { bundle: "new", framework: "test" },
    writer: "new",
  })
  const operatorAuth = OperatorAuth.tokens([
    {
      token: Redacted.make("test-operator"),
      grant: {
        operator: "cli",
        capabilities: allowed.map((action) => ({ action, tenant: "default" })),
      },
    },
    {
      token: Redacted.make("test-denied"),
      grant: {
        operator: "denied",
        capabilities: allowed.map((action) => ({ action, tenant: "wrong" })),
      },
    },
  ])
  const context = yield* Layer.build(
    Akter.serve({ app, auth: Auth.none, operatorAuth, port: 0, hostname: "127.0.0.1" }).pipe(
      Layer.provide(Layer.succeed(Store.Store, store)),
    ),
  )
  const address = Context.get(context, HttpServer.HttpServer).address
  const url = HttpServer.formatAddress(address)
  const call = (token: string, args: ReadonlyArray<string>, extra: Record<string, string> = {}) =>
    runCliWith({ env: { AKTER_OPERATOR_TOKEN: token, ...extra } })([...args, "--url", url])
  for (let n = 0; n < 100; n++) {
    const inspect = yield* call("test-operator", ["inspect", "shard", "0"])
    if (inspect.stdout.includes('"status":"refused"')) break
    yield* Effect.sleep("10 millis")
  }
  return { call, store, url }
})

layer(BunServices.layer, { excludeTestServices: true })(
  "audited operator CLI over real HTTP",
  (it) => {
    it.effect(
      "executes every command, defaults to build matching, emits NDJSON and refuses missing, application-only and out-of-scope credentials",
      () =>
        Effect.gen(function* () {
          const { call, store } = yield* fixture
          const matching = yield* call("test-operator", ["replay", "0"])
          expect(matching).toMatchObject({ exitCode: 1, reason: "OperatorRefused" })
          const replay = yield* call("test-operator", ["replay", "0", "--current"])
          expect(replay.exitCode).toBe(0)
          expect(
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(replay.stdout),
          ).toMatchObject({ replay: "current", shard: 0 })
          for (const args of [
            ["inspect", "actor", "CliMeter", "one"],
            ["inspect", "shard", "0"],
            ["log", "tail", "0"],
            ["log", "export", "0"],
            ["snapshot", "0"],
          ]) {
            const result = yield* call("test-operator", args)
            expect(result.exitCode).toBe(0)
            for (const line of result.stdout.trim().split("\n"))
              yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line)
            if (args[1] === "actor")
              expect(
                yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(result.stdout),
              ).toMatchObject({ state: { value: 37 }, outcomes: [{ outcome: "Success" }] })
          }
          for (const args of [
            ["inspect", "actor", "CliMeter", "one"],
            ["inspect", "shard", "0"],
            ["log", "tail", "0"],
            ["log", "export", "0"],
            ["snapshot", "0"],
            ["replay", "0", "--current"],
          ]) {
            expect(yield* call("test-denied", args)).toMatchObject({
              exitCode: 1,
              reason: "OperatorRefused",
              stdout: "",
            })
            expect(yield* call("", args, { AKTER_TOKEN: "test-operator" })).toMatchObject({
              exitCode: 2,
              reason: "OperatorRefused",
              stdout: "",
            })
            expect(yield* call("test-application", args)).toMatchObject({
              exitCode: 1,
              reason: "OperatorRefused",
              stdout: "",
            })
          }
          expect(
            yield* call("", ["inspect", "shard", "0", "--token-env", "EXPLICIT_OPERATOR"], {
              EXPLICIT_OPERATOR: "test-operator",
            }),
          ).toMatchObject({ exitCode: 0 })
          expect((yield* store.audits).filter((record) => record.outcome === "denied").length).toBe(
            6,
          )
          expect(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(AuditRecord)))(
              yield* store.audits,
            ),
          ).not.toContain("test-operator")
        }),
    )
  },
)
