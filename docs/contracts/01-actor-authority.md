# Actor identity and authority

Status: partially normative (0.2), owned by ADR 0126. [E2 recovery](../verification/e2-recovery.md) promotes the create-once epoch fence, discard on loss, runner-only reassignment and Store-owned freshness; [E3 cluster evidence](../verification/e3-cluster.md) adds bucket-backed assignment and routed ownership for the `default` tenant. General address/tenancy and clock-discontinuity clauses remain proposal.

**Responsibility:** define what an actor is, where it lives, and what may change it.  
**Authority:** normative 0.2 target on `main`.  
**Owner role:** runtime architecture.  
**Change policy:** any authority change requires security review and adversarial tests.

## Address

An actor is addressed by `(tenant, type, id)` inside one store. The store is implicit: a runner MUST serve exactly one store. `type` is the name given to `Actor.make`; `id` MUST decode with the contract's `key` schema (default `Schema.String`); `tenant` MUST come from the transport ([security](10-security.md)) and is `"default"` for in-process code.

An actor's shard is `hash(tenant, type, id) mod shards`, where `shards` is fixed in the store's `meta/store` at creation. A shard holds actors of many tenants and types; membership in a shard MUST NOT be treated as a tenant boundary.

An actor exists once it has a durable command. A command on an id with no history runs against the decode of `{}` under the state schema. Reading the state, lists or views of an actor with no history MUST return that default state and MUST NOT write anything. There is no creation proof, `createdBy` gate or `NotCreated` failure.

## One writer per shard

- At most one owner MAY append to a shard at a time (I1). Ownership is established only by creating the shard's next log segment with a create-once write; the open offset is the owner's epoch ([storage](06-storage.md), [recovery](09-recovery.md)).
- A lease object, an Effect Cluster shard assignment, process memory, TypeScript types or routing ownership alone MUST NOT authorize an append, a reply or a publication.
- An owner whose append finds the next segment written by another owner MUST stop: drop every activation of the shard, publish nothing pending, and answer waiting callers with retryable `ShardMoved`.
- A fenced shard MUST remain closed to callers and autonomous restart. It MAY reopen on this runner only after the runner layer's `engine.assign` operation assigns the shard back; a caller touch, read, retry, or engine restart MUST NOT reopen it.
- An owner that has neither appended successfully nor verified within `T_valid` (10 seconds of elapsed time on its own clock) MUST verify before it appends or answers a read. After a detected clock discontinuity it MUST verify every owned shard before serving.
- Store MUST own the validity interval (`validFor`, default 10 seconds) and the lease's freshness. The engine MUST use Store freshness for reads and admission, including stored outcomes, and MUST verify an expired lease before using its cached state. It MUST NOT keep a second, independent validity interval.

## What may change an actor

- Actor state and lists MUST change only through a durable command entry in the actor's shard log: an `Action`, a fired timer or cron tick, a received send, a job's call, or an operator `Forked` entry.
- A command MUST NOT perform request/reply with another actor; it stages sends, timers, job starts and broadcasts ([commands](02-actions.md)). `X.client` MUST NOT be available inside a command, by type and at runtime.
- Views, state reads and list reads MUST NOT change state or stage effects.
- Jobs MUST change actor state only by calling commands ([background work](08-background-work.md)).

## Verification

I1 (one epoch appends), I2 (only the durable prefix is visible) and I8b (no command, read, send, `find` or fork crosses tenants); failures F7 (stale append after a move) and F8 (two runners believe they own a shard). [E3 cluster evidence](../verification/e3-cluster.md) complements E2b's fenced-shard scenarios with real ownership routing and readiness. This does not promote multi-tenant addressing beyond the currently served `default` tenant.
