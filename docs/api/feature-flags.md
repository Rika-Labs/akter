# Feature flags

`@akter/flags` is a private workspace package for the control plane. It has no vendor integration or framework runtime dependency. Declare one registry per application and build its Effect service:

```ts
import { Effect, Layer, Schema } from "effect"
import { flag, makeFlags, postgresStore } from "@akter/flags"

const definitions = {
  newConsole: flag(Schema.Boolean)(false),
  pageSize: flag(Schema.Finite)(25),
}
const { Flags, layer } = makeFlags(definitions)
const live = layer.pipe(Layer.provide(postgresStore))
```

Provide `live` with the application's `SqlClient` layer after applying `packages/postgres` migrations. The registry's keys and each flag's decoded type determine the service's evaluation return types. `memoryStore` replaces `postgresStore` for isolated tests.

`Flags.evaluate(key, target)` reads current overrides. `Flags.set(key, rule)` validates and atomically replaces the whole rule. `Flags.remove(key)` removes it, restoring the declared default. `Flags.snapshot(target)` reads one store snapshot and resolves every declared flag into `{ [key]: { value: encodedValue } }`, safe to serialize for that authenticated target. These operations return typed `UnknownFlag`, `InvalidOverride` or `StoreError` failures as applicable.

```ts
const program = Effect.gen(function* () {
  const flags = yield* Flags
  yield* flags.set("newConsole", {
    users: { "user-17": false },
    organizations: { "org-42": true },
    rollout: { percentage: 12.5, value: true },
    value: false,
  })
  return yield* flags.snapshot({ organizationId: "org-42", userId: "user-17" })
})
```

Target values are exact identifiers. User targeting wins over organization targeting; rollout wins over the global value. Rollout buckets use the user ID when present, otherwise the organization ID. A 0 percent rollout never matches, 100 percent always matches an identified caller, and anonymous callers use the global value or default. See the [contract](../contracts/feature-flags.md) for the stable hash and failure rules.

The console can import only the browser entry and its application-owned declarations:

```ts
import { evaluate, Snapshot } from "@akter/flags/browser"
import { Result, Schema } from "effect"

const received = Result.getOrThrow(Schema.decodeUnknownResult(Snapshot)(apiPayload))
const enabled = evaluate(definitions)("newConsole", {}, received)
```

The pure evaluator also accepts full rule snapshots in trusted contexts, using the same precedence and schemas as the service. Do not send raw store snapshots to the console: they contain other targets' identifiers and values. Unknown declaration names fail instead of inventing a default; obsolete override keys are ignored. The package supplies no HTTP route or console UI, so applications must authenticate snapshot delivery and authorize override management themselves.
