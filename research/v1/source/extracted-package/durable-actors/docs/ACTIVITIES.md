# External work and workflow bridge

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Why activities exist

An actor can durably decide to perform work without holding a database transaction while it waits. Payment APIs, model calls, shell processes and infrastructure provisioning can take seconds or minutes and can have uncertain outcomes after a crash.

Effect Workflow is the preferred engine to evaluate, but its `Activity` type is not a standalone queue job. It records named Effects within a workflow instance and stores completed outcomes. Our bridge must define stable workflow input, launch identity and completion routing.

## Proposed sequence

Actor turn stages `{workId, workflowType, workflowVersion, input, completionProtocol, causation}` in its local outbox. Relay durably starts or resolves that workflow using the same identity on retry. Workflow executes named activities. Completion sends a typed command back to the originating actor; that command is deduplicated like any other.

Do not persist a function such as `onSuccess: result => ctx.self.send(...)`. Store a protocol route and let versioned deployed code build the completion payload. A completion from an obsolete task revision must be rejected or recorded as stale, not overwrite current state.

## Recovery policy classes

| External operation | Recovery default |
|---|---|
| Read-only query | Retry with bounded policy |
| Provider with idempotency key | Retry same provider key, then retrieve outcome |
| Reversible operation | Reconcile first; compensation is separate tracked work |
| Non-idempotent operation without status API | Mark unknown; operator/domain decision required |

A lease expiring does not prove the old worker stopped. Provider-side idempotency/fencing is needed where available. A cancellation request stops future progression and best-effort interrupts current I/O; it does not roll back external effects.

## No hidden continuation guarantee

Ordinary Effect fibers and JavaScript closures are activation/process memory. Only the engine's documented persisted inputs/results/checkpoints survive. Activity body code can execute again, especially around suspension. Split external effects into individually named checkpointed steps and keep provider idempotency explicit.

## Acceptance spike

Test duplicate workflow start, actor crash before start ACK, workflow completion after actor passivation, cancelled/replaced task result, code upgrade between launch and completion, lost provider response, repeated suspension, and result schema changes. Adopt the engine only when these can be represented without bypassing its intended semantics.

## Sources and evidence

- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [C10: Temporal durable execution](https://docs.temporal.io/workflows) — Procedure replay/activity orchestration, not automatic actor-local SQL semantics.
