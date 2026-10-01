#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer, Stdio } from "effect"
import { FetchHttpClient } from "effect/http"

import { run } from "./cli.ts"

Effect.gen(function* () {
  const services = yield* Layer.build(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))
  const args = yield* Context.get(services, Stdio.Stdio).args

  return yield* run(args).pipe(Effect.provideContext(services))
}).pipe(Effect.scoped, BunRuntime.runMain)
