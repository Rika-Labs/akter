# 08 — Timers and cron

**Status:** durable future commands and recurring work are accepted product scope. Named replacement/cancellation and missed-tick policy remain unresolved. APIs and scheduler mechanisms below are **proposed and unverified**.

See the [v3 index](../../README.md), [decisions](../../DECISIONS.md), [commands](../03-commands-messaging/README.md), [background work](../07-background-work/README.md), and [operations](../15-operations/README.md).

## Accepted scope and guarantee boundary

A timer is a durable command intent with a not-before time. A command turn writes the timer in the same transaction as actor state and its receipt. After commit, a scanner makes due work eligible for ordinary command delivery.

Cron defines recurring discovery/work on a worker pool. A cron tick can send actor commands or start durable work; it does not receive actor-local write authority. Timers and cron are durable scheduling, not exactly-once wall-clock execution.

- A committed timer survives runner/process restart and actor passivation.
- Delivery is at least once internally and destination command IDs deduplicate retained logical deliveries.
- `deliverAt` is a lower bound under a stated clock model, not a latency deadline.
- Retries, leases, failover, and acknowledgement loss may create multiple execution attempts.
- Do **not** claim one actual execution per cron tick. At most, the design can identify one logical tick and deduplicate its durable consequences within retention boundaries.
- Named replacement/cancellation semantics and missed cron tick policy are intentionally open.

One `Context` name does not grant equal power: command-phase `ctx.timers` appends transactional intents; a timer scanner only claims/delivers runtime rows; a cron worker has pool capabilities and actor references, not a turn-bound database writer.

```diagram
command turn                 durable store                  delivery
state + timer intent ─COMMIT─▶ due_at + command ID ─claim─▶ actor inbox
                                  ▲                           │
cron definition ─ tick identity ──┴─▶ worker attempt ────────┘
                         retries may repeat attempts; receipts dedupe effects
```

## Proposed timer API

All APIs in this document are **proposed, incomplete, and not compiler-verified**.

```ts
const placeOrder = {
  input: PlaceOrderInput,
  handler: (input) => Effect.gen(function* () {
    const ctx = yield* Context
    yield* ctx.database.insert(orders).values({
      orderId: input.orderId,
      status: "placed",
    })

    yield* ctx.timers.after("30 minutes", CancelIfUnpaid.make({
      orderId: input.orderId,
    }), { id: `cancel-unpaid:${input.orderId}:${input.version}` })

    yield* ctx.timers.at(input.remindAt, SendReminder.make({
      orderId: input.orderId,
    }), { id: `reminder:${input.orderId}:${input.version}` })
  }),
}
```

`ctx.timers.after/at` write durable intents in the current turn. They do not contact a scheduler and do not execute inline. The timer command should still guard business state:

```ts
const cancelIfUnpaid = {
  input: CancelIfUnpaidInput,
  handler: ({ orderId }) => Effect.gen(function* () {
    const ctx = yield* Context
    const [order] = yield* ctx.database.select().from(orders)
      .where(eq(orders.orderId, orderId))
    if (!order || order.status !== "placed") return // stale delivery is harmless
    yield* ctx.database.update(orders).set({ status: "cancelled" })
      .where(eq(orders.orderId, orderId))
  }),
}
```

State-machine guards remain necessary even if cancellation is later added: a cancellation can race a claim, old delivery can be retried, and business state may independently make a timer obsolete.

## Unresolved named timers and cancellation

The historical proposal maps `(actor, name)` to a current message ID and uses a tombstone checked at fire time:

```ts
// Proposed design candidate only; semantics are not accepted.
yield* ctx.timers.replace("payment-reminder", {
  at: nextReminderAt,
  command: SendReminder.make({ orderId }),
})
yield* ctx.timers.cancel("payment-reminder")
```

Before accepting this API, specify whether replacement cancels only pending delivery or also a claimed attempt; what the caller observes when name/ID is absent; whether names are generation-scoped; how tombstones survive retry and retention; and which outcome wins in cancel-versus-fire races. Cancellation cannot undo a command already committed. An initially smaller API with fresh IDs plus handler guards may be preferable.

## Proposed cron definition

Cron is deployment-scoped recurring work, not owned by one actor instance. Its common shape is read-only SQL discovery followed by actor commands.

```ts
// Proposed, incomplete cron definition.
export const NightlyReconcile = Actor.cron("NightlyReconcile", {
  schedule: { expression: "0 3 * * *", timezone: "UTC" },
  pool: "maintenance",
  run: Effect.fn(function* (tick) {
    const ctx = yield* Context // cron/worker phase: authorized read-only database
    const stale = yield* ctx.database.select({ id: subscriptions.actorId })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.status, "active"),
        lt(subscriptions.renewsAt, tick.scheduledAt),
      ))

    yield* Effect.forEach(stale, ({ id }) =>
      ctx.actors.send(Subscription, id, Renew.make({ asOf: tick.scheduledAt }), {
        idempotencyKey: `NightlyReconcile:${tick.tickId}:${id}`,
      }), { concurrency: 64 })
  }),
})
```

`tickId` must derive canonically from definition identity, schedule version, timezone rules, and scheduled instant—not runner attempt. Repeated worker attempts reuse it. Every downstream command still needs a stable per-target ID; a cron-run row alone does not deduplicate partial fan-out.

Cron discovery can be expensive and, on Neki, cross-shard reads may not represent one global snapshot. Pagination must use stable continuation, bounded batches, and a declared `asOf`; handlers must tolerate changes between discovery and command execution. For very large fan-out, cron should start a job/workflow rather than retain an unbounded worker fiber.

## Time, lateness, and missed ticks

Scheduling uses a server-controlled UTC instant. Parsing a local timezone must pin a timezone database version and define daylight-saving gaps/overlaps. User/client clocks are untrusted input. Duration scheduling needs a recorded absolute `dueAt` so restart does not recompute from “now.”

The scanner may lease due rows with database time, process bounded batches, and recover expired claims. Notifications are hints; polling is the durable fallback. On Neki, timer rows and actor delivery intents must preserve actor-local transaction routing, while global cron coordination belongs to an explicit coordination domain.

Missed cron behavior is unresolved. Candidate policies include:

| Policy | Behavior after downtime | Risk |
| --- | --- | --- |
| Skip | Start with the next future tick | Lost periodic opportunities |
| Coalesce | Run one catch-up tick with a covered interval | Handler must understand interval semantics |
| Catch up | Enqueue each missed logical tick, with a cap | Thundering herd and stale work |

The policy may need to be definition-specific, but defaults, caps, observability, and schedule-change behavior must be decided before release. No example silently selects one.

## Failures, limits, and security

- A process can die after destination commit but before timer acknowledgement; retry must reuse the command ID and receipt lookup must prevent a second committed transition.
- Receipt/timer tombstone retention limits dedupe. Cleanup cannot remove protection while delivery or retry can still occur.
- Clock rollback/advance, database failover, scanner pauses, and pool saturation cause lateness. Publish measured lateness, not “on time” promises.
- Poison payload/version errors differ from transient database outages. Broad outages must not consume a tiny retry count and mass-dead-letter due timers.
- A hot deadline can create a retry storm. Bound claims, apply jitter where semantics permit, enforce per-tenant quotas, and expose oldest-due age.
- Cron code has least-privilege read access and actor-send capability; no direct business-table writes or administrative credentials.
- Authorization is checked when scheduling and again when executing commands as appropriate. Never let caller-selected actor addresses or cron names cross tenant boundaries.
- Schedule edits and deletion require audit history. Removing a definition must not ambiguously erase already materialized ticks.
- Backups restored into the past may resurrect schedules. Recovery epoch and reconciliation must prevent uncontrolled replay, especially where ticks start external effects.

## Open questions

1. Are named replace/cancel included in the first API, and what exact race/tombstone semantics apply?
2. What is the default and per-definition missed-tick policy, catch-up cap, and deployment-downtime behavior?
3. Which clock supplies due comparisons, and what skew/lateness service objective is supportable?
4. How are schedule edits versioned, especially across timezone database updates and rolling deploys?
5. How long are timer receipts, claims, logical tick rows, and cancellation tombstones retained?
6. What coordination design identifies logical cron ticks on Postgres and Neki without claiming global exactly-once execution?
7. What pagination/snapshot contract applies to cron discovery across Neki shards?

## Falsifiable validation gates

No runtime test is claimed here. Before timers or cron are called supported:

- Commit actor state plus a timer, kill before scheduler notification, and prove polling eventually delivers the same stable command ID with no partial turn.
- Kill a scanner before claim, after claim, after destination commit, and before acknowledgement; attempts may repeat but only one actor transition commits within retention.
- Race two scanners and expire one lease while its worker still runs; stale claims cannot corrupt acknowledgement or suppress due work.
- Race proposed replace/cancel against claim and commit for every ordering; observed outcomes match a published table. If not, omit the API.
- Pause scheduling across multiple cron ticks, then test skip, coalesce, and bounded catch-up candidates under load; choose and document one default without an unbounded burst.
- Exercise daylight-saving gap/overlap, leap-day, clock rollback/advance, schedule edits, and pinned timezone-version changes; each logical `tickId` is deterministic.
- Saturate one tenant with due timers and poison payloads; unrelated actors progress, outages remain retryable, and oldest-due age/lateness are observable.
- Restore a backup containing already-fired timers/ticks; recovery remains paused until the procedure proves downstream durable consequences are not blindly repeated.
