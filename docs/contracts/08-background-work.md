# Workflows, schedules, and external effects

**Responsibility:** define workflows, schedules, and provider calls.
**Authority:** normative.  
**Owner role:** reliability/runtime.  
**Change policy:** provider support requires a written adapter contract and fault tests.

There is one actor kind: `Actor.make`. `key: Actor.singleton` MUST provide `X.get()` without an id, one cluster-wide activation (whose build may fork one background loop with `Effect.forkScoped`), and cluster-wide cron. `policy.cron` maps expressions to zero-input commands in `api`, with optional `policy.cronSkipIfOlderThan`; on named or minted actors it is per actor, and on a singleton it is once per deployment ([ADR 0010](../decisions/0010-one-way-effect-native-api.md)).

Workflows MUST be actor members declared with `Actor.workflow` in `api`. Their body MUST live in `X.toLayer` as `(input) => Effect` and receives `X.Workflow`. A turn starts a workflow only through `X.intents(id)`, which records an outbox intent. Outside turns, calling the workflow on a handle returns a `WorkflowRun`.

`X.Workflow` MUST provide owner identity and caller attribution and owner-event `waitFor(Event, { where, timeout })`; activities and durable sleep use Effect's `Activity` and `DurableClock`. Execution identity MUST include deployment, tenant, owner actor and id, workflow member, and key. Resume MUST restore tenant and `onBehalfOf` from the durable envelope.

Accepted durable work MUST continue after its originating principal loses access, including trusted internal redelivery and workflow recovery. Revocation blocks new external admissions and result reads, not the recorded obligation. Cancellation is explicit, and applications MAY reauthorize sensitive steps. External command retry expiry MUST NOT discard pending internal work or its deduplication evidence; see [receipts](04-receipts.md) and [retention](../operations/retention.md).

External effects MUST be recorded in the turn and executed after commit with stable identity, retries, and dead-letter visibility. Cancellation cannot undo a completed provider call. Verification: **Workflow tenant isolation**, **waitFor registration**, **Intent rollback**, and **Singleton uniqueness** gates.

Executors live in `X.toEffectLayer`, take `(effect) => Effect`, receive `X.Executor`, and have no database capability. An executor's return value MUST be delivered to the effect's declared `onSuccess` command through the outbox, with the effect id as the command id. Exhausted retries MUST produce a dead letter and, when declared, deliver `onDeadLetter` once in a new actor turn ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)). A provider's ambiguous outcome MUST remain distinguishable from failure; unsafe retries require provider idempotency or reconciliation.

Workflow activities persist schema-defined results in `actor_workflow_step` on the owner's shard through the framework's `WorkflowEngine`, outside the originating actor turn; durable clocks are outbox timers. Their command identity derives from execution ID and activity name and remains stable across retries. Durable sleep and owner-event `waitFor` MUST survive restart; `waitFor` returns `Option.none` on timeout and closes the registration race.
