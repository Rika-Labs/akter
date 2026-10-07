#!/usr/bin/env node
import { Context, Effect, Layer, Stdio } from "effect"
import { FetchHttpClient } from "effect/http"

import { run } from "./cli.ts"
import { PlatformRuntime, PlatformServices } from "./platform.ts"

Effect.gen(function* () {
  const services = yield* Layer.build(Layer.mergeAll(PlatformServices.layer, FetchHttpClient.layer))
  const args = yield* Context.get(services, Stdio.Stdio).args

  return yield* run(args).pipe(Effect.provideContext(services))
}).pipe(Effect.scoped, PlatformRuntime.runMain)
