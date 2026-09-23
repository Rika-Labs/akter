# ADR 0012: Workflow storage, internal commands, effect routes, defects, merging, and home regions

**Status:** accepted design (2026-09-23); implementation and conformance remain pending.

**Responsibility:** settle the seven decisions left open by [ADR 0010](0010-one-way-effect-native-api.md) and [ADR 0011](0011-direct-commands-outbox-and-performance.md).

**Authority:** historical decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when these semantics change.

## Context

The owner reviewed code sketches with three options per question and picked 1B, 2B, 3B, 4C, 5A, 6B, and 7A. Each choice below keeps the "one way to do anything" rule from ADR 0010.

## Decisions

### 1. Workflows run on our own engine, on the owner actor's shard

The framework implements Effect's `WorkflowEngine` service instead of using `ClusterWorkflowEngine`. That built-in engine stores its journal and clock wakeups as persisted Cluster messages. Our engine keeps workflow state on the owner actor's shard and reuses the outbox.

```sql
CREATE TABLE actor_workflow_step (
  routing_key  bigint NOT NULL,
  tenant_id    text   NOT NULL,
  actor_id     text   NOT NULL,
  execution_id text   NOT NULL,
  step         text   NOT NULL,   -- activity name, deferred name, or clock name
  exit         bytea  NOT NULL,   -- schema-encoded Exit
  PRIMARY KEY (routing_key, execution_id, step)
);
```

Workflow code uses Effect's own primitives, unchanged:

```ts
Ship: Effect.fn(function* (order) {
  const wf = yield* Order.Workflow
  const label = yield* Activity.make({
    name: "label",
    success: Label,
    execute: shipping.label(order),
  })
  yield* DurableClock.sleep({ name: "cool-off", duration: "1 hour" })
  yield* wf.waitFor(Paid, { timeout: "1 day" })
  return label
})
```

| Engine operation                       | Implementation                                                      |
| -------------------------------------- | ------------------------------------------------------------------- |
| `execute`, `resume`                    | a direct command to the owner actor that runs the workflow fiber    |
| `activityExecute`                      | runs the activity, then records its `Exit` in `actor_workflow_step` |
| `scheduleClock` / `DurableClock.sleep` | a keyed `actor_outbox` timer that resumes the execution             |
| `deferredDone` / `waitFor`             | an owner-event match that records the deferred's `Exit` and resumes |
| `poll`, `interrupt`                    | read the recorded result; interrupt records a terminal `Exit`       |

The execution id stays `[deployment, tenant, actor, id, workflow, key]`. A shared conformance suite runs the same workflow cases against our engine and against `ClusterWorkflowEngine` to catch behavioral drift from upstream.

### 2. Internal commands have their own section

```ts
export const Chat = Actor.make("Chat", {
  key: RoomId,
  effects: [SendEmail],
  api: { SendMessage, Recent }, // public: handles, HTTP, OpenAPI, Promise client
  internal: { EmailDelivered, EmailFailed }, // System callers only: timers, effect routes, other actors' intents
})
```

The `internal: true` field on `Actor.command` is removed. An internal command is callable only by System callers: outbox delivery, effect routes, and cron. A non-System caller reaching one is still a deterministic defect.

### 3. Effect results and dead letters use declared routes

```ts
export const Chat = Actor.make("Chat", {
  effects: [SendEmail],
  internal: { EmailDelivered, EmailFailed },
  policy: {
    effects: {
      SendEmail: {
        retry: "exponential 100 millis, 10 times",
        onSuccess: EmailDelivered,
        onDeadLetter: EmailFailed,
      },
    },
  },
})

export const ChatEffects = Chat.toEffectLayer(
  Effect.gen(function* () {
    const mailer = yield* Mailer
    return {
      SendEmail: (effect) =>
        mailer.send(effect.to, effect.body).pipe(Effect.as({ messageId: effect.messageId })),
    }
  }),
)
```

- **Success.** An executor returns a value whose type must match the input of its `onSuccess` command. The framework delivers that value through the outbox as a System-caller command whose command id is the effect id. Without an `onSuccess` route, the executor returns `void`.
- **Dead letter.** When retries are exhausted, the framework delivers `onDeadLetter` with `{ effect, cause, attempts }`. `Actor.DeadLetter(SendEmail)` is the schema for that command's input. Without an `onDeadLetter` route, the dead letter is recorded for operators only.
- **Type checks.** `onSuccess` and `onDeadLetter` must name commands in `api` or `internal`, checked like `policy.cron`.
- **Removed.** The `EffectDeadLettered` reserved command and `policy.effectRetry` go away; each effect's retry moves into its route.
- **Executor context.** `X.Executor` keeps `effectId`, `attempt`, `principal`, and the owner `ref`, and executors still cannot touch the database.

### 4. Deterministic defects produce telemetry only

There is no defect hook: `X.onDefect` is removed. A deterministic defect rolls back, returns `Die` to the caller, and leaves the actor resident. The turn span records the cause, and the log carries actor, id, command, and command id. Operators list defects with `durable defects list --actor Chat`, which reads recent defect spans and logs from the telemetry exporter, not from a database table.

The M0 code implements `onDefect` under [ADR 0008](0008-foundation-completion.md); M1 removes the hook and its conformance cases.

### 5. Placement-group reads use `group` on the context

`read.group` and `turn.group` are read-only Drizzle clients pinned to the actor's placement group, as ADR 0010 specified. A query that would leave the group's `routing_key` fails instead of scattering.

### 6. Commutative merging never waits

```ts
const inputs = yield * Queue.takeBetween(likes, 1, 1024)
const combined = inputs.reduce(Like.combine)
```

A runner merges only commutative inputs that are already queued for the same actor, up to 1,024 per merged turn. A lone call adds no latency. This replaces ADR 0011's 10 ms window.

### 7. The operator sets each tenant's home region

```sh
durable tenants create acme --region eu-west-1
durable tenants move acme --region us-east-1   # explicit drain, copy, and cutover
```

A tenant's home region is set explicitly through the control plane and defaults to the deployment's primary region. The edge never assigns a region from where a request lands.

## Alternatives

| Question          | Rejected options                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow storage  | `ClusterWorkflowEngine` in its own shard group: a second storage model and a global hot path. Step commands with no engine: loses `Activity` and `DurableClock`. |
| Internal commands | An `internal: true` field. A separate `Actor.internalCommand` constructor, which is a second way to make a command.                                              |
| Effect results    | Executors calling the actor themselves, which they can forget. No result path at all.                                                                            |
| Defects           | An `onDefect` hook, or an internal defect command, which can loop on corrupt state.                                                                              |
| Group reads       | A separate `X.Group` service. `Fleet.view` only, which loses consistent joins.                                                                                   |
| Merging           | A fixed 10 ms window, or a per-reducer window setting.                                                                                                           |
| Regions           | Pinning to the first request's region, alone or as a fallback.                                                                                                   |

## Consequences and evidence

This ADR supersedes these parts of earlier ADRs:

- **ADR 0010:** `internal: true`, `X.onDefect`, the `EffectDeadLettered` command, executors calling internal commands themselves, and `policy.effectRetry`.
- **ADR 0011:** the 10 ms merge window, and its open question about where workflow state is stored.
- **ADR 0008:** the `onDefect` hook, for the target design.

New conformance checks:

- **Workflow engine:**
  - The engine suite runs against both our engine and `ClusterWorkflowEngine`, and must match on activity replay, clock resume after restart, `waitFor` races, interruption, and result polling.
  - No workflow state is written outside the owner's shard.
- **Effect routes:**
  - An executor's success delivers `onSuccess` exactly once per effect id across executor and relay crashes.
  - Exhaustion delivers `onDeadLetter` once.
  - A route whose command input doesn't match the executor's return type fails to compile.
- **Internal section:** internal commands are absent from handles, HTTP, OpenAPI, and the Promise client; a non-System caller is a deterministic defect.
- **Defects:** a deterministic defect produces a span carrying the cause and runs no user code.
- **Merging:** a lone commutative call adds no delay, and merged turns never exceed 1,024 inputs.
- **Regions:** a request for a tenant with no recorded region routes to the primary region and never sets one.

## Revisit when

- Upstream Effect workflow semantics change in a way the shared engine suite cannot follow cheaply.
- Operators need a defect reaction that telemetry alerts cannot provide.
- Explicit region assignment proves too heavy for self-serve sign-up.
