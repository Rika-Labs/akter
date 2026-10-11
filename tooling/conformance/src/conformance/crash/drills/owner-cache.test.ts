import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { conformanceGroups, registerConformance } from "../../../conformance.ts"
import { ownerCacheMultiXactConformance } from "../../pipeline.ts"
import { onBun } from "../../platform.ts"
import { postgresBackend } from "../../postgres/database.ts"
import { freshPrimary } from "./owner-cache.ts"

const runtime = ManagedRuntime.make(
  Layer.unwrap(
    Effect.promise(() =>
      onBun
        ? import("@effect/platform-bun/BunServices").then((platform) => platform.layer)
        : import("@effect/platform-node/NodeServices").then((platform) => platform.layer),
    ),
  ),
)

let scope: Scope.Closeable | undefined
let address: string | undefined

beforeAll(
  () =>
    runtime.runPromise(
      Effect.gen(function* () {
        scope = yield* Scope.make()
        address = yield* freshPrimary().pipe(Scope.provide(scope))
      }),
    ),
  120_000,
)

afterAll(() =>
  runtime
    .runPromise(scope === undefined ? Effect.void : Scope.close(scope, Exit.void))
    .then(() => runtime.dispose()),
)

registerConformance({
  name: "Postgres owner-cache MultiXact regression",
  backend: postgresBackend({
    url: Effect.suspend(() =>
      address === undefined
        ? Effect.die(new Error("The owner-cache probe server is not running"))
        : Effect.succeed(address),
    ),
  }),
  registrar: { describe, it, beforeAll, afterAll, expect, skip: (name) => it.skip(name) },
  selected: [{ suite: conformanceGroups.pipeline.suite, cases: [ownerCacheMultiXactConformance] }],
})
