# 07 — Background work

**Status:** activities, jobs, workflows, worker pools, and agent composition are accepted actor-supporting features. They are not standalone adoption products. The APIs and engine mapping below are **proposed and unverified**.

See the [v3 index](../../README.md), [decisions](../../DECISIONS.md), [timers](../08-timers-cron/README.md), [blob storage](../06-blob-storage/README.md), and [external effects](../09-external-effects/README.md).

## Accepted scope and boundaries

- A command turn records `ctx.activities`, `ctx.jobs`, or `ctx.workflows` as durable intents in the same transaction as actor business writes and the command receipt.
- Workers run after commit. They do not retain the command transaction or its write authority.
- Completion is a command to the origin actor. That command performs all resulting business writes through directly yieldable `ctx.database`.
- Activities represent one external effect whose result matters to an actor; jobs represent throughput-oriented background computation; workflows coordinate durable multi-step procedures.
- Jobs and workflows support actors; this product is not positioned as a generic hosted job/function/workflow platform.
- Worker pools, durable sleep, deferred values, deterministic replay, and an agent composition path are required product directions. Exact APIs and Effect engine integration remain proposals.

One `Context` name does not mean equal authority: a turn can atomically append intents but cannot call the network; an activity receives external-I/O services but no turn writer; a completion turn receives actor-local write authority but not the prior worker fiber.

```diagram
actor command ── ONE COMMIT ──▶ durable intent ──▶ worker pool
 business rows                    execution ID        │
 receipt + intent                                      │ result / unknown
       ▲                                               ▼
       └──────── completion command ◀──────── durable completion
                    ctx.database writes + dedupe
```

## Activities

An activity has a stable execution ID across retries and runner crashes. Use that ID as the provider idempotency key when the provider contract supports it. A stable ID does **not** make an arbitrary effect exactly once. Provider acknowledgement lost after execution can produce an unknown outcome; see [external effects](../09-external-effects/README.md).

```ts
// Proposed, incomplete definition; not compiler-verified.
export const CapturePayment = Actor.activity("CapturePayment", {
  input: PaymentInput,
  output: PaymentReceipt,
  error: PaymentFailure,
  pool: "payments",
  retry: { maxAttempts: 8, backoff: "exponential", maxElapsed: "15 minutes" },
  timeout: "2 minutes",
  run: Effect.fn(function* (input) {
    const ctx = yield* Context
    const stripe = yield* Stripe
    return yield* stripe.capture(input, {
      idempotencyKey: ctx.execution.id, // stable for this logical activity
    })
  }),
})
```

```ts
// Proposed command turn: intent and local state commit together.
const ctx = yield* Context
yield* ctx.database.update(orders).set({ paymentStatus: "capturing" })
  .where(eq(orders.id, input.orderId))
yield* ctx.activities.start(CapturePayment, input, {
  id: `capture:${input.attemptId}`,
  onSuccess: PaymentCaptured,
  onFailure: PaymentCaptureFailed,
  onUnknown: PaymentCaptureUnknown,
})
```

Completion routes must carry the execution ID. Re-delivery is allowed; destination command receipts deduplicate the business transition. Terminal domain failure, exhausted retry, cancellation, timeout, decode defect, infrastructure outage, and unknown external outcome are distinct states—not one generic failure counter.

## Jobs and worker pools

Jobs handle render, export, crawl, indexing, or model-inference work where throughput isolation matters. A job may produce blobs and a result, but it cannot mutate business tables. If the result matters, a completion command validates it and performs the write.

```ts
// Proposed, incomplete job.
export const RenderInvoice = Actor.job("RenderInvoice", {
  input: RenderInvoiceInput,
  output: InvoiceRendered,
  pool: "media",
  retry: { maxAttempts: 5, delay: "10 seconds" },
  timeout: "10 minutes",
  run: Effect.fn(function* ({ orderId }) {
    const ctx = yield* Context // worker-phase Context, not command authority
    const order = yield* ctx.database.select().from(orderView)
      .where(eq(orderView.orderId, orderId)) // authorized read-only shared SQL
    const pdf = yield* renderPdf(order)
    const blob = yield* ctx.blobs.put(`invoices/${ctx.execution.id}.pdf`, pdf)
    return { blob }
  }),
})
```

```ts
// Proposed completion command performs the business write.
const invoiceReady = {
  input: InvoiceCompletion,
  handler: ({ orderId, executionId, blob }) => Effect.gen(function* () {
    const ctx = yield* Context
    yield* ctx.database.update(orders).set({ invoiceKey: blob.key })
      .where(eq(orders.id, orderId))
    // command ID / receipt deduplicates repeated completion delivery
  }),
}
```

Pools are logical queues with declared concurrency, resource class, authorization, retry class, and backpressure. Per-runner concurrency is not a global cap. Fairness, tenant quotas, priority, autoscaling, and poison-work isolation need an explicit scheduler contract. Cancellation is cooperative: it may interrupt local work but cannot undo a provider call or bytes already written.

## Workflows: durable time and replay

A workflow journal records stable step results, durable sleeps, deferred resolutions, signals, and deterministic time. On replay, completed steps return recorded results instead of running effects again. Workflow journal state coordinates work; it is not business truth.

```ts
// Proposed, incomplete workflow.
export const RefundWithApproval = Actor.workflow("RefundWithApproval", {
  input: RefundRequest,
  output: RefundOutcome,
  pool: "default",
  run: Effect.fn(function* (input) {
    const ctx = yield* Context
    const wf = ctx.workflows // workflow-phase journal operations
    const approval = yield* wf.deferred("finance-approval", ApprovalDecision)
    yield* wf.actors.send(Finance, "team", ApprovalRequested.make({
      token: approval.token,
      request: input,
    }))

    const startedAt = yield* wf.now // journaled, not wall-clock reread on replay
    const decision = yield* approval.await.pipe(wf.timeout("7 days"))
    if (decision._tag !== "Approved") return { status: "rejected" as const }

    yield* wf.sleep("5 seconds") // durable; consumes no resident actor turn
    const receipt = yield* wf.step("issue-refund", IssueRefund, input)
    yield* wf.actors.request(Order, input.orderId,
      RefundRecorded.make({ workflowId: wf.executionId, receipt }))
    return { status: "refunded" as const }
  }),
})
```

Workflow code between journal boundaries must be deterministic. Randomness, current time, network calls, mutable globals, and model calls belong in journaled steps/activities. Code evolution requires version markers or compatible replay; silently replaying old journals through changed control flow is unsafe.

Deferred tokens are scoped, unguessable capabilities. Resolving one from a command uses `ctx.workflows.resolve(...)` as a durable intent committed with that turn. Duplicate equal resolutions are idempotent; conflicting resolutions must be explicit errors without revealing another tenant's token.

## Durable agent composition

An agent is an actor whose conversation, budget, and accepted outputs are business state. Model/tool calls are activities; long plans are workflows; embeddings, exports, and document parsing can be jobs. The actor remains the sole mutation authority.

```ts
// Proposed command sketch.
const ctx = yield* Context
yield* ctx.database.insert(messages).values({ role: "user", content: input.text })
yield* ctx.workflows.start(RunAgentTurn, {
  conversationId: ctx.id,
  expectedVersion: input.version,
}, { id: `agent:${input.commandId}`, onComplete: AgentTurnCompleted })

// AgentTurnCompleted validates version/budget, then writes through ctx.database.
```

Tool effects with uncertain outcomes use stable activity IDs and provider-aware reconciliation. A replay must never silently invoke a tool again merely because the worker crashed.

## Failures, limits, and security

- Delivery and completion may be retried. Promise one committed actor transition per retained command ID, not one worker attempt.
- Retention bounds dedupe. Execution IDs that outlive tombstones can run again; permanent business IDs and provider records may be required.
- Worker crashes after an effect but before journaling can leave `unknown`; automatic retry is unsafe unless the effect is idempotent/reconcilable.
- Database restore cannot roll back providers. Pause workers and reconcile external outcomes before resuming.
- Worker SQL is authorized read-only shared access; no raw privileged client, actor writer, or retained turn connection is available.
- Validate schemas at intent, worker input, journal, result, signal, and completion boundaries. Encrypt secrets; never journal credentials or raw sensitive model prompts by default.
- Enforce tenant quotas, payload/result sizes, timeout, heartbeats, egress policy, and pool isolation. Sandboxing untrusted user code is outside this in-process model.
- Workflow histories can grow without bound; compaction/snapshotting must preserve replay and audit semantics before histories are pruned.

## Open questions

1. Which Effect workflow/activity APIs are stable enough, and where does the framework require an adapter?
2. What are default retry, timeout, heartbeat, retention, and unknown-outcome policies per work class?
3. How are workflow code versions pinned across rolling deploys and long sleeps?
4. What scheduler provides global pool caps, fairness, tenant quotas, priority, and starvation resistance?
5. What cancellation states and completion races are externally observable?
6. Which job reads are snapshot-consistent on Postgres versus cross-shard Neki?

## Falsifiable validation gates

No runtime test is claimed here. Before support is advertised:

- Commit business state plus each intent, crash before publication, and prove polling starts exactly the committed logical execution with the stable ID.
- Kill workers before provider call, after provider success, before result journal, and during completion delivery; observe deduplicated writes and explicit `unknown` where reconciliation cannot decide.
- Replay a workflow containing steps, durable sleep, deferred resolution, signals, and journaled time; completed effects do not execute again and output is identical.
- Deploy compatible and incompatible workflow code while executions sleep; compatible histories resume and incompatible histories stop visibly rather than diverge.
- Race cancellation, timeout, retry, and successful completion; publish the deterministic state transition and show no completion bypasses actor command authority.
- Saturate one tenant/pool with slow work; configured bounds hold, unrelated pools progress, and queue age/backpressure are observable.
- Run an agent crash/replay scenario with a mocked non-idempotent tool; the tool is not silently repeated and the actor records/reconciles unknown outcome.
- Restore from a backup predating a mocked external effect; workers remain paused until reconciliation prevents duplicate external work.
