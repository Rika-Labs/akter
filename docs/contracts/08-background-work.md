# Workflows, schedules, and external effects

**Responsibility:** define workflows, schedules, and provider calls.
**Authority:** normative.  
**Owner role:** reliability/runtime.  
**Change policy:** provider support requires a written adapter contract and fault tests.

There is one actor kind: `Actor.make`. `singleton: true` MUST provide `X.get()` without an id, one cluster-wide `run` loop, and cluster-wide `Cron.every`. `Cron.every(expr, Command, { skipIfOlderThan })` MUST target a zero-input command; on named or minted actors it is per actor, and on a singleton it is once per deployment.

Workflows MUST be actor members declared with `Actor.workflow` in `workflows: [...]`. Their body MUST live in `X.toLayer` as `(ctx, input)`. A turn starts or cancels a workflow only through `ctx.self.Workflow.start/cancel`, which records a transactional intent. Outside turns, the owner handle exposes `start` and `run`.

`WorkflowContext` MUST provide owner identity and caller attribution, `ctx.activity(name, { output, errors, run, retry })`, `sleep`, and owner-event `waitFor(Event, { where, timeout })`. Execution identity MUST include deployment, tenant, owner actor and id, workflow member, and key. Resume MUST restore tenant and `onBehalfOf` from the durable envelope.

External effects MUST be recorded in the turn and executed after commit with stable identity, retries, and dead-letter visibility. Cancellation cannot undo a completed provider call. Verification: **Workflow tenant isolation**, **waitFor registration**, **Intent rollback**, and **Singleton uniqueness** gates.
