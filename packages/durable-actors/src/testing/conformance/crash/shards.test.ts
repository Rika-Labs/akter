import { BunCrypto } from "@effect/platform-bun"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Actors, Database } from "../../../runtime/index.ts"
import { Echo, EchoLive, lateFirstRefresh } from "./shards.ts"

describe("shard locks on a starting runner with Postgres", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it("keeps a shard acquired while its first lock refresh is in flight", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
        const name = `shards_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

        const admin = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: database.href })),
          (pool) => Effect.promise(() => pool.end()),
        )

        yield* Effect.acquireRelease(
          Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
          () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
        )
        database.pathname = `/${name}`

        const { layer: wiring, refreshed, released } = yield* lateFirstRefresh

        const services = yield* Layer.build(
          EchoLive.pipe(
            Layer.provideMerge(
              Actors.layer({ authorize: () => Effect.succeed(true) }).pipe(Layer.provide(wiring)),
            ),
            Layer.provideMerge(Database.postgres({ url: Redacted.make(database.href) })),
          ),
        )

        const reply = yield* Effect.gen(function* () {
          const echo = yield* Echo.get("one")

          return yield* echo.Ping("pong")
        }).pipe(Effect.provideContext(services))

        expect({ reply, first: refreshed[0], released }).toEqual({
          reply: "pong",
          first: [],
          released: [],
        })
      }).pipe(Effect.scoped),
    ))
})
