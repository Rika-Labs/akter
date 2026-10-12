# ADR 0127: Snapshots, the page tree, lists, history and garbage collection in the store bucket

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** decide how actor state and lists are stored as immutable pages, how checkpoints reference them, how long history is kept, and how unreachable objects are deleted without ever deleting a reachable one.

**Owner role:** storage and runtime.

## Context

0.1 stores state as compressed keyed rows, optional cold objects behind a pointer on the generation row, blobs as `bytea` chunks and content as grant-gated rows ([ADR 0017](0017-m1-record-corrections.md), [ADR 0036](0036-cold-tier.md), [ADR 0114](0114-cold-tier-admission-and-garbage.md)). Size per actor is bounded by the database, and the cold tier is an opt-in second path.

In 0.2 every actor's durable state lives in the store's bucket ([ADR 0124](0124-engine-rewrite-and-command-log.md)). D23 makes state a `Schema.Struct` capped at 256 KiB without lists, with growing data in `Actor.list` fields. Pages are content-addressed and shared by hash, which makes forks cheap but makes garbage collection a correctness problem: in the engine plan's first design, a page skipped by `putIfAbsent` deduplication kept an old timestamp and could be swept while a new manifest referenced it.

## Decision

### 1. Pages and manifests

```text
pages/<sha256>    immutable page or manifest, written with plain PUT
gc/<epoch>        garbage-collection lease, created once
```

- A **page** is about 64 KiB of sorted, schema-encoded entries, keyed by the SHA-256 of its bytes (`Crypto.digest`). Its bytes are verified against its key on every read; a mismatch is the `PageCorrupt` defect, never a default value.
- An **actor manifest** holds the encoded state (lists excluded) and, per list, the root of its page tree. It is itself a page.
- A **checkpoint manifest** (`s/<nn>/cp/<inverted offset>`, [ADR 0126](0126-shard-ownership-on-the-bucket-log.md)) points at the actor manifests of its shard plus the shard state (timers, pending sends, jobs, deduplication buckets, connections, index pages).
- Pages and manifests are written with a **plain `PUT`**, never `If-None-Match`. Rewriting identical bytes is harmless and refreshes the object's last-modified time, which is what GC's grace period reads. A `412` or `429` on a content key is answered by `HEAD`; if the object exists with the expected length the write succeeded.
- Encoding at rest is `SchemaBinary` with a format version recorded in `meta/store` and in each segment; JSON is the wire encoding only.

### 2. State and lists

- State without lists is capped at 256 KiB encoded. An action whose resulting state exceeds the cap fails with the `StateTooLarge` defect, discarding its draft.
- `Actor.list(Item, { key?, by })` declares a list field. Its items live in a page tree ordered by `by` (then `key`), with no size limit. Actions use `put`, `get`, `delete`, `range({ from?, to?, limit?, reverse? })` and `deleteBefore(by)`; clients read `handle.<list>.range(...)` and watch it ([ADR 0130](0130-views-sessions-events-and-rpc.md)).
- An action that touches a list page not resident in memory stops with the internal `PageMiss(keys)`. The runtime loads the pages through a batching resolver (all pages a range needs in one batch, as far as the tree's interior nodes say) and reruns the action from the start. Nothing staged by the stopped run survives ([ADR 0125](0125-synchronous-deterministic-actions.md)).
- A snapshot uploads only changed pages, so its cost tracks the size of the change, not of the actor.

### 3. Retained history

- History is the shard's segments plus its checkpoints, kept for the store's retention period: 7 days by default; Akter Cloud sets 7 days on Free plans and 30 days on paid plans. Retention is one value per store in 0.2.0.
- Trim deletes segments older than retention and covered by a checkpoint older than `T_trim` ([ADR 0126](0126-shard-ownership-on-the-bucket-log.md)). Checkpoints older than retention are deleted except the newest one per shard. There is no separate archive copy: segments are the archive, so "archive before trim" holds by construction.
- History serves forks ([ADR 0132](0132-forks-and-retained-history.md)), log inspection ([ADR 0137](0137-inspection-audited-operations-telemetry.md)) and replay; it is not served to application clients.

### 4. Garbage collection

- **Roots** are every checkpoint manifest still within retention, plus the newest checkpoint of each shard. Everything reachable from a root (actor manifests, list pages, index pages) is live. Forks are reachable because their `Forked` entries and manifests are in their shard's checkpoints.
- **Lease.** A collector creates `gc/<n+1>` with `If-None-Match: *` after listing the newest `gc/<n>`; holding the newest key is the lease. Before each delete batch the collector checks that no newer `gc/` key exists, under the same `T_valid` rule as a shard owner. Two releases of one store therefore never sweep at once; no Cluster `Singleton` is used.
- **Mark and sweep.** The collector marks from the roots, then deletes only unmarked objects under `pages/` whose last-modified time is older than the grace period (default 24 hours, and always longer than twice the longest checkpoint interval plus `T_trim`).
- **Reuse rule.** A snapshot that references an existing page without rewriting it may only reference pages reachable from the actor's current durable manifest, which the mark protects until the new manifest is durable. Any other page is written again with plain `PUT`, refreshing its timestamp.
- GC lists `pages/` on a slow cadence and otherwise works from the previous mark, because listing is a billed operation on every provider.
- **Erasure.** An operator deletes an actor ([ADR 0137](0137-inspection-audited-operations-telemetry.md)); its pages become unreachable when the last retained checkpoint that references it ages out, and GC removes them after the grace period. Erasure of a whole tenant is a later decision.

### 5. Bucket rules for every provider

Never overwrite a create-once key; a `412` or `429` on a content key is verified with `HEAD`; an expired temporary credential (`403` with the provider's expired-token code) is refreshed and retried, not reported as unavailable; no provider-specific encryption headers; GC, not bucket lifecycle rules, expires history and pages.

## Supersedes and amends

- Supersedes [ADR 0036](0036-cold-tier.md) — scope: in full; every actor is snapshotted to the store's bucket.
- Supersedes [ADR 0114](0114-cold-tier-admission-and-garbage.md) — scope: in full.
- Supersedes [ADR 0120](0120-s3-adapter-entry.md) — scope: the `@rikalabs/akter/cold-storage/s3` entry; the rule that runtimes without S3 bundle no AWS or Smithy code carries in [ADR 0136](0136-stores-the-bucket-is-the-store.md).
- Supersedes [ADR 0017](0017-m1-record-corrections.md) — scope: the zstd state codec and its codec-version rule.
- Amends [ADR 0050](0050-operator-authority-and-audited-repair.md): repair targets become checkpoints, manifests and pages, through [ADR 0137](0137-inspection-audited-operations-telemetry.md).
- Amends [ADR 0111](0111-framework-verification-workspace.md): GC and page-integrity scenarios join the simulator.

## Alternatives

- **`putIfAbsent` for pages** (the engine plan's first design). Rejected: a deduplicated upload keeps the old timestamp and GC can sweep a page a new manifest references.
- **Bucket lifecycle rules for history.** Rejected: segments mix actor types and tenants, retention is per store, and lifecycle rules cannot see reachability.
- **A Cluster `Singleton` for GC.** Rejected: two overlapping releases are two clusters and would run two collectors over one bucket.
- **Per-tenant key prefixes.** Rejected: pages are shared by hash within a store; the tenant lives in manifests and log entries, and tenant isolation is the engine's job ([contract 10](../contracts/10-security.md)).
- **Unbounded state without lists.** Rejected: every snapshot would rewrite the whole state; the cap makes the rule mechanical.

## Consequences

- An actor's size is unbounded; a missed page costs one bucket round trip, plus one rerun of the action.
- A cold wake needs the checkpoint, the actor manifest and the pages its first action touches. On providers with tens of milliseconds of GET latency a runner-local page cache and manifest prefetch on session open are required features (risk R2 in the plan).
- Erasure completes after retention plus the grace period, which the Cloud data-handling terms must state.
- Fly egress applies to uploads from Fly to R2; snapshot cadence is a cost lever.

## Evidence

| Milestone | Evidence                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | I6 (a snapshot plus later entries equals the live state) and I7 (GC never deletes a reachable object) in the simulator, with GC added early and an adversarial interleaving of snapshot, fork and sweep |
| E2        | F9 (crash during checkpoint upload; crash between pages and manifest); plain `PUT` refreshes last-modified on MinIO and on the provider                                                                 |
| E6        | F20–F22 and F21′ (a snapshot that deduplicates against a page older than the grace period); `PageMiss` reruns; T4 restated for the provider and T5 (a missed page in a large list)                      |

## Revisit when

- Measurements show page size or checkpoint cadence costs dominate a store's bill.
- A provider's last-modified semantics differ under overwrite (the grace rule would need a written timestamp instead).
- Tenant-wide erasure or per-type retention is required.
