# Post-foundation API sketches

**Responsibility:** show the intended developer experience for ADRs [0014](../decisions/0014-adoption-observation-and-client-reach.md), [0015](../decisions/0015-durable-agent-runtime-boundary.md), and [0016](../decisions/0016-generated-durable-applications.md).

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
  if ((yield* wf.version("fraud-check", 1)) >= 1) {
    yield* Activity.make({ name: "fraud", success: Result, execute: fraud.screen(order) })
  }
  yield* wf.waitFor(Paid, { timeout: "1 day" })
})
```

`version` is a proposed durable step, not an existing `X.Workflow` method. New executions take the current version; in-flight executions retain the branch they recorded. A deploy check must compare declared step identities and retained executions, including activities not yet reached by a sleeping workflow.

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
Actor.serve({ actors: [ChatLive], auth: jwt(...) })
// planned OpenAPI; proposed MCP endpoint and generated Python client
```

MCP exposes only public members. A durable tool invocation requires a stable caller-supplied operation ID; a transport event ID with no guaranteed retry stability is insufficient. The Python client follows the same runtime schemas and expiry semantics as the TypeScript client.

## Serve cold

```ts
export default Actor.serve.handler({ actors: [ChatLive], database: Database.postgres({ url }) })
```

The handler is illustrative. A persistent edge must wake runners, recover due work, and terminate or reconnect sockets after gateway failure. Benchmark warm and cold turns separately.

## Agent runtime and generated apps

```ts
const Coder = Actor.make(
  "Coder",
  Agent.definition({
    model: Model.provider("model-id"),
    sandbox: Sandbox.provider(containerLayer),
    tools: { Shell, ReadFile },
    budget: { usd: 20 },
  }),
)

const TodoList = Actor.make("TodoList", {
  key: TodoListId,
  tables: [todos],
  api: { Add, Toggle, List },
})
```

`Agent.definition` is proposed composition into an ordinary actor, not a second actor constructor. Its budget is reserved in a turn before issuing model/tool effects, then settled or reconciled when a provider outcome is known; charging only after a model reply cannot prevent overspend. Sandboxes cannot write authoritative actor data. Generated `TodoList` source is validated in isolation and activated as a versioned build; no generated handler runs in the control-plane process.
