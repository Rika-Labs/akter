# ADR 0022: Workflow engine storage, runs, owner-event waits, and version markers

**Status:** accepted (2026-09-26, Dallen). It gates M2.7 (workflow engine) and M2.8 (workflow compatibility); no code implements it yet. Dallen chose typed step constructors for question 1; question 2 was delegated to Floppy, who took the default; questions 3–5 take their defaults ([decided questions](#decided-questions)).

**Responsibility:** settle the details that [ADR 0012 §1](0012-workflows-internals-effects-defects-merging-regions.md#1-workflows-run-on-our-own-engine-on-the-owner-actors-shard) left open for the framework `WorkflowEngine`, and the version markers and deploy check that [ADR 0014 item 4](0014-adoption-observation-and-client-reach.md#decision) requires before workflows ship.

**Authority:** decision record. It amends contracts [01](../contracts/01-actor-authority.md), [03](../contracts/03-transactions.md), [04](../contracts/04-receipts.md), [05](../contracts/05-messaging.md) and [08](../contracts/08-background-work.md); [retention](../operations/retention.md); the [server API](../api/01-server-api.md), [context API](../api/02-context.md) and [post-foundation sketches](../api/post-foundation-sketches.md); the [data model](../architecture/data-model.md) and [transaction catalog](../architecture/transaction-catalog.md); the [glossary](../GLOSSARY.md); and the conformance ledger, [failure matrix](../verification/02-failure-matrix.md), [invariants](../verification/invariants.md) and [performance](../../BENCHMARKS.md) requirements.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when these semantics change.

## Context

ADR 0012 chose our own implementation of Effect's `WorkflowEngine` (`effect/unstable/workflow`, `effect@4.0.0-rc.116`) over `ClusterWorkflowEngine`. Workflow state lives on the owner actor's shard, durable clocks are outbox timers, and `waitFor` matches owner events. It sketched one table and left these open:

- the final table schema and indexes for migration `0012_workflows`;
- how the execution id is encoded, and how long finished executions are kept;
- what `WorkflowRun` offers on handles, and what `later.Ship(input)` returns inside a turn;
- how `waitFor` closes the start-to-wait race, including an event committed by the turn that starts the workflow;
- the shape of `wf.version` and where the marker is stored;
- the deploy compatibility check (`durable workflows check` and a startup refusal);
- the shared suite that runs against our engine and `ClusterWorkflowEngine`.

These facts from the shipped code and from Effect shape the answers:

- Every framework row leads with `routing_key` and carries `(tenant_id, actor_type, actor_id)` with a foreign key to `actor_generations` (`0003_routing_state`, `0004_outbox`, `0006_events`, `0008_effects`). With the default `placement: "tenant"`, `routing_key` is per tenant, not per actor. ADR 0012's sketch has no `actor_type` and no foreign key.
- The relay delivers an outbox row as a direct command whose command id is the row id. Internal delivery skips the external authorization and expiry checks, because the sending turn already admitted the work. A receipt's `expires_at_ms` comes from its command id.
- Event sequence numbers are reserved on the locked `actor_generations` row (`FOR UPDATE` in the turn fence). Anything else that locks that row serializes with event appends.
- In Effect, activities, clocks and deferreds are named steps. `DurableClock.sleep` at or below 60 s runs as an activity named `DurableClock/<name>`; a longer sleep calls `scheduleClock` (again on every replay) and awaits a deferred named `DurableClock/<name>`. `DurableDeferred.raceAll` records a deferred named `raceAll/<name>`. `Activity.retry` gives each attempt its own number.
- `Workflow.execute` and `Workflow.poll` compute the execution id themselves, as a hash of the tag and `idempotencyKey(payload)`, before calling the engine. A hash can't be routed to an owner.
- `WorkflowEngine.makeUnsafe` decodes a recorded activity exit with the activity's own exit schema under `Effect.orDie`, so a failure outside the activity's declared `error` schema becomes a defect. Its `makeDeferredState().deferredDone` preempts a live run parked on the completed deferred, and `WorkflowInstance.abandoned` marks a run given up for replay elsewhere.

## Decisions

Each decision gives the recommended default. Items marked **Behaviour change** alter a statement in an existing contract, ADR, or API doc; the [list at the end](#behaviour-changes-against-existing-contracts) collects them.

### 1. Storage (`0012_workflows`)

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
  manifest_hash  text    NOT NULL,           -- the manifest the execution started under (decision 7)
  payload        bytea   NOT NULL,           -- schema-encoded input, compressed like state
  caller         text    NOT NULL,           -- encoded System caller: source "workflow", owner ref, onBehalfOf
  event_cursor   bigint  NOT NULL,           -- decision 5
  status         text    NOT NULL CHECK (status IN ('running', 'suspended', 'finished')),
  interrupt      boolean NOT NULL DEFAULT false,
  result         bytea,                      -- schema-encoded Exit once finished
  started_at_ms  bigint  NOT NULL,
  finished_at_ms bigint,
  PRIMARY KEY (routing_key, execution_id),
  FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations,
  CHECK ((status = 'finished') = (result IS NOT NULL AND finished_at_ms IS NOT NULL))
);
CREATE INDEX actor_workflow_executions_open
  ON actor_workflow_executions (routing_key, tenant_id, actor_type, actor_id)
  WHERE status <> 'finished';
CREATE INDEX actor_workflow_executions_finished
  ON actor_workflow_executions (bucket, finished_at_ms)
  WHERE status = 'finished';
CREATE INDEX actor_workflow_executions_check
  ON actor_workflow_executions (actor_type, workflow, manifest_hash)
  WHERE status <> 'finished';

CREATE TABLE actor_workflow_step (
  routing_key    bigint  NOT NULL,
  execution_id   text    NOT NULL,
  tenant_id      text    NOT NULL,
  actor_type     text    NOT NULL,
  actor_id       text    NOT NULL,
  step           text    NOT NULL,           -- recorded name; markers are "version/<name>"
  attempt        integer NOT NULL,           -- the activity attempt; 0 for every other kind
  kind           text    NOT NULL CHECK (kind IN ('activity', 'clock', 'deferred', 'wait', 'version')),
  exit           bytea,                      -- schema-encoded Exit; NULL while pending
  due_at_ms      bigint,                     -- clocks and timed waits: recorded once, on first schedule
  wait_event     text,                       -- the event tag a wait matches
  wait_after     bigint,                     -- the wait sees owner events after this sequence
  scanned        bigint,                     -- highest event sequence the fiber has evaluated `where` on
  matched        bigint,                     -- the event sequence that resolved the wait
  version        integer,                    -- the recorded marker value
  started_at_ms  bigint  NOT NULL,
  settled_at_ms  bigint,
  PRIMARY KEY (routing_key, execution_id, step, attempt),
  FOREIGN KEY (routing_key, execution_id) REFERENCES actor_workflow_executions ON DELETE CASCADE,
  CHECK ((kind = 'wait') = (wait_event IS NOT NULL AND wait_after IS NOT NULL AND scanned IS NOT NULL)),
  CHECK ((kind = 'clock') <= (due_at_ms IS NOT NULL)),
  CHECK ((kind = 'version') = (version IS NOT NULL AND exit IS NULL))
);
-- Pending waits of one owner for one event tag: the emit-path lookup (decision 5).
CREATE INDEX actor_workflow_step_waits
  ON actor_workflow_step (routing_key, tenant_id, actor_type, actor_id, wait_event)
  WHERE kind = 'wait' AND exit IS NULL;

-- Every accepted step and marker manifest (decision 7).
CREATE TABLE actor_workflow_manifests (
  actor_type     text   NOT NULL,
  workflow       text   NOT NULL,
  manifest_hash  text   NOT NULL,
  manifest       jsonb  NOT NULL,           -- { steps: [{ name, kind, schema fingerprints }], versions }
  accepted_at_ms bigint NOT NULL,
  PRIMARY KEY (actor_type, workflow, manifest_hash)
);
```

- **Pending rows.** A step row is written before its work starts, with `exit` NULL: an activity attempt before it runs (as an effect attempt is), a clock when first scheduled, and a wait when it registers. Settling a step is `UPDATE … SET exit = … WHERE exit IS NULL`, so exactly one writer settles it; any other writer reads the recorded exit and uses that. A repeated `scheduleClock` on replay finds the row and keeps its `due_at_ms`.
- **Steps are deleted when the execution finishes.** The transaction that records `result` and `status = 'finished'` deletes the execution's step rows. A finished execution never replays, and `poll` reads only `result`.
- **Everything is on the owner's shard.** All workflow rows lead with the owner's `routing_key` and carry its owner columns. No workflow row is written under another actor's key.
- **Fence and lock order.** Every engine transaction outside a turn (step write, settle, status change, result, suspend) begins with `SELECT generation FROM actor_generations WHERE <owner> FOR SHARE` and stops, writing nothing, if the generation differs from the one the activation acquired. It sets `lock_timeout` to the actor's `lockWait`, runs no user code, and then touches rows in one order: execution, steps, outbox. A turn takes `FOR UPDATE` on the same generation row first, so a stale runner's write either commits before the generation bump or sees the new generation, and the two can't deadlock.

**Behaviour change:** this replaces ADR 0012's single `actor_workflow_step` sketch (`exit NOT NULL`, primary key `(routing_key, execution_id, step)`) with executions, steps and manifests; pending rows; an `attempt` column; and the owner columns and foreign key every other framework table has.

### 2. Execution identity, and how the framework drives Effect's engine

```text
w1.<base64url(JSON.stringify([tenant, actorType, actorId, workflow, key]))>
```

- **The framework calls the engine directly.** Handles and turns call `WorkflowEngine.execute`, `poll` and `interrupt` with a `w1.` id. Effect's `Workflow.execute`, `Workflow.poll` and `Workflow.interrupt` compute a hashed id instead, so the application never calls them; our engine dies with `InvalidExecutionId` on any id that doesn't decode as `w1.`. That includes `Workflow.execute` called from inside a body (a child workflow), which is unsupported in this ADR.
- **The key.** `Actor.workflow` uses the same `input`, `output` and `errors` fields as `Actor.command`. By default the key is the start's command id: the intent id for `later.Ship(input)`, and the handle's command id for `order.Ship(input)`. A handle retry keeps its command id, so it attaches to the same execution. `Actor.workflow(tag, { key })` overrides this with a function of the input; a second start with the same key then attaches to the existing execution without comparing inputs, as Effect's `Workflow.execute` does.
- **Limits.** The key is at most 256 UTF-8 bytes and the id at most 1,024 bytes. Longer keys fail the start with `InvalidExecutionKey`.
- **The deployment is the database.** Each deployment (and each region of a hosted deployment) has its own database, as it already does for `routing_key`, receipts and outbox rows. An id presented to another deployment finds nothing.
- **Tenant check.** Decoding an id for `poll`, `result`, `interrupt` or `Order.run` fails `InvalidExecutionId` when its tenant differs from the ambient tenant, its actor type or workflow differs from the member, or it doesn't decode.

```ts
export const Ship = Actor.workflow("Ship", {
  input: { orderId: OrderId, address: Address },
  output: Label,
  errors: [ShippingFailed],
  key: ({ orderId }) => orderId, // optional; defaults to the start's command id
  versions: { "fraud-check": { current: 2, min: 2 } }, // decision 6
})
// steps are typed constructors on the member (decision 7)
export const MakeLabel = Ship.step("label", { input: Order, success: Label, errors: [LabelFailed] })
export const CoolOff = Ship.sleep("cool-off")
export const AwaitPaid = Ship.wait("paid", Paid)
```

**Behaviour change:** ADR 0012, [contract 08](../contracts/08-background-work.md) and the [data model](../architecture/data-model.md) list the deployment inside the execution identity. It remains part of the identity through the storage boundary, not the encoded id, so an id is unique only within its deployment.

### 3. Starting a workflow

A start is always an owner turn. It inserts the execution row (with `manifest_hash`), one `version/<name>` step per declared marker, and the keyed outbox timer `wf:<execution id>` due now. The insert is `ON CONFLICT (routing_key, execution_id) DO NOTHING`; a start that attaches to an existing execution writes nothing else, so it never rewrites markers or the timer.

- **Inside a turn**, `later.Ship(input)` stages an ordinary outbox intent to the owner with the reserved internal command `$workflow/start`. Unlike other intents, a workflow intent mints its intent id when it is staged, not when the outbox is written, so it can return the execution id to the handler:

  ```ts
  PlaceOrder: Effect.fn(function* (order) {
    const turn = yield* Order.Turn
    const later = yield* Order.intents(turn.id)
    yield* turn.emit(new Paid({ orderId: order.id })) // visible to the workflow's waitFor
    const executionId = yield* later.Ship({ orderId: order.id, address: order.address })
    yield* turn.state.set({ shipment: executionId })
  })
  ```

  The intent carries the start anchor from decision 5. For the anchor, the turn admission `SELECT` also reads `event_sequence` from the locked generation row.

- **Outside a turn**, `order.Ship(input)` is a direct command to the owner that runs the start turn, and returns a `WorkflowRun` once it commits.
- An intent staged by a turn that rolls back never starts an execution, as with any intent.

**Behaviour change:** [server API](../api/01-server-api.md) intents return `Effect<void, never, Actor.InTurn>` and mint their ids when the outbox is written. A workflow intent returns `Effect<string, never, Actor.InTurn>`, the execution id, and mints its id at staging.

### 4. The run loop, recovery, and actor calls

- **Resumes are internal commands.** The engine runs the workflow fiber in the owner's activation, forked into its scope. Every resume (a due clock or timeout, a matched event, an interrupt, recovery) arrives as the reserved internal command `$workflow/resume` with the execution id as input and System caller `{ source: "workflow", ref: owner }`, delivered by the relay like any keyed timer. Applications can't declare `$workflow/…` commands. A non-System caller reaching `$workflow/start` or `$workflow/resume` is a deterministic defect, like any internal command; `$workflow/interrupt` is the public exception in decision 8.
- **One timer per execution.** The keyed timer `wf:<execution id>` is always due at the earliest of: now, when a resume is owed; the smallest `due_at_ms` among pending clocks and timed waits; and, while the fiber is running, `now + 30 s` for recovery. An untimed suspended execution with nothing owed has no timer. The engine rewrites the timer in each fenced transaction that changes one of these inputs.
- **A resume that finds no live fiber** replays the execution from its recorded steps. Before replaying, it settles every pending clock whose `due_at_ms` has passed and every timed wait whose deadline has passed and whose event scan (decision 5) finds no match. This is also how recovery works when a runner dies or a shard moves; no heartbeat or scan exists beyond the relay's due-work scan (ADR 0006).
- **A resume that finds a live fiber never just re-arms.** It reads the execution. If `interrupt` is set, it interrupts the run (decision 8). If a pending clock is due or a pending wait has events after `scanned`, it settles what it can and calls `deferredState.deferredDone` for those names, which preempts a run parked on them, as Effect's own engines do. Otherwise it sets `resumeRequested` so the run replays when it exits. It re-arms the recovery deadline in every case.
- **Suspending re-checks under the fence.** The transaction that marks an execution `suspended` holds `FOR SHARE` on the generation row. In it, the engine checks whether any pending wait has a tagged owner event after `scanned`, and whether any pending clock is due. If so, it leaves the timer due now instead of removing it. An event that commits while the run is suspending is therefore either seen here or sees the pending wait row (decision 5).
- **Hibernation, drain and eviction.** An activation with a live workflow fiber doesn't hibernate. When an activation's scope closes for drain, shutdown or eviction, the engine marks the run `abandoned`, records no exit, and leaves the recovery timer, so another runner replays it.
- **Activities are at least once, as in Effect.** The pending step row for `(name, attempt)` is written before the activity runs. A crash leaves the row pending, and the replay reruns that attempt under the same attempt number.
- **Workflow bodies have no intents.** A body runs outside any transaction, so `Actor.InTurn` is never provided and `X.intents` is unavailable. A body that must message another actor calls a handle inside an activity.
- **Actor calls happen only inside a step's `execute`.** A `Ship.step` compiles to an Effect `Activity`, so this document calls a running step an activity. Anywhere else in a body a handle call dies with `Actor call outside an activity`, because a call from the body would run again on every replay. A call inside an activity:
  - carries the execution's recorded caller, System `{ source: "workflow", ref: owner, onBehalfOf }`;
  - skips the external authorization and expiry checks, like relay delivery (contract 08: accepted work continues after the principal loses access); applications may still reauthorize on `onBehalfOf`;
  - uses a derived command id `v1.<s>.<s + retryWindow>.<uuid>`, where `s` is the attempt's recorded `started_at_ms` and `uuid` is a v4-shaped digest of `(execution id, step, attempt, n)`, and `n` counts the attempt's calls in issue order. A rerun attempt repeats the same ids, and the receivers' receipts deduplicate them. Concurrent calls in one activity keep their ids only if they are issued in the same order; the API docs recommend sequential calls, or one call per activity.
- **Derived ids expire.** A receiver's receipt for a derived id is kept until the id's `expiresAt`, and then may be pruned. So before each derived call the engine checks database time against `expiresAt − (commandTimeout + deliveryTimeout)` of the target. Past it, the call is not sent and the activity dies with the defect `ActivityOutcomeUnknown`. The same happens when replay finds a pending attempt whose derived calls could already be past that bound. Because Effect decodes a recorded exit with the activity's own schema, this can't be a typed failure that `Activity.retry` sees. It fails the workflow unless the body catches it with `Effect.catchDefect` and decides, for example by starting a new activity whose calls are new operations. `ClusterWorkflowEngine` has no such bound; the shared suite records it as an expected divergence.

**Behaviour change:** the [context API](../api/02-context.md) says request/reply handles are available in workflow bodies and that bodies may call `X.intents(id)`. Handles now work only inside an activity, and bodies can't call `X.intents`. [Contract 01](../contracts/01-actor-authority.md)'s "workflow bodies access actors through workflow handles" is narrowed the same way.

**Behaviour change:** [contract 08](../contracts/08-background-work.md) says an activity's command identity "derives from execution ID and activity name and remains stable across retries". It now derives from the execution id, step, attempt and call ordinal. Contract 08 also says expiry "MUST NOT discard pending internal work or its deduplication evidence", and [contract 04](../contracts/04-receipts.md) that cleanup must preserve the deduplication evidence of recovery obligations. A pending activity whose derived ids reach their expiry is not rerun: it surfaces `ActivityOutcomeUnknown` instead. The evidence isn't silently discarded, but the obligation stops being retried automatically. This is the one intentional weakening in this ADR, and open question 2 offers the alternative.

### 5. Owner-event waits and the start-to-wait race

A wait is a typed step declared with `Ship.wait(name, Event)`. It replaces `X.Workflow.waitFor`, so there is one way to wait.

```ts
export const AwaitPaid = Ship.wait("paid", Paid)
export const AwaitRefund = Ship.wait("refund-paid", Paid) // a second wait for the same tag needs its own step

const paid =
  yield *
  AwaitPaid({
    where: (event) => event.orderId === order.id,
    timeout: "1 day",
  }) // Option<Paid>; Option.none() after the timeout
```

**What a wait sees.**

- Each execution has an `event_cursor`. It starts at the start anchor. For a workflow started by `later.Ship` in its owner's own turn, that is the owner's `event_sequence` before that turn's emits, so events the starting turn emits are visible. For any other start, it is the owner's `event_sequence` when the start turn commits.
- A wait registers with `wait_after = event_cursor`. It resolves with the lowest-sequence owner event after `wait_after` that has the wait's tag and satisfies `where`.
- The transaction that settles a wait sets `event_cursor = max(event_cursor, matched)`. Two sequential waits for `Paid` therefore resolve with the first and the second `Paid`, and a wait never sees events from before a wait it follows.
- `where` must be a pure function of the event. It runs in the workflow fiber, never under a lock or in a turn.
- A wait's step name is the string given to `Ship.wait`. Each wait step resolves at most once per execution; calling it again returns the recorded result, so a second wait for the same tag is a second `Ship.wait` step.

**How the race closes.**

1. **Registration** is one fenced engine transaction under `FOR SHARE`. It inserts the pending wait row (`scanned = wait_after`) and, with SQL only, checks whether any owner event with that tag exists after `wait_after`. If one does, it makes the timer due now. Otherwise, for a timed wait, the timer's due time includes `due_at_ms`.
2. **A turn that emits events** already holds `FOR UPDATE` on the same row. In the same transaction it looks up the owner's pending waits for the emitted tags through `actor_workflow_step_waits` and makes `wf:<execution id>` due now for each. The lookup is a CTE folded into the event-append statement, so it adds no round trip, and it runs only for actor types with a registered `Ship.wait` step for the tag.
3. The locks conflict, so either the turn commits first and the registration check sees its event, or the registration commits first and the turn sees the pending row. Decision 4 extends this to the window in which the run is suspending, and to a resume that arrives while the run is live.
4. **The resumed fiber** reads owner events after `scanned` without locks and evaluates `where`. It then settles the wait in a fenced transaction with the first match, or advances `scanned` if nothing matched. A settle and a timeout race through the same `WHERE exit IS NULL` update.
5. **A timeout** settles `None` only after the fiber has scanned every event up to the deadline and found no match, so an event committed before the deadline wins over the timeout.

**Behaviour change:** [contract 05](../contracts/05-messaging.md) and the [context API](../api/02-context.md) describe `waitFor(Event, { where, timeout })` on `X.Workflow`. It becomes the typed `Ship.wait(name, Event)` step with the same `where` and `timeout`. Contract 05 requires only that `waitFor` observe owner events and close the race. It now states that a wait sees owner events from the execution's cursor, not from registration, so a wait can resolve on an event committed before the wait was reached. [Contract 03](../contracts/03-transactions.md) gains the emit-path timer write.

### 6. `wf.version(name)` and version markers

Markers are declared on the workflow and recorded when the execution starts:

```ts
export const Ship = Actor.workflow("Ship", {
  // …
  versions: { "fraud-check": { current: 2, min: 1 } }, // min defaults to 0
})
export const Screen = Ship.step("fraud", { input: Order, success: Result })
export const ScreenV2 = Ship.step("fraud-v2", { input: Order, success: Result })

Ship: Effect.fn(function* (order) {
  const wf = yield* Order.Workflow
  const fraud = yield* wf.version("fraud-check") // 1 or 2, as recorded at start
  if (fraud === 1) yield* Screen.run(order, screenV1)
  if (fraud >= 2) yield* ScreenV2.run(order, screenV2)
  yield* AwaitPaid({ timeout: "1 day" })
})
```

- The start turn writes a `version/<name>` step row per declared marker, holding its `current`. `wf.version(name)` returns the recorded value, or 0 when the execution started before the marker existed. The name must be a declared key; any other string is a type error. The `version/` prefix keeps markers from colliding with other steps.
- The value is fixed for the whole execution. An old execution that hasn't reached the code point yet still takes its old branch, without the engine knowing where replay is.
- **At runtime**, a runner that resumes an execution whose recorded value (or 0 when absent) is outside its `min..current`, or which recorded or declared (through its start manifest) a step the runner's code doesn't register, does not run it. It suspends the execution with a `WorkflowIncompatible` defect span and keeps the recovery timer, so a compatible runner picks it up. It never fails the execution.
- **Retiring a branch takes two deploys.** First deploy the new `current` everywhere. Only after no old runner remains (so none can start executions at the old value) and no open execution recorded the old value, raise `min` and remove the old branch's steps. The deploy check enforces the second condition; the first is an operator step documented with it.

**Behaviour change:** the [post-foundation sketch](../api/post-foundation-sketches.md) shows `wf.version(name, n)` recorded lazily when first reached. Markers are now declared on `Actor.workflow`, recorded at start, and read with `wf.version(name)`.

### 7. Typed step constructors, the manifest, and the deploy compatibility check

Every step is a value built from the workflow member with an explicit string name. The constructors compile to Effect's own primitives, so the engine, storage and shared suite are unchanged; what changes is that the framework, not the application, knows every step.

```ts
export const Reserve = Ship.step("reserve", {
  input: Order,
  success: Reservation,
  errors: [OutOfStock],
})
export const CoolOff = Ship.sleep("cool-off")
export const AwaitPaid = Ship.wait("paid", Paid)
export const FirstQuote = Ship.race("first-quote", { success: Quote })

export const ShipLive = Order.toLayer(
  Effect.gen(function* () {
    const inventory = yield* Inventory
    return {
      Ship: Effect.fn(function* (order) {
        const reservation = yield* Reserve.run(order, (o) => inventory.reserve(o))
        yield* CoolOff("1 hour")
        const paid = yield* AwaitPaid({ where: (e) => e.orderId === order.id, timeout: "1 day" })
        const quote = yield* FirstQuote.run([carrierA.quote(order), carrierB.quote(order)])
        return yield* makeLabel(reservation, quote, paid)
      }),
    }
  }),
)
```

| Constructor                                    | Compiles to                                               | Recorded step name  |
| ---------------------------------------------- | --------------------------------------------------------- | ------------------- |
| `Ship.step(name, { input, success, errors? })` | `Activity.make` with those schemas; `run(input, execute)` | `name`, per attempt |
| `Ship.sleep(name)`                             | `DurableClock.sleep`; called with a duration              | `name`              |
| `Ship.wait(name, Event)`                       | the owner-event wait of decision 5                        | `name`              |
| `Ship.race(name, { success, errors? })`        | `DurableDeferred.raceAll`; `run(effects)`                 | `name`              |

- **Names are explicit and static.** The name is a string literal given at construction. Two constructors with the same name on one member throw at construction. The engine strips Effect's `DurableClock/` and `raceAll/` prefixes when it records, so every kind uses the constructor's name. Dynamic step names are not supported: there is no key or template on a constructor, and each step runs at most once per execution, so calling it again (for example in a loop) returns the first recorded result. Work over a dynamic collection goes inside one step, or into a separate workflow execution per item started through a handle from a step.
- **Registration.** Constructors register on the member when their module loads. `X.toLayer` reads the member's registry when the layer is built, so every constructor must be a module-level value that the actor's layer module imports. The engine refuses a step that isn't in the registry at layer build: a constructor created inside a body, and raw `Activity.make`, `DurableClock.sleep` or `DurableDeferred` used directly in a body, die with `Unregistered workflow step`. That keeps the manifest complete.
- **Types.** `run`'s `execute` receives the decoded `input` and must return `success` or one of `errors`; its requirements flow into the layer's requirements like a handler's. A step's success and error are typed at the call site, and a wait returns `Option<Event>`.

**The manifest** is derived from the registry: for each step its name, kind, and a fingerprint of its `input`, `success` and `errors` schemas (for waits, the event tag and the event schema's fingerprint), plus the member's `versions`. Every execution records the hash of the manifest it started under, and `actor_workflow_manifests` keeps each accepted manifest while an open execution references it.

The check is one function with two callers. It reads open executions only (finished ones hold no steps), and refuses when:

1. an open execution belongs to an actor type or workflow member the code no longer declares;
2. an open execution's start manifest has a step the code no longer registers, or registers under a different kind. The step's string is its identity: renaming the TypeScript value is free, but changing the string is a removal plus an addition. This covers a removed or renamed step even if no open execution has reached it yet, so removing or renaming a step waits until every execution started under a manifest containing it has finished;
3. a step whose exit an open execution has recorded changed its `success` or `errors` fingerprint, because replay would decode the recorded exit with the new schema. To change a step's result shape, add a new step under a version marker and keep the old one until its executions finish;
4. an open execution recorded a marker value outside the new `min..current`, or a marker that is no longer declared;
5. `min` is above 0 while an open execution predates the marker (it has no row for it);

- **`durable workflows check`** in `apps/cli`, the CLI's first real command:

  ```text
  $ durable workflows check --entry ./src/actors.ts --database-url "$DATABASE_URL"
  Order/Ship  step "label" removed     412 open executions (oldest 2026-09-20T08:14Z)
  Order/Ship  fraud-check min 2 > 1     37 open executions
  2 incompatibilities; deploy refused (exit 1)
  ```

  `--entry` names a module that exports the application's `actors` array. The command runs in a read-only transaction, prints each blocking group with its count and oldest start, exits 1 on any incompatibility and 0 otherwise, and has `--json` for CI.

- **Startup refusal.** `Actors.layer` runs the same check after migrations and before it registers entities, and refuses to start, as a placement mismatch does. The full check runs only when the deployed manifest hash isn't the most recently accepted one; a passing check records the manifest as accepted. A rollback's manifest also differs, so the check catches a rollback that would strand executions on newer markers or steps.
- Retention deletes a manifest row once no open execution references its hash and it isn't the latest for its workflow.

**Behaviour change:** [ADR 0012 §1](0012-workflows-internals-effects-defects-merging-regions.md#1-workflows-run-on-our-own-engine-on-the-owner-actors-shard) says workflow code uses Effect's `Activity`, `DurableClock` and deferreds unchanged, and the [context API](../api/02-context.md) and [contract 08](../contracts/08-background-work.md) repeat it. Workflow bodies now use `Ship.step`, `Ship.sleep`, `Ship.wait` and `Ship.race`, which compile to those primitives; using the primitives directly in a body dies. This supersedes that part of ADR 0012 §1. It also makes ADR 0014 item 4 concrete.

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

- **`poll`** returns Effect's own `Workflow.Result`: `Option.none()` when the execution is unknown or pruned, `Suspended` while it is open (including while it runs), and `Complete(exit)` when it has finished. It is admitted like a query on the owner, with the caller's tenant and authorization for the `Ship` member. It never activates the actor, and a revoked caller gets `Unauthorized` (contract 08: revocation blocks result reads).
- **`result`** polls with backoff from 50 ms to 1 s until `Complete`, then returns its exit. `None` fails `WorkflowNotFound`; an interrupted execution fails with the interrupt cause. The caller's `Timeout` stops only the waiting.
- **`interrupt`** is the reserved `$workflow/interrupt` command: a public, receipted command turn on the owner with its own command id, authorized like the `Ship` member. It is the one reserved command a non-System caller may reach. It sets `interrupt = true` and makes the timer due now. The resumed or live run (decision 4) interrupts, runs Effect's compensation finalizers, and records the interrupt exit. Interrupting a finished execution succeeds and changes nothing. When it races completion, whichever terminal write commits first is the result.
- **`Order.run(member, executionId)`** decodes and checks the id (decision 2) and returns a typed `WorkflowRun` without contacting the owner.

**Behaviour change:** none. This makes the [glossary](../GLOSSARY.md)'s `WorkflowRun` concrete.

### 9. Retention

- `policy.keepWorkflows` (default `"7 days"`) keeps a finished execution's row, and so its `poll` result, for that long after `finished_at_ms`. Startup refuses a value below the deployment's retry window, so a retried start keyed by its command id can never re-create a pruned execution. The M1.9 retention loop deletes expired rows per bucket through `actor_workflow_executions_finished`.
- After pruning, a start with an explicit `key` creates a new execution; this is documented. `poll` on a pruned id returns `Option.none()`.
- **Events pinned by open executions.** Event pruning (`keepEvents`) must not delete an owner event with a sequence above the smaller of the owner's open executions' `event_cursor` and their pending waits' `wait_after`, for actor types with a registered `Ship.wait` step. `akter.workflow.pinned_events` reports how many events are held.
- `$workflow/resume` turns write receipts like any delivered intent, and M1.9 prunes them after the retry window. Recovery re-arms cost one resume turn per 30 s only while an activity is running, not while an execution is suspended; the `workflow` benchmark measures it.

**Behaviour change:** [retention](../operations/retention.md) required that event retention "cover every … workflow `waitFor` dependency" without saying how. The bound above is new behaviour for M1.9's event pruning.

### 10. The shared engine suite

`packages/akter/src/testing/conformance/workflows.ts` exports `describeWorkflowEngine(name, { layer, executionId })`. It registers plain Effect workflows with the engine and drives `WorkflowEngine` directly (not `Workflow.execute`), so its bodies use Effect's primitives; the step-registry rule of decision 7 belongs to `Actor.workflow` and is tested separately. It drives the engine with ids from the `executionId` factory: `w1.` ids for ours, any string for Cluster's. It runs once with our engine on PGlite and Postgres, and once with `ClusterWorkflowEngine.layer` over Cluster's in-memory message storage and test runner. These cases must match on both:

| Case                                            | Asserts                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `replays a recorded activity without rerunning` | an activity's side-effect counter stays 1 across a resume                                           |
| `records each Activity.retry attempt`           | attempts 1..n each record an exit; replay returns the final one                                     |
| `resumes a durable clock after engine restart`  | tear down and rebuild the engine layer mid-sleep; the body continues after the due time             |
| `replays a DurableDeferred.raceAll winner`      | the recorded winner is returned on replay, and the losing branch doesn't rerun                      |
| `interrupts a suspended execution`              | compensation finalizers run once; `poll` returns `Complete` with an interrupt cause                 |
| `interrupts a running execution`                | as above, while an activity runs                                                                    |
| `polls unknown and complete`                    | `None` before the first start, `Complete(exit)` after finish (the running state differs; see below) |
| `attaches a repeated execute to one execution`  | two `execute` calls with one id run the body once and return the same result                        |
| `discards an execute`                           | `discard: true` returns and the body still completes                                                |

Expected divergences, asserted on our engine only:

- `poll` on an execution that is running but hasn't yet suspended returns `Suspended` on ours and `None` on Cluster's.
- A derived actor call past its expiry bound dies with `ActivityOutcomeUnknown` (decision 4).
- External completion of a `DurableDeferred` (`DurableDeferred.done` with a token from outside the execution) is unsupported: the engine's `deferredDone` accepts only calls from the execution's own fiber, and any other call dies with `Unsupported`. Owner-event `waitFor` is the way to signal a workflow from outside.

## Behaviour changes against existing contracts

| Changed text                                                                                                     | Change                                                                                                      | Decision |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| ADR 0012 §1 `actor_workflow_step` sketch                                                                         | Executions, steps and manifests; pending rows; `attempt`; owner columns and foreign key                     | 1        |
| ADR 0012 §1, contract 08, data model: identity includes deployment                                               | The deployment is the database, not an encoded component                                                    | 2        |
| Server API: intents return `Effect<void>` and mint ids at outbox write                                           | Workflow intents return the execution id and mint at staging                                                | 3        |
| Context API, contract 01: bodies use handles and may call `X.intents`                                            | Handles only inside activities; no `X.intents` in bodies                                                    | 4        |
| Contract 08: activity identity "derives from execution ID and activity name"                                     | Derived from execution id, step, attempt and call ordinal                                                   | 4        |
| Contract 08 (expiry keeps pending internal work) and contract 04 (cleanup keeps recovery deduplication evidence) | A pending activity whose derived ids reach expiry dies with `ActivityOutcomeUnknown` instead of being rerun | 4        |
| Contract 05: `waitFor` closes the registration race                                                              | A wait sees owner events after the execution's cursor, not after registration                               | 5        |
| Contract 03: the turn transaction's contents                                                                     | An event-emitting turn also re-arms resume timers for matching pending waits                                | 5        |
| ADR 0012 §1, context API, contract 08: bodies use Effect's `Activity`, `DurableClock` and deferreds unchanged    | Typed `Ship.step`/`sleep`/`wait`/`race` constructors; raw primitives in a body die; no dynamic step names   | 7        |
| Context API, contract 05: `X.Workflow.waitFor(Event, …)`                                                         | `Ship.wait(name, Event)` step                                                                               | 5        |
| Post-foundation sketch: `wf.version(name, n)`                                                                    | Declared `versions`, recorded at start, read with `wf.version(name)`                                        | 6        |
| Retention: event pruning covers `waitFor` dependencies                                                           | Pruning stops at open executions' cursors and pending waits                                                 | 9        |

## Alternatives

| Question             | Rejected options                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage              | One step table with the execution as a special step: `poll`, retention and the deploy check would all filter on it. Keeping finished steps: the table grows with history nobody replays.                                                                                                                                                                                                                                                   |
| Execution id         | Effect's hash of tag and idempotency key: it can't be routed to an owner without a lookup table. Encoding the deployment: no deployment id exists, and the database already is the boundary.                                                                                                                                                                                                                                               |
| Default key          | Hashing the input: two intentional starts with equal input would merge silently.                                                                                                                                                                                                                                                                                                                                                           |
| Recovery             | A startup scan for running executions: it grows with the whole deployment and misses runners that die later. A heartbeat column: a write per running execution per interval, plus a scanner.                                                                                                                                                                                                                                               |
| Wait visibility      | From registration only: that is the race. Evaluating `where` inside the emitting turn or under the registration lock: user code would hold the owner's row lock. `LISTEN/NOTIFY`: ruled out by ADR 0006, and not durable.                                                                                                                                                                                                                  |
| Version markers      | Lazy recording on first reach (Temporal's `getVersion`): the engine can't tell a replay from first reach when steps run concurrently. Source order as the version: rejected by ADR 0014.                                                                                                                                                                                                                                                   |
| Step manifest        | Inferring steps by running the body: unreached steps are invisible. Comparing only recorded steps: a renamed step nobody has reached yet passes. Declared name lists beside unchanged Effect primitives (`steps: ["label"]`): names are repeated, a missing one is caught only at runtime, and the check can't see result schemas. Dynamic step names (keyed families): not needed yet, and each family needs its own compatibility rules. |
| Expired activity ids | Rerunning with the old ids: the receivers' receipts may be pruned, which risks a second execution. Minting new ids silently: ADR 0014 forbids replacing ids without the application's say. A typed failure: Effect decodes recorded exits with the activity's own error schema, so it can't carry a framework error.                                                                                                                       |

## Consequences and evidence

M2.7 builds decisions 1–5 and 8–10, plus decision 7's constructors, registry and manifest, in a three-PR stack: engine and storage; typed step constructors, the registry, the manifest and marker rows at start; then waits, and resume with tenant and attribution. Its start turn and emit path need the manifest and the registered waits, and the runtime suspension for incompatible executions lives in the engine. The constructors add about a day, so M2.7 grows from L to L+ (about four days). M2.8 builds `wf.version` reads and decision 7's deploy check (including the schema-fingerprint rule), startup refusal and CLI. `0012_workflows` creates all three tables, so M2.8 needs no migration of its own. Neither starts until this ADR is accepted.

Conformance cases M2.7 must add, in `conformance/workflows.ts`, on PGlite and Postgres (crash, contention and multi-runner cases on Postgres and the M2.1 harness):

- the shared suite in decision 10, and its three divergence cases;
- `writes every workflow row under the owner's routing key` and `rejects step writes from a stale generation`;
- gate **Workflow tenant isolation**, W1 and H2: `separates equal keys across tenants and owners`, `restores tenant and onBehalfOf on resume elsewhere` (harness), `continues with recorded attribution after the starting caller loses access`, `denies poll to a revoked caller`, and `rejects an execution id from another tenant`;
- gate **`waitFor` registration**, W2: `resolves an event emitted by the starting turn`, `resolves an event committed between start and registration`, `resolves an event racing registration on Postgres`, `resolves an event committed while the run is suspending`, `resolves an event delivered while the run is live`, `resolves two sequential waits with two events`, `resolves concurrent waits for one tag`, and `settles a wait exactly once when its event and timeout race`;
- `resumes two concurrent clocks at their own due times` and `keeps a clock's due time across replays`;
- `resumes after runner kill during an activity` and `does not rerun an activity whose exit was recorded` (harness); `abandons a running execution on drain and resumes it on another runner` (harness);
- `types Ship.step results and errors at the call site` (type test), `throws on two constructors with one name`, `dies on a raw Activity.make or a constructor created inside a body with Unregistered workflow step`, and `replays the first result when a step is called twice`;
- `dies on an actor call outside an activity`, `deduplicates a rerun activity's actor calls by derived command id`, and `dies with ActivityOutcomeUnknown instead of calling past the expiry bound`;
- `returns the execution id from later.Ship and attaches repeated starts without rewriting markers`, `rejects an oversized key with InvalidExecutionKey`, and `rejects a non-w1 id, including a child Workflow.execute, with InvalidExecutionId`;
- `interrupts a running execution from a handle` and `interrupts once when interrupt races completion`;
- `suspends an execution with an unregistered step, or a marker outside min..current, and resumes it on a compatible runner` (harness, rolling deploy);
- `deletes steps on finish and prunes finished executions after keepWorkflows`, `refuses startup when keepWorkflows is below the retry window`, and `keeps events above an open cursor or pending wait from pruning`.

Conformance cases M2.8 must add, in `conformance/workflow-versions.ts`:

- `records markers at start and reads 0 for executions older than the marker`;
- `refuses startup when a step in an open execution's start manifest is removed or renamed`, `… when a marker leaves min..current`, `… when min rises above 0 while an execution predates the marker`, `… when a workflow member is removed`, and `… when a recorded step's result schema changes`; `accepts renaming a step's TypeScript value without changing its name`;
- `skips the full check when the manifest is unchanged` and `refuses a rollback that strands newer executions`;
- `durable workflows check exits 1 with the blocking groups and 0 when compatible`;
- the ledger's **Workflow compatibility** check across a restart with an old execution sleeping.

New failure-matrix rows: "Runner dies during a workflow activity", "Workflow step write from a stale generation", "Resume delivered while the workflow run is live or suspending", "Activation drained with a live workflow run", "Wait timeout races the matching event", "Interrupt races workflow completion", "Activity actor call reaches its expiry bound", "Runner lacks a step or marker an execution needs", "Deploy removes a step an open execution may need", and "Event pruning reaches an open wait". The existing rows "Workflow resumes elsewhere" and "Event races workflow wait registration" stay as they are.

Benchmark: M2.7 adds the `workflow` scenario: activity step overhead (statements and milliseconds per recorded activity), resume latency after a runner kill, sleep lateness against the due time, and recovery resume turns per running execution. The emit-path wait lookup must leave the T2 statement baseline unchanged for actor types without `Ship.wait` steps.

## Decided questions

1. **Step declaration (Dallen): typed step constructors** with an explicit string name, `Ship.step("reserve", { input, success })` and its siblings. The manifest is derived from the registered constructors, the deploy check guards renames and removals, and dynamic step names aren't supported (decision 7). Declared name lists were the rejected default.
2. **Expired activity calls (delegated to Floppy): die with `ActivityOutcomeUnknown`** and let the body decide. The longer-horizon alternative was rejected.
3. **`keepWorkflows`: 7 days.**
4. **Recovery interval: 30 s.** It bounds resume latency after a runner dies mid-activity and costs one resume turn per running execution per interval.
5. **Removing steps: conservative.** A step can be removed or renamed only when no open execution started under a manifest containing it (decision 7, rule 2). A later ADR could let a marker scope steps to versions so the check can release them earlier.

## Revisit when

- Upstream Effect changes `WorkflowEngine`'s encoded interface, activity attempt semantics, or deferred preemption.
- The recovery resume turns show up in the `workflow` benchmark at the M2 scale run.
- Applications need child workflows, external deferred completion, or dynamic step names, which this ADR leaves unsupported.
