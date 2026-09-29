# Post-foundation API sketches

**Responsibility:** show the intended developer experience for ADRs [0014](../decisions/0014-adoption-observation-and-client-reach.md) and [0016](../decisions/0016-generated-durable-applications.md).

**Authority:** illustrative proposal only. These names and signatures are not exported and are subject to API/versioning review.

## Adopt a legacy table

```ts
const InvoiceRows = Actor.table(existingInvoices, {
  owner: { tenant: existingInvoices.orgId, actor: existingInvoices.accountId },
})
const Account = Actor.make("Account", {
  key: AccountId,
  tables: [InvoiceRows],
  api: { IssueInvoice, VoidInvoice },
})
```

Existing columns must be mapped and validated without relying on TypeScript for authority. A proposed CLI first reports legacy direct writers, then enforces actor-scoped writes with database privileges or a guard that cannot be forged by application connections. `routing_key` backfills and tenant isolation require a real Postgres/Neki migration plan.

## Observe an actor-local query

```ts
const room = Chat.client({ baseUrl }).get("room-42")
for await (const page of room.Recent.watch({ limit: 50 })) render(page)
```

`watch` is only defined for supported scoped queries. The runtime must capture dependencies and notify subscribers after commit, then rerun at a consistent version. A rerun may coalesce intermediate states; it is not an event history. Group queries need explicit cost controls and fleet queries are not live by default.

## Work offline

```ts
const client = Chat.client({
  baseUrl,
  offline: Offline.indexedDb("chat"),
})
const pending = client.get("room-42").SendMessage({ body: "On a plane" })
// pending represents queued, committed, failed, or expired—not a Promise that must stay open offline.
```

The persisted queue stores the original command ID and expiry metadata, then replays in order per actor. `CommandExpired` requires explicit application resolution; replacing the ID is a new operation. Optimistic UI applies only where a reducer is declared.

## Version a workflow

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

```text
durable inspect Chat/room-42 --turns 5
durable export Chat/room-42 --output room-42.seed
```

```ts
const room = yield * test.actor(Chat, "room-42", { seed: "room-42.seed" })
```

These are operator-authorized operations with explicit redaction and retention. The baseline export is current actor state plus relevant durable obligations and metadata; arbitrary past-turn rewind requires a separately costed history feature.

## Derive protocols

```ts
Actor.serve({ actors: [ChatLive], auth: jwt(...), openapi: { path: "/openapi.json" }, mcp: { path: "/mcp" } })
// generated Python client: bun packages/python-client/src/main.ts <openapi.json> --out <dir>
```

MCP (shipped as `serve({ mcp })`, described in [generating clients](05-generated-clients.md#mcp)) exposes only public members. A durable tool invocation requires a stable caller-supplied `commandId`; a transport event ID with no guaranteed retry stability is insufficient. The Python client (see [generating clients](05-generated-clients.md#python)) follows the same runtime schemas and expiry semantics as the TypeScript client.

## Serve cold

```ts
export default Actor.serve.handler({ actors: [ChatLive], database: Database.postgres({ url }) })
```

The handler is illustrative. A persistent edge must wake runners, recover due work, and terminate or reconnect sockets after gateway failure. Benchmark warm and cold turns separately.

## Generated apps

```ts
const TodoList = Actor.make("TodoList", {
  key: TodoListId,
  tables: [todos],
  api: { Add, Toggle, List },
})
```

Generated `TodoList` source is validated in isolation and activated as a versioned build; no generated handler runs in the control-plane process.

The `Agent.definition` sketch for ADR 0015 was removed: the agent runtime is Outlast, a separate product ([ADR 0017](../decisions/0017-m1-record-corrections.md)).
