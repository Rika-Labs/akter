import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { AkterClient } from "@rikalabs/akter/client"
import { Effect, Fiber, FileSystem, Layer, Option, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Meter } from "../fixtures/operator-app.ts"
import { startCliWith } from "../testing.ts"

layer(BunServices.layer, { excludeTestServices: true })("akter dev", (it) => {
  it.effect(
    "runs a filesystem-backed public app, exposes only stable metrics, and drains so the next invocation sees the durable state",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-dev-" })
        const entry = new URL("../fixtures/operator-app.ts", import.meta.url).pathname
        const start = () =>
          Effect.gen(function* () {
            const running = yield* startCliWith({ env: {} })([
              "dev",
              "--entry",
              entry,
              "--dir",
              directory,
              "--port",
              "0",
            ])
            for (let n = 0; n < 200; n++) {
              const url = running.printed.stdout.match(/Akter dev on (http:\/\/[^;]+);/u)?.[1]
              if (url !== undefined) return { ...running, url }
              const done = running.fiber.pollUnsafe()
              if (done !== undefined)
                return yield* Effect.die(`dev ended before serving: ${running.printed.stderr}`)
              yield* Effect.sleep("10 millis")
            }
            return yield* Effect.die("dev never served")
          })
        const first = yield* start()
        const client = yield* Layer.build(
          AkterClient.layer({ url: `${first.url}/rpc`, actors: [Meter] }),
        )
        yield* Effect.provideContext(
          Effect.flatMap(Meter.client("durable"), (meter) => meter.add(19)),
          client,
        )
        const http = yield* Layer.build(FetchHttpClient.layer)
        const metrics = yield* Effect.provideContext(
          HttpClient.get(`${first.url}/metrics`).pipe(Effect.flatMap((response) => response.text)),
          http,
        )
        expect(metrics).toContain("akter_actions")
        expect(
          (yield* Effect.provideContext(HttpClient.post(`${first.url}/operator`), http)).status,
        ).toBe(404)
        yield* Fiber.interrupt(first.fiber)
        const second = yield* start()
        const resumed = yield* Layer.build(
          AkterClient.layer({ url: `${second.url}/rpc`, actors: [Meter] }),
        )
        const state = yield* Effect.provideContext(
          Effect.flatMap(Meter.client("durable"), (meter) => Stream.runHead(meter.state)),
          resumed,
        )
        expect(Option.getOrThrow(state)).toEqual({ value: 19 })
        yield* Fiber.interrupt(second.fiber)
      }).pipe(Effect.scoped),
  )
})
