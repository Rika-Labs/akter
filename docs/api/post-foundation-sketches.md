# Post-foundation API sketches

**Responsibility:** show the intended developer experience for ADRs [0014](../decisions/0014-adoption-observation-and-client-reach.md) (adoption has shipped; see the [Drizzle guide](04-drizzle.md#adopting-an-existing-table)) and [0016](../decisions/0016-generated-durable-applications.md).

**Authority:** illustrative proposal only. These names and signatures are not exported and are subject to API/versioning review.

## Work offline

Shipped in M6.5: see [Offline queue](03-typescript-sdk.md#offline-queue-m65) and [ADR 0058](../decisions/0058-offline-command-queue.md).

## Version a workflow

<!-- snippet target -->

```ts
Ship: Effect.fn(function* (order) {
  const wf = yield* Order.Workflow
  if ((yield* wf.version("fraud-check")) >= 1) yield* Screen.run(order, fraud.screen)
  yield* AwaitPaid({ timeout: "1 day" })
})
// on the member: versions: { "fraud-check": { current: 1 } }
// export const Screen = Ship.step("fraud", { input: Order, success: Result })
// export const AwaitPaid = Ship.wait("paid", Paid)
```

[ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md) replaces the earlier `wf.version(name, n)` sketch. Markers are declared on `Actor.workflow`, and every marker's `current` value is recorded when an execution starts. `wf.version(name)` returns the recorded value, or 0 for executions that predate the marker, so in-flight executions keep their branch even before they reach it. `durable workflows check` and startup compare the manifest derived from the registered step constructors and `versions` with open executions and the manifests they started under, and refuse removed or renamed steps (reached or not) and markers outside `min..current`.

## Inspect and reproduce

`durable inspect Chat/room-42` and `durable export Chat/room-42 --output room-42.seed` shipped, with `test.actor(Chat, "room-42", { seed: "room-42.seed" })` ([server API](01-server-api.md)). The baseline export is current actor state plus pending intents and effects; arbitrary past-turn rewind, and so a `--turns` option, requires a separately costed history feature.

## Derive protocols

<!-- snippet target -->

```ts
Actor.serve({ actors: [ChatLive], auth: jwt(...), openapi: { path: "/openapi.json" }, mcp: { path: "/mcp" } })
// generated Python client: bun packages/python-client/src/main.ts <openapi.json> --out <dir>
```

MCP (shipped as `serve({ mcp })`, described in [generating clients](05-generated-clients.md#mcp)) exposes only public members. A durable tool invocation requires a stable caller-supplied `commandId`; a transport event ID with no guaranteed retry stability is insufficient. The Python client (see [generating clients](05-generated-clients.md#python)) follows the same runtime schemas and expiry semantics as the TypeScript client.

## Serve cold

<!-- snippet target -->

```ts
export default Actor.serve.handler({ actors: [ChatLive], database: Database.postgres({ url }) })
```

The handler is illustrative. A persistent edge must wake runners, recover due work, and terminate or reconnect sockets after gateway failure. Benchmark warm and cold turns separately.

## Generated apps

<!-- snippet target -->

```ts
const TodoList = Actor.make("TodoList", {
  key: TodoListId,
  tables: [todos],
  api: { Add, Toggle, List },
})
```

Generated `TodoList` source is validated in isolation and activated as a versioned build; no generated handler runs in the control-plane process.

The `Agent.definition` sketch for ADR 0015 was removed: the agent runtime is Outlast, a separate product ([ADR 0017](../decisions/0017-m1-record-corrections.md)).
