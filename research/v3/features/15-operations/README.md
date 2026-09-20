# 15 — Dashboards, security and operations

**Status:** operational capabilities retained from the product inventory; exact CLI commands, auth token format and defaults are proposals.

[Index](../../README.md) · [Decisions](../../DECISIONS.md) · [Blobs](../06-blob-storage/README.md) · [External effects](../09-external-effects/README.md)

## Operate through the same contracts

```diagram
┌──────────────────────┐       ┌──────────────────────────┐
│ Console / CLI / tools│──────▶│ Authorized actor commands │
│                      │──────▶│ Shared read-only SQL      │
└───────────┬──────────┘       └──────────────────────────┘
            │ explicit administrative privilege
            ▼
┌─────────────────────────────────────────────────────────┐
│ Migration / repair / reconcile / purge                   │
│ audited · coordinated with runtime · narrowly authorized │
└─────────────────────────────────────────────────────────┘
```

## Dashboards and inspection

- Discover actor types/identities and registered business tables.
- Read actor state and cross-actor SQL without requiring a publication layer.
- Inspect pending messages, receipts, events, timers, outgoing delivery and durable work.
- Display actor timeline, hot actors, queue depth/age, unknown effects, live-query lag/resync and transfer phase.
- Observe gateway connections, activation state and cache versions without implying ephemeral state is durable truth.
- Invoke authorized commands from dashboards; ordinary field editors must not bypass actor logic.

```ts
// Proposed self-hostable admin UI registration, not a runtime export today.
const console = Console.define({
  actors: [Chat, Board],
  authorize: operatorPolicy,
  dashboards: {
    roomActivity: Effect.gen(function* () {
      const ctx = yield* Context
      return yield* ctx.database.select({
        room: messages.actorId,
        messages: count(),
      }).from(messages).groupBy(messages.actorId).limit(100)
    }),
  },
})
```

This example relies on enforced read authorization, not on the SQL remembering a tenant predicate. `operatorPolicy` is an application/deployment policy placeholder.

## Proposed CLI

```sh
actors dev
actors migrate --dry-run
actors doctor
actors inspect chat/general
actors events chat/general --follow
actors jobs status <execution-id>
actors transfers status <transfer-id>
actors effects reconcile <operation-id>
actors deadletters inspect <message-id>
```

Names are sketches. Replay, discard, purge, repair, migration application and reconciliation overrides require explicit privileges and auditable actions. Running a command twice must not casually mint a new business operation identity. No CLI was implemented here.

## Authentication and authorization

Trusted context binds deployment/project, tenant, actor type/ID and principal. Authorize commands, queries, subscriptions, signals, blob access and transfer acceptance separately. A browser-selected actor address is not authority.

Historical signed grants are one option; grants-only auth and exact scope syntax are not settled requirements. Internal commands and runtime tables are not public mutation APIs. Administrative roles are separate from turn execution and read-only observation roles.

Do not log credentials or sensitive payloads by default. Redact signed URLs/resume tokens. Tenancy layout is unresolved: row policies, schema isolation and database isolation have different scaling and security costs. A trusted-handler architecture must not be sold as a hostile-code sandbox.

## Limits and telemetry

Correlate command, actor, event, activity, workflow, transfer and connection identities through structured logs/traces. Track rates, latency, errors, queue age, connection-pool waits, database saturation and recovery lag. Avoid unbounded actor-ID metric labels.

Admission limits cover tenant rate, actor mailbox depth, payload size, worker concurrency, blob upload size, live-query cost, replay, resident caches and gateway buffers. Infrastructure outage should not turn into a retry storm or mass dead-lettering under a tiny generic defect counter.

## Migrations, retention and restore

- Version business schema, protocol, stored payloads, workflow history, actor identity/routing and adapter contracts.
- Expand/deploy/backfill/contract with compatibility checks; schema changes invalidate affected live-query plans.
- Ordinary backfills use actor commands where they change business facts; privileged migration paths explicitly coordinate with runtime ownership and event/cache/change feeds.
- Retention for receipts, events, intents, workflows, transfers and blob references is interdependent. Do not prune dedupe evidence while dependent delivery can still retry.
- Actor purge must handle queued work, gateway tokens, blobs, transfer tombstones and future reuse of the identity.
- Restore is not just replaying a database backup. Quiesce effects and reconcile external outcomes, transfer authority and epochs before enabling execution.

## Validation gates

1. Attempt write/DDL/TRUNCATE/role escalation as an observation client; permissions prevent mutation, not just a default read-only flag.
2. Test operator roles with overlapping and disjoint tenants; inspect/replay/purge cannot cross scope.
3. Inspect logs, telemetry and dashboard payloads for provider secrets, tokens and signed URLs.
4. Interrupt a migration on one Neki shard; incompatible application code is blocked and partial status is visible.
5. Restore before a successful external payment or ownership release; reconciliation prevents duplicated effect or dual authority.
6. Retain a pending delivery beyond ordinary cleanup age; necessary receipt/tombstone evidence remains.
7. Overload mailboxes, live queries and connections independently; users/operators see bounded rejection and actionable recovery state.
