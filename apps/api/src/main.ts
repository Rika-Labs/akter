import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { loadOptions } from "./config.ts"
import { ApiLive } from "./server.ts"
import { TelemetryLive } from "./telemetry.ts"

BunRuntime.runMain(
  Effect.gen(function* () {
    const options = yield* loadOptions
    return yield* Layer.launch(ApiLive(options).pipe(Layer.provide(TelemetryLive)))
  }),
)
