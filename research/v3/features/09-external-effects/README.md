# 09 — External effects

**Status:** accepted product capability; API and protocol below are proposed and unimplemented.

[Specification index](../../README.md) · [Decisions](../../DECISIONS.md) · [Sources](../../SOURCES.md) · [Ownership transfer](../10-ownership-transfer/README.md) · [Background work](../07-background-work/README.md)

## Product contract

Actors may arrange payments, email, model calls, and other provider work without doing network I/O inside a database turn. The source turn durably records an intent; `ctx.activities` executes it after commit and returns a durable result through a deduplicated command.

“Exactly once” means **one externally observable outcome**, and only when the provider and adapter offer an adequate idempotency or transactional protocol. It never means one process attempt, one HTTP request, or universal support for every API.

```diagram
┌──────────────── short source turn ────────────────┐
│ command + caller identity + request hash          │
│ business rows + effect intent + receipt           │
└──────────────────────┬────────────────────────────┘
                       │ commit, then retryable claim
                       ▼
┌──────────────── activity worker ──────────────────┐
│ stable operation key → provider call / lookup     │
│ classify succeeded · failed · unknown             │
└──────────────────────┬────────────────────────────┘
                       │ deduplicated completion command
                       ▼
┌──────────────── actor turn ───────────────────────┐
│ validate intent generation; apply durable result  │
└───────────────────────────────────────────────────┘
```

The database commit and outside world are separate authorities. A crash between provider success and local recording is expected. Reconciliation, not wishful retry counting, closes that gap.

## Proposed API

All names and types are sketches, not compiler-tested exports.

```ts
import { Actor, Context } from "durable-actors"
import { Effect, Schema } from "effect"

const Charge = Schema.Struct({
  orderId: Schema.String,
  cents: Schema.Int,
  paymentMethod: Schema.String,
})

const ChargePayment = Actor.activity("payments.charge", {
  input: Schema.Struct({ cents: Schema.Int, paymentMethod: Schema.String }),
  output: Schema.Struct({ providerChargeId: Schema.String }),
  run: Effect.fn(function* (input) {
    const ctx = yield* Context
    return yield* paymentProvider.charge({
      idempotencyKey: ctx.execution.id,
      amount: input.cents,
      paymentMethod: input.paymentMethod,
    })
  }),
})

export const Order = Actor.define({
  name: "order",
  commands: {
    charge: {
      input: Charge,
      handler: ({ orderId, cents, paymentMethod }) => Effect.gen(function* () {
        const ctx = yield* Context
        const order = yield* ctx.database.query.orders.findFirst({
          where: (o, { eq }) => eq(o.id, orderId),
        })

        if (!order) return yield* ctx.reject("OrderNotFound")

        yield* ctx.activities.start(ChargePayment, { cents, paymentMethod }, {
          id: `order:${orderId}:charge:${order.version}`,
          onSuccess: PaymentCaptured,
          onFailure: PaymentCaptureFailed,
          onUnknown: PaymentCaptureUnknown,
        })
      }),
    },
  },
})
```

Inside a command, `ctx.activities.start` records intent in the same transaction as actor-owned state. It does not call the provider. An activity receives an activity-phase context and cannot retain the turn-bound writer.

`paymentProvider` is a provider-aware adapter placeholder; completion commands are application placeholders. `ctx.execution.id` is stable across attempts and scoped to the full actor/execution identity. The adapter must preserve unknown outcomes and satisfy the protocol below; the example alone does not establish exactly-once behavior.

## Adequate provider protocols

An adapter may advertise outcome deduplication only for a documented protocol:

1. **Provider idempotency key:** one key identifies one immutable request; repeated calls return the same operation, and retention covers every supported retry and restore horizon.
2. **Transactional handoff:** a provider-controlled transaction atomically accepts the operation key and outcome, with a query API after ambiguous commits.
3. **Reconciliation:** after timeout or disconnect, retrieve an outcome by stable key. Lookup alone does not make creation exactly once: an absent result may race an in-flight or eventually visible operation. Retry needs provider-side unique creation/idempotency or a definitive proof that the original operation cannot still complete.

The operation record binds provider, account/tenant, caller identity, authorization decision, canonical request hash, adapter version, and operation key. Reusing a key with a different hash is a permanent conflict, not “already done.” Caller identity must not be silently replaced by the worker's service identity.

Provider keys with short or undocumented retention cannot support a longer framework guarantee. Local receipt retention must cover delayed delivery, retries, and recovery. Purging either side narrows the dedupe window and must be visible operationally.

## Outcome state machine

```diagram
pending ──claim──▶ attempting ──confirmed──▶ succeeded
   ▲                    │  │
   │ retry/reconcile    │  ├──definitive rejection──▶ failed
   └────────────────────┘  └──crash/timeout──────────▶ unknown
                                                       │
                                      provider lookup ─┴─▶ terminal / retry
```

`unknown` is durable and user-visible. It blocks an unsafe fresh operation until lookup, operator reconciliation, or a provider-specific proof establishes that retry is safe. A generic timeout must not become failure.

Cancellation is cooperative. It can prevent an unclaimed attempt, but cannot retract an already accepted provider outcome. Compensation is a distinct external effect with its own key and authorization.

## Failure and authorization limits

- Workers may retry; handlers and HTTP requests may execute multiple times.
- A committed source intent does not prove provider acceptance.
- A provider success does not prove the local completion command committed.
- Rate limits, provider outages, poison payloads, and expired credentials require bounded backoff and inspectable terminal/unknown states.
- Authorization is checked when intent is created and, where policy requires, again before execution. The record preserves which principal approved what.
- Secrets belong in scoped services/secret stores, never intent payloads, receipts, logs, or actor-visible SQL.
- Tenant and provider-account identity participate in dedupe keys and lookup scope.
- Operators need least-privilege reconcile, retry, cancel, and mark-resolved actions with audit records.
- Restoring the database can resurrect an intent whose outside outcome already occurred. Restore requires worker quiescence, recovery epoch fencing, provider lookup, and reconciliation before effects resume.
- Providers without immutable request binding or authoritative lookup receive at-least-once attempts and an explicit duplicate-risk label, not exactly-once marketing.

## Observability and retention

Expose intent age, attempt count, claim expiry, unknown duration, provider lookup result, completion lag, dedupe conflicts, and retention deadline. Logs correlate actor identity, intent ID, operation key hash, and recovery epoch without logging credentials or sensitive payloads.

Deleting actor business data does not automatically delete evidence needed to prevent duplicate outcomes. Retention and erasure policy must reconcile privacy obligations with provider dispute and dedupe windows; tombstones may retain only keyed hashes and minimum audit fields.

## Unresolved specifics

- Exact adapter interface, error algebra, retry defaults, and claim lease protocol.
- Which providers satisfy which guarantee and their verified key-retention periods.
- Canonical request encoding and hash migration across schema versions.
- Whether authorization refresh may invalidate an already committed intent.
- Reconciliation UX, operator override semantics, and compensation workflows.
- Recovery-epoch storage and how provider accounts are frozen during restore.
- Backpressure and fairness between tenants and effect classes.

## Falsifiable validation gates

1. Kill a worker before send, during send, after provider acceptance, and before completion commit; an adequate test provider shows one external outcome.
2. Return timeout after acceptance; lookup resolves the same operation without a second charge.
3. Reuse one operation key with a changed request, caller, tenant, or provider account; execution is rejected and audited.
4. Expire provider or local dedupe retention; the system withdraws the exactly-once claim and blocks or labels unsafe retry.
5. Restore a backup from before provider success; recovery fencing prevents replay until reconciliation imports the existing outcome.
6. Crash concurrent workers after lease expiry; claims may duplicate attempts but not outcomes under the advertised provider protocol.
7. Revoke credentials and authorization at each boundary; no worker broadens tenant access or leaks secrets.
8. Run a provider with no idempotency/lookup support; API and dashboard report at-least-once/unknown rather than exactly once.

Passing these gates would validate a particular adapter and retention configuration, not all external APIs. See [decisions](../../DECISIONS.md#advanced-capabilities-have-bounded-guarantees) for the governing limit.
