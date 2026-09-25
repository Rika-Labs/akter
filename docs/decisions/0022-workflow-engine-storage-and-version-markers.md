# ADR 0022: Workflow engine storage, runs, owner-event waits, and version markers

**Status:** proposed (2026-09-26). Accepting it is the gate for M2.7 (workflow engine) and M2.8 (workflow compatibility); no code implements it yet.

**Responsibility:** settle the details that [ADR 0012 §1](0012-workflows-internals-effects-defects-merging-regions.md#1-workflows-run-on-our-own-engine-on-the-owner-actors-shard) left open for the framework `WorkflowEngine`, and the version markers and deploy check that [ADR 0014 item 4](0014-adoption-observation-and-client-reach.md#decision) requires before workflows ship.

**Authority:** decision record. Once accepted, it amends [contract 03](../contracts/03-transactions.md), [contract 05](../contracts/05-messaging.md), [contract 08](../contracts/08-background-work.md), [retention](../operations/retention.md), the [server API](../api/01-server-api.md), the [context API](../api/02-context.md), the [conformance ledger](../verification/01-conformance.md), and the [failure matrix](../verification/02-failure-matrix.md).

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when these semantics change.

## Context

ADR 0012 chose our own implementation of Effect's `WorkflowEngine` (`effect/unstable/workflow`, `effect@4.0.0-rc.116`) over `ClusterWorkflowEngine`. Workflow state lives on the owner actor's shard, durable clocks are outbox timers, and `waitFor` matches owner events. It sketched one table and left these open:

- the final table schema and indexes for migration `0011_workflows`;
- how the execution id is encoded, and how long finished executions are kept;
- what `WorkflowRun` offers on handles, and what `later.Ship(input)` returns inside a turn;
- how `waitFor` closes the start-to-wait race, including an event committed by the turn that starts the workflow;
- the shape of `wf.version` and where the marker is stored;
- the deploy compatibility check (`durable workflows check` and a startup refusal);
- the shared suite that runs against our engine and `ClusterWorkflowEngine`.

Three facts from the shipped code shape the answers:

- Every framework row leads with `routing_key` and carries `(tenant_id, actor_type, actor_id)` with a foreign key to `actor_generations` (`0003_routing_state`, `0004_outbox`, `0006_events`, `0008_effects`). ADR 0012's sketch has no `actor_type` and no foreign key.
- The relay delivers an outbox row as a direct command whose command id is the row id. Internal delivery skips the external authorization and expiry checks, because the sending turn already admitted the work.
- Event sequence numbers are reserved on the locked `actor_generations` row (`FOR UPDATE` in the turn fence). Anything else that takes a lock on that row serializes with event appends.

In Effect's engine, activities, clocks and deferreds are named steps. `DurableClock.sleep` below 60 s runs as an activity named `DurableClock/<name>`, and longer sleeps use `scheduleClock` plus a deferred named `DurableClock/<name>`. `Activity.retry` gives each attempt its own number, and `ClusterWorkflowEngine` keys each activity result by name and attempt. A step name that repeats within one execution returns the recorded result.

## Decisions

Each decision gives the recommended default. Items marked **Behaviour change** alter a statement in an existing contract, ADR, or API doc; the [list at the end](#behaviour-changes-against-existing-contracts) collects them.

### 1. Two tables: executions and steps (`0011_workflows`)

```sql
CREATE TABLE actor_workflow_executions (
  routing_key    bigint  NOT NULL,
  execution_id   text    NOT NULL,           -- the encoded id from decision 2
  bucket         integer NOT NULL CHECK (bucket = routing_key >> 56),
  tenant_id      text    NOT NULL,
  actor_type     text    NOT NULL,
  actor_id       text    NOT NULL,
  workflow       text    NOT NULL,           -- the Actor.workflow tag
  workflow_key   text    NOT NULL,           -- decision 2
  payload        bytea   NOT NULL,           -- schema-encoded input, compressed like state
  caller         text    NOT NULL,           -- encoded System caller: source "workflow", owner ref, onBehalfOf
  event_cursor   bigint  NOT NULL,           -- decision 5: owner events after this are visible to waits
  status         text    NOT NULL CHECK (status IN ('running', 'suspended', 'finished')),
  interrupt      boolean NOT NULL DEFAULT false,
  result         bytea,                      -- schema-encoded Exit once finished
  started_at_ms  bigint  NOT NULL,
  finished_at_ms bigint,
  PRIMARY KEY (routing_key, execution_id),
  FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations,
  CHECK ((status = 'finished') = (result IS NOT NULL AND finished_at_ms IS NOT NULL))
);
-- An owner's open executions, read on wake and by the event-append wait lookup.
CREATE INDEX actor_workflow_executions_open
  ON actor_workflow_executions (routing_key, tenant_id, actor_type, actor_id)
  WHERE status <> 'finished';
-- Retention probes finished executions per relay bucket, like the outbox's due index.
CREATE INDEX actor_workflow_executions_finished
  ON actor_workflow_executions (bucket, finished_at_ms)
  WHERE status = 'finished';
-- The deploy check reads open executions by actor type and workflow.
CREATE INDEX actor_workflow_executions_check
  ON actor_workflow_executions (actor_type, workflow)
  WHERE status <> 'finished';

CREATE TABLE actor_workflow_step (
  routing_key    bigint  NOT NULL,
  execution_id   text    NOT NULL,
  step           text    NOT NULL,           -- activity, clock, wait, or version marker name
  attempt        integer NOT NULL,           -- the activity attempt; 0 for every other kind
  kind           text    NOT NULL CHECK (kind IN ('activity', 'clock', 'wait', 'version')),
  exit           bytea,                      -- schema-encoded Exit; NULL while pending
  wait_event     text,                       -- the event tag a wait matches
  wait_after     bigint,                     -- the wait sees owner events after this sequence
  matched        bigint,                     -- the event sequence that resolved the wait
  version        integer,                    -- the recorded marker value
  started_at_ms  bigint  NOT NULL,
  settled_at_ms  bigint,
  PRIMARY KEY (routing_key, execution_id, step, attempt),
  FOREIGN KEY (routing_key, execution_id) REFERENCES actor_workflow_executions ON DELETE CASCADE,
  CHECK ((kind = 'wait') = (wait_event IS NOT NULL AND wait_after IS NOT NULL)),
  CHECK ((kind = 'version') = (version IS NOT NULL AND exit IS NULL))
);
-- Pending waits for one event tag, joined to the owner's open executions.
CREATE INDEX actor_workflow_step_waits
  ON actor_workflow_step (routing_key, wait_event)
  WHERE kind = 'wait' AND exit IS NULL;

-- The last accepted step and marker manifest per workflow (decision 7).
CREATE TABLE actor_workflow_manifests (
  actor_type     text   NOT NULL,
  workflow       text   NOT NULL,
  manifest_hash  text   NOT NULL,
  manifest       jsonb  NOT NULL,           -- { steps: [...], versions: { name: { current, min } } }
  recorded_at_ms bigint NOT NULL,
  PRIMARY KEY (actor_type, workflow)
);
```

- **Pending rows.** A step row is written before its work starts, with `exit` NULL: an activity attempt before it runs (as an effect attempt is), a clock when it is scheduled, and a wait when it registers. Settling a step is `UPDATE … SET exit = … WHERE exit IS NULL`, so exactly one writer settles it. A second writer reads the recorded exit and uses that.
- **Steps are deleted when the execution finishes.** The transaction that records `result` and `status = 'finished'` deletes the execution's step rows. A finished execution never replays, and `poll` reads only `result`. Open executions are therefore the only ones that hold step rows, which keeps the table and the deploy check proportional to in-flight work.
- **Start anchor in the intent.** A `later.Ship` intent carries the start anchor from decision 5 in its payload, so the start turn can record `event_cursor` without knowing which turn staged it.
- **Everything is on the owner's shard.** Both tables lead with the owner's `routing_key`, and the foreign key ties each execution to the owner's generation row. No workflow row is ever written under another actor's key.
- **Fenced writes.** Every engine write outside a turn (a step, a status change, a result) carries a guard such as `AND EXISTS (SELECT 1 FROM actor_generations WHERE … AND generation = $g)`, where `$g` is the generation the activation acquired. A runner that lost the actor writes nothing, and its fiber stops when the guard matches no row. This extends the turn fence to engine transactions.

**Behaviour change:** this replaces ADR 0012's single `actor_workflow_step` sketch (`exit NOT NULL`, primary key `(routing_key, execution_id, step)`) with two tables, pending rows, an `attempt` column, and the owner columns and foreign key every other framework table has.

### 2. Execution identity and its encoding

The execution id handed to Effect's engine API and shown on `WorkflowRun` is:

```text
w1.<base64url(JSON.stringify([tenant, actorType, actorId, workflow, key]))>
```

- `key` is the execution key. `Actor.workflow` uses the same `input`, `output`, and `errors` fields as `Actor.command`. By default it is the start's command id: the intent id for `later.Ship(input)`, and the handle's command id for `order.Ship(input)`. A handle retry keeps its command id, so it attaches to the same execution. `Actor.workflow(tag, { key })` overrides this with a function of the input, and then a second start with the same key attaches to the existing execution without comparing payloads, as Effect's `Workflow.execute` does.
- The encoded id is capped at 1,024 bytes, and `key` at 256 UTF-8 bytes. Longer keys fail the start with `InvalidExecutionKey`.
- The deployment is not encoded. Each deployment (and each region of a hosted deployment) has its own database, so a row's deployment is its database, as it already is for `routing_key`, receipts and outbox rows. A `WorkflowRun` id presented to another deployment finds nothing.

```ts
export const Ship = Actor.workflow("Ship", {
  input: { orderId: OrderId, address: Address },
  output: Label,
  errors: [ShippingFailed],
  key: ({ orderId }) => orderId, // optional; defaults to the start's command id
  steps: ["label", "cool-off", "Paid", "fraud"], // decision 7
  versions: { "fraud-check": { current: 1 } }, // decision 6
})
```

**Behaviour change:** ADR 0012, [contract 08](../contracts/08-background-work.md), and the [data model](../architecture/data-model.md) list the deployment inside the execution identity. It is still part of the identity, but through the storage boundary rather than the encoded string, so an execution id is unique only within its deployment.

### 3. Starting a workflow, and `later.Ship(input)` inside turns

A start is always an owner turn. It inserts the execution row, its version markers, and a keyed outbox timer `wf:<execution id>` due now. The timer resumes the execution, as described under decision 4.

- **Inside a turn**, `later.Ship(input)` stages an ordinary outbox intent to the owner, with the reserved internal command `$workflow/start`. It commits with the turn and is delivered after commit, like any intent. It returns the execution id, so the turn can store it (for example, to interrupt the execution later):

  ```ts
  PlaceOrder: Effect.fn(function* (order) {
    const turn = yield* Order.Turn
    const later = yield* Order.intents(turn.id)
    yield* turn.emit(new Paid({ orderId: order.id })) // visible to the workflow's waitFor
    const executionId = yield* later.Ship({ orderId: order.id, address: order.address })
    yield* turn.state.set({ shipment: executionId })
  })
  ```

- **Outside a turn**, `order.Ship(input)` is a direct command to the owner that runs the start turn. It returns a `WorkflowRun` once that turn commits.
- The start turn's `ON CONFLICT (routing_key, execution_id) DO NOTHING` makes a repeated start attach to the existing execution. The start receipt deduplicates redelivery of the start intent.
- An intent staged by a turn that rolls back never starts an execution, as with any intent.

**Behaviour change:** [server API](../api/01-server-api.md) intents return `Effect<void, never, Actor.InTurn>`. A workflow intent returns `Effect<string, never, Actor.InTurn>`, which is the execution id.

### 4. The run loop: where the fiber runs, and how it recovers

- **Resumes arrive as internal commands.** The engine's `execute` and `resume` run the workflow fiber in the owner's activation, forked into its scope. Every resume, whether a clock, a wait timeout, a matched event, an interrupt, or recovery, arrives as the reserved internal command `$workflow/resume` with the execution id as its input and System caller `{ source: "workflow", ref: owner }`. The relay delivers it like any keyed timer. Reserved `$workflow/…` commands can't be declared by applications, and a non-System caller reaching one is a deterministic defect, like any internal command.
- **Recovery uses the keyed timer `wf:<execution id>`.** While the fiber runs, this timer is re-armed to `now + 30 s`. When it fires and the fiber is live in this activation, the engine only re-arms it. When the fiber is not live, because the runner died or the shard moved, the engine replays the execution from its recorded steps. No separate heartbeat or scan is needed; the relay's due-work scan (ADR 0006) already covers the timer. When the execution suspends on a clock or a timed wait, the timer is replaced with that due time. An untimed wait deletes it, and the matched event re-arms it (decision 5). Finishing the execution deletes it.
- **An activation with a live workflow fiber does not hibernate.** `hibernateAfter` counts only idle activations with no live fibers. A suspended execution holds no fiber.
- **Activities are at least once, as in Effect.** The pending step row for `(name, attempt)` is written before the activity runs. A crash leaves the row pending, and the replay re-runs that attempt under the same attempt number.
- **Actor calls from workflows are trusted internal work.** Handle calls are allowed only inside an activity; anywhere else in a body they die with `Actor call outside an activity`, because a call from the body would run again on every replay. A call made inside an activity:
  - carries the execution's recorded caller, System `{ source: "workflow", ref: owner, onBehalfOf }`;
  - skips the external authorization and expiry checks, like relay delivery (contract 08: accepted work continues after the principal loses access), while applications may still reauthorize on `onBehalfOf`;
  - uses a derived command id `v1.<started>.<started + retryWindow>.<uuid>`, where `started` is the attempt's recorded `started_at_ms` and `uuid` is a v4-shaped digest of `(execution id, step, attempt, n)`, and `n` counts the attempt's calls in issue order. A re-run attempt therefore repeats the same ids, and the receiver's receipts deduplicate them. Calls that run concurrently inside one activity get the same ids only if they are issued in the same order every time; the API docs recommend sequential calls, or one call per activity.
- **Workflow bodies have no intents.** A body runs outside any transaction, so `X.intents(id)` is unavailable there (`Actor.InTurn` is never provided to a body). A body that must message another actor durably calls a handle inside an activity.
- **An attempt older than the retry window is not re-run.** Replay finds a pending attempt whose `started_at_ms` is older than the deployment's retry window. The receiver's receipts for its derived ids may already be pruned, so the engine settles the attempt as the typed failure `ActivityOutcomeUnknown` instead of running it again. `Activity.retry` then decides whether to run a new attempt, which has new ids and is a new operation. This is the one place our engine deliberately differs from `ClusterWorkflowEngine`, which re-runs indefinitely. The shared suite (decision 8) records it as an expected divergence.

**Behaviour change:** the [context API](../api/02-context.md) says request/reply handles are available in workflow bodies and that workflow bodies may call `X.intents(id)`. Handles are now available only inside an activity, and bodies cannot call `X.intents`. [Contract 01](../contracts/01-actor-authority.md)'s "workflow bodies access actors through workflow handles" is narrowed the same way.

**Behaviour change:** [contract 08](../contracts/08-background-work.md) says command identity "derives from execution ID and activity name and remains stable across retries". The derivation now also includes the attempt number and call ordinal. An attempt interrupted longer ago than the retry window surfaces `ActivityOutcomeUnknown` instead of being re-run.

### 5. Owner-event `waitFor` and the start-to-wait race

```ts
const paid =
  yield *
  wf.waitFor(Paid, {
    where: (event) => event.orderId === order.id,
    timeout: "1 day",
    name: "Paid", // optional; defaults to the event tag
  }) // Option<Paid>; Option.none() after the timeout
```

**What a wait sees.** Each execution has an event cursor:

- The cursor starts at the start anchor. For a workflow started by `later.Ship` in its owner's own turn, the anchor is the owner's `event_sequence` before that turn's emits, so events the starting turn emits (before or after `later.Ship`) are visible. For any other start, the anchor is the owner's `event_sequence` when the start turn commits.
- The cursor is then the larger of the start anchor and the sequence of every wait the execution has already resolved.
- A wait resolves with the lowest-sequence owner event after the cursor at its registration (`wait_after`) that has the wait's event tag and satisfies `where`. `where` must be a pure function of the event; it runs in the workflow fiber, never in a turn.

So an event committed between the start and the registration resolves the wait. Two waits for `Paid` in sequence resolve with the first and the second `Paid`, and a wait never sees events from before a wait it follows. The first wait for a name in an execution is its step. Waiting again under a name the execution has already used is a deterministic defect of that execution (`Duplicate workflow step`), so a second wait for the same tag needs `name`.

**How the race closes:**

1. **Registration** is one engine transaction. It takes `actor_generations … FOR SHARE` on the owner (with the generation guard) and scans `actor_events` for a match after `wait_after`. When it finds one, it inserts the step already settled. Otherwise it inserts a pending wait row with `wait_event` and, for a timed wait, the keyed timer `wf:<execution id>/<step>`.
2. **A turn that emits events** already holds `FOR UPDATE` on the same row. In the same transaction it looks up the owner's pending waits for the emitted tags (the `actor_workflow_step_waits` index joined to the owner's open executions) and re-arms `wf:<execution id>` due now for each one. The lookup is folded into the event-append statement as a CTE, so it adds no round trip, and it only runs for actor types whose declared workflow `steps` include a wait (decision 7).
3. The two locks conflict, so either the turn commits first and the registration scan sees the event, or the registration commits first and the turn sees the pending row. In neither order can an event be missed.
4. **The resumed fiber** re-scans after `wait_after` in a fenced transaction. When an event matches, it settles the step with the `Some` exit and `matched`, and deletes the timeout timer. When the tag matched but `where` did not, the wait stays pending, and nothing else changes.
5. **The timeout timer** settles the step with `None` through the same `WHERE exit IS NULL` update. When both race, whichever commits first wins, and the other finds the step settled and uses the recorded exit.

**Behaviour change:** [contract 05](../contracts/05-messaging.md) requires only that `waitFor` observe owner events and close the race. It now states that a wait sees owner events from the execution's cursor, not from registration, so a wait can resolve on an event committed before the wait was reached. Waits also become part of the turn transaction (a resume timer written with the turn's events), which amends [contract 03](../contracts/03-transactions.md).

### 6. `wf.version(name)` and version markers

Markers are declared on the workflow and recorded when the execution starts:

```ts
export const Ship = Actor.workflow("Ship", {
  // …
  versions: { "fraud-check": { current: 2, min: 1 } }, // min defaults to 0
})

Ship: Effect.fn(function* (order) {
  const wf = yield* Order.Workflow
  const fraud = yield* wf.version("fraud-check") // 0 | 1 | 2, as recorded at start
  if (fraud === 1)
    yield* Activity.make({ name: "fraud", success: Result, execute: screenV1(order) })
  if (fraud >= 2)
    yield* Activity.make({ name: "fraud-v2", success: Result, execute: screenV2(order) })
  yield* wf.waitFor(Paid, { timeout: "1 day" })
})
```

- The start turn writes one `version` step row per declared marker, holding that marker's `current`. `wf.version(name)` returns the recorded value, or 0 when the execution started before the marker existed. The name must be a declared key; any other string is a type error.
- The value is fixed for the whole execution. An old execution that has not yet reached the code point still takes its old branch. This is deterministic and needs no knowledge of the replay position, but the old branch must stay in the source until no open execution recorded it. The deploy check enforces that.
- **Retiring a branch.** Raise `min` once no open execution recorded a lower value; the check refuses the deploy until then. Remove the marker declaration only when no open execution recorded it at all.
- **Rolling deploys.** A runner resuming an execution that recorded a marker value above its own `current`, or a step name its code does not declare, does not run it. It suspends the execution, logs a `WorkflowIncompatible` defect span, and re-arms the recovery timer, so a newer runner picks it up. It never fails the execution.

**Behaviour change:** the [post-foundation sketch](../api/post-foundation-sketches.md) shows `wf.version(name, n)` recorded lazily when first reached. Markers are now declared on `Actor.workflow`, recorded at start, and read with `wf.version(name)`.

### 7. Declared steps and the deploy compatibility check

`Actor.workflow` declares `steps`: every activity, clock, and wait name the body can use. Effect's primitives stay unchanged (ADR 0012), so the list is checked at runtime. A step name that is not declared suspends the execution with a `WorkflowIncompatible` defect span, as in decision 6. `ActorTest` runs the same engine, so tests catch a missing name.

The check is one function with two callers. It reads open executions only (finished ones hold no steps) and refuses when:

1. an open execution belongs to an actor type or workflow member the code no longer declares;
2. an open execution recorded a step name the workflow no longer declares (a removed or renamed step);
3. an open execution recorded a marker value below `min` or above `current`, or a marker that is no longer declared;
4. `min` is above 0 while an open execution predates the marker (it has no row for it).

- **`durable workflows check`** in `apps/cli`, which is the CLI's first real command:

  ```text
  $ durable workflows check --entry ./src/actors.ts --database-url "$DATABASE_URL"
  Order/Ship  step "label" removed    412 open executions (oldest 2026-09-20T08:14Z)
  Order/Ship  fraud-check min 2 > 1    37 open executions
  2 incompatibilities; deploy refused (exit 1)
  ```

  `--entry` names a module that exports the application's `actors` array. The command opens a read-only transaction and prints each blocking group with its count and oldest start. It exits 1 on any incompatibility and 0 otherwise. `--json` gives machine output for CI.

- **Startup refusal.** `Actors.layer` runs the same check after migrations and before it registers entities. It refuses to start, as a placement mismatch does. To keep startup cost off the common path, `actor_workflow_manifests` (decision 1) records the last accepted manifest (steps and markers). The full check runs only when the deployed manifest differs from the recorded one, and a passing check records the new manifest. A rollback's manifest also differs, so the check catches a rollback that would strand executions on newer markers.

**Behaviour change:** none against a contract. This makes ADR 0014 item 4 concrete and adds the `steps` field to `Actor.workflow`.

### 8. `WorkflowRun` on handles

```ts
const order = yield * Order.get(orderId)
const run = yield * order.Ship({ orderId, address }) // WorkflowRun<Label, ShippingFailed>
run.executionId // "w1.…"
const status = yield * run.poll // Option<Workflow.Result<Label, ShippingFailed>>
const label = yield * run.result // waits; fails ShippingFailed | ActorError
yield * run.interrupt // idempotent

const again = yield * Order.run(Ship, executionId) // reattach from a stored id
```

- **`poll`** returns Effect's own `Workflow.Result`: `Option.none()` when the execution is unknown or pruned, `Suspended` while it is open, and `Complete(exit)` when it is finished. It is admitted like a query on the owner: the caller's tenant and authorization apply, it never activates the actor, and a revoked caller gets `Unauthorized` (contract 08: revocation blocks result reads).
- **`result`** polls with a backoff from 50 ms to 1 s until the result is `Complete`, then returns its exit. `None` fails `WorkflowNotFound`, and an interrupted execution fails with the interrupt cause. The caller's `Timeout` stops only the waiting.
- **`interrupt`** is a receipted command turn on the owner through the reserved `$workflow/interrupt` command, with its own command id. It is retry-safe and admitted like a public command. It sets `interrupt = true` and re-arms `wf:<execution id>` due now. The resumed fiber interrupts, runs Effect's compensation finalizers, and records the interrupt exit. Interrupting a finished execution succeeds and changes nothing. When interruption races completion, whichever terminal write commits first is the result.
- **`Order.run(member, executionId)`** decodes the id and checks that its actor type and workflow match the member. A mismatch fails `InvalidExecutionId`. It returns a typed `WorkflowRun` without contacting the owner.

**Behaviour change:** none. This makes the [glossary](../GLOSSARY.md)'s `WorkflowRun` concrete.

### 9. Retention of finished executions

- `policy.keepWorkflows` (default `"7 days"`) keeps a finished execution's row, and therefore its `poll` result, for that long after `finished_at_ms`. At startup it must be at least the deployment's retry window, so a retried start whose key is the command id can never re-create a pruned execution. The M1.9 retention loop deletes expired rows per bucket through `actor_workflow_executions_finished`.
- After pruning, a start with an explicit `key` creates a new execution; this is documented. `poll` on a pruned id returns `Option.none()`.
- **Events pinned by open executions.** Event pruning (`keepEvents`) must not delete an owner event whose sequence is above the smallest `event_cursor` among that owner's open executions whose workflow declares a wait. A long-open waiting workflow therefore holds its owner's events. `durable-actors.workflow.pinned_events` reports how many events are held.

**Behaviour change:** [retention](../operations/retention.md) required that event retention "cover every … workflow `waitFor` dependency" without saying how. This ADR makes the bound concrete, which is new behaviour for M1.9's event pruning.

### 10. The shared engine suite

`packages/durable-actors/src/testing/conformance/workflows.ts` exports `describeWorkflowEngine(name, layer)`. It runs once with our engine on PGlite and Postgres, and once with `ClusterWorkflowEngine.layer` over Cluster's in-memory message storage and test runner. Only these cases run on both engines, and their results must match:

| Case                                            | Asserts                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `replays a recorded activity without rerunning` | an activity's side-effect counter stays 1 across a resume                               |
| `records each Activity.retry attempt`           | attempts 1..n each record an exit; replay returns the final one                         |
| `resumes a durable clock after engine restart`  | tear down and rebuild the engine layer mid-sleep; the body continues after the due time |
| `resolves a deferred done before it is awaited` | `DurableDeferred.done` before `await` returns the recorded exit                         |
| `interrupts a suspended execution`              | compensation finalizers run once; `poll` returns `Complete` with an interrupt cause     |
| `interrupts a running execution`                | as above, while an activity runs                                                        |
| `polls unknown, suspended, and complete`        | `None`, `Suspended`, then `Complete(exit)`                                              |
| `attaches a repeated execute to one execution`  | two `execute` calls with one id run the body once and return the same result            |
| `discards an execute`                           | `discard: true` returns the id and the body still completes                             |

Expected divergence: our engine settles a pending attempt older than the retry window as `ActivityOutcomeUnknown` (decision 4). The suite asserts that on our engine only.

## Behaviour changes against existing contracts

| Changed text                                                                      | Change                                                                                                                                                 | Decision |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| ADR 0012 §1 `actor_workflow_step` sketch                                          | Two tables, pending rows (`exit` nullable), `attempt`, owner columns, foreign key, steps deleted on finish                                             | 1        |
| ADR 0012 §1, contract 08, data model: execution identity includes deployment      | The deployment is the database, not an encoded component; ids are unique per deployment                                                                | 2        |
| Server API: intents return `Effect<void>`                                         | Workflow intents return the execution id                                                                                                               | 3        |
| Contract 08: identity "derives from execution ID and activity name"               | Derived from execution id, step, attempt, and call ordinal; issued-at is the attempt's recorded start; stale attempts surface `ActivityOutcomeUnknown` | 4        |
| Context API and contract 01: workflow bodies use handles and may call `X.intents` | Handles only inside activities; no `X.intents` in bodies                                                                                               | 4        |
| Contract 05: `waitFor` closes the registration race                               | A wait sees owner events after the execution's cursor, not after registration                                                                          | 5        |
| Contract 03: the turn transaction's contents                                      | An event-emitting turn also re-arms resume timers for matching pending waits                                                                           | 5        |
| Post-foundation sketch: `wf.version(name, n)`                                     | Declared `versions`, recorded at start, read with `wf.version(name)`                                                                                   | 6        |
| Retention: event pruning covers `waitFor` dependencies                            | Pruning stops at the smallest open waiting execution's cursor                                                                                          | 9        |

## Alternatives

| Question            | Rejected options                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage             | One step table with the execution folded in as a special step: `poll`, retention and the deploy check would all filter on it. Keeping finished steps: the table grows with history nobody replays.                                                                          |
| Execution id        | Effect's default hash of tag and idempotency key: it can't be routed to an owner without a lookup table. Encoding the deployment: no deployment id exists, and the database already is the boundary.                                                                        |
| Default key         | Hashing the payload: two intentional starts with equal input would merge silently.                                                                                                                                                                                          |
| Recovery            | A startup scan for running executions: it grows with the whole deployment and misses runners that die later. A heartbeat column: a write per running execution per interval, plus a scanner.                                                                                |
| Wait visibility     | From registration only: that is the race. Evaluating `where` inside the emitting turn: `where` is workflow code with no turn capability, and it would slow every emit. `LISTEN/NOTIFY`: ruled out by ADR 0006, and not durable.                                             |
| Version markers     | Lazy recording on first reach (Temporal's `getVersion`): the engine can't tell a replay from first reach when steps run concurrently. Source order as the version: rejected by ADR 0014.                                                                                    |
| Step manifest       | Inferring steps by running the body: unreached steps are invisible. Recording observed names only: a renamed step nobody has reached since the deploy passes the check. Typed step constructors replacing `Activity.make`: breaks ADR 0012's "Effect primitives unchanged". |
| Old pending attempt | Re-running it with its old ids: the receiver's receipts may be pruned, which risks a second execution. Minting new ids silently: ADR 0014 forbids replacing ids without the application's say.                                                                              |

## Consequences and evidence

M2.7 builds decisions 1–5 and 8–10 in a two-PR stack (engine and storage; then `waitFor`, tenant and attribution resume). M2.8 builds decisions 6 and 7. `0011_workflows` also creates `actor_workflow_manifests`, so M2.8 needs no migration of its own. Neither starts until this ADR is accepted.

Conformance cases M2.7 must add, in `conformance/workflows.ts`, on PGlite and Postgres (crash, contention and multi-runner cases on Postgres and the M2.1 harness):

- the shared suite in decision 10;
- `writes every workflow row under the owner's routing key` (**Workflow engine**: no state off the owner's shard);
- `separates equal keys across tenants and owners`, `restores tenant and onBehalfOf on resume elsewhere`, and `continues with recorded attribution after the starting caller loses access` (gate **Workflow tenant isolation**, W1, H2);
- `resolves an event emitted by the starting turn`, `resolves an event committed between start and registration`, `resolves an event racing registration on Postgres`, and `resolves two sequential waits with two events` (gate **`waitFor` registration**, W2);
- `settles a wait exactly once when its event and timeout race`;
- `resumes after runner kill during an activity` and `does not rerun an activity whose exit was recorded` (harness);
- `rejects step writes from a stale generation`;
- `settles a pending attempt older than the retry window as ActivityOutcomeUnknown`;
- `dies on an actor call outside an activity` and `deduplicates a rerun activity's actor calls by derived command id`;
- `returns the execution id from later.Ship and attaches repeated starts`;
- `interrupts once when interrupt races completion`;
- `deletes steps on finish and prunes finished executions after keepWorkflows`;
- `keeps events above an open wait's cursor from pruning`.

Conformance cases M2.8 must add, in `conformance/workflow-versions.ts`:

- `records markers at start and reads 0 for executions older than the marker`;
- `refuses startup when a recorded step is removed or renamed`, `… when a marker leaves min..current`, and `… when a workflow member is removed`;
- `skips the full check when the manifest is unchanged`;
- `suspends an execution a runner cannot run and resumes it on a newer runner` (harness, rolling deploy);
- `durable workflows check exits 1 with the blocking groups and 0 when compatible`;
- the ledger's **Workflow compatibility** check across a restart with an old execution sleeping.

New failure-matrix rows: "Runner dies during a workflow activity", "Workflow step write from a stale generation", "Wait timeout races the matching event", "Interrupt races workflow completion", "Pending activity attempt older than the retry window", "Runner lacks a step or marker an execution recorded", "Deploy removes a step an open execution recorded", and "Event pruning reaches an open wait's cursor". The existing rows "Workflow resumes elsewhere" and "Event races workflow wait registration" stay as they are.

Benchmark: M2.7 adds the `workflow` scenario, which measures activity step overhead (statements and milliseconds per recorded activity), resume latency after a runner kill, and sleep lateness against the due time. The emit-path wait lookup must leave the T2 statement baseline unchanged for actor types without waits.

## Open questions for Dallen

Each has a recommended default that this ADR already uses; the PR asks for a decision on each.

1. **`steps` list duplication.** The recommended default is a declared `steps` array checked at runtime. The alternative is typed constructors (`Ship.activity("label", …)`) that drop the list but wrap Effect's `Activity.make`.
2. **Stale-attempt behaviour.** The recommended default settles a pending attempt older than the retry window as `ActivityOutcomeUnknown`. The alternative keeps receipts for open attempts' derived ids until the attempt settles, which needs a join in receipt pruning.
3. **Default `keepWorkflows`.** Seven days is recommended.
4. **Recovery interval.** 30 s is recommended. It bounds resume latency after a runner dies mid-activity and costs one relay delivery per running execution per interval.

## Revisit when

- Upstream Effect changes `WorkflowEngine`'s encoded interface or activity attempt semantics.
- The recovery timer's relay traffic shows up in the `workflow` benchmark at the M2 scale run.
- Applications need child workflows started from a body (`Workflow.execute` inside a workflow), which this ADR leaves unsupported: a body that starts another workflow does so from an activity, through a handle.
