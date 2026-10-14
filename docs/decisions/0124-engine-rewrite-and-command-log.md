# ADR 0124: Engine rewrite, the clean 0.2 break and the command log

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** decide that Akter 0.2 replaces the per-command Postgres transaction engine with an engine whose source of truth is an ordered command log per shard, name the store as the unit of durability, and register what happens to every earlier decision.

**Owner role:** runtime architecture.

## Context

Akter 0.1 runs every command as its own framework-owned Postgres transaction in the application's database: a generation row fence, a receipt row, keyed state rows, an outbox table and a relay ([ADR 0011](0011-direct-commands-outbox-and-performance.md), [ADR 0020](0020-two-round-trip-turn-pipeline.md), [ADR 0072](0072-served-command-in-two-round-trips.md), [ADR 0084](0084-cross-actor-group-commit.md), [ADR 0115](0115-warm-actor-fast-path.md)). Its throughput and latency are bounded by database round trips per command, its storage is bounded by what the application's database holds, and its handler model lets application code run SQL and I/O inside the commit.

The 0.2 plan (Dallen's decisions D1–D24, 2026-10-12) replaces that engine. Three facts shape this record:

1. **The noun for durable storage was wrong.** The 0.1 framework calls the installation on one database a "deployment", while Akter Cloud calls one release a deployment ([ADR 0075](0075-deployment-and-runner-orchestration.md)). Keying shards or objects by release would start every redeploy from an empty store.
2. **The bucket is the only storage dependency** (D18). Log, fence, checkpoints, pages, index and cluster bookkeeping live in one S3-compatible bucket per store. Nothing in the framework talks to Postgres.
3. **There are no external users to migrate** (D5). The alpha deployments redeploy fresh, and the rewrite happens in place on the long-lived `rewrite/0.2` branch while `main` stays on 0.1 until the swap (D7).

## Decision

### 1. The store

A **store** is the durable home of one application's actors: one bucket and its configuration, recorded once in the object `meta/store` (store id, shard count, format version, created-at, retention). It replaces the 0.1 "deployment" in every storage and sharding role. In Akter Cloud a store is one environment incarnation (D1); self-hosted, it lives as long as the operator keeps the bucket. A runner serves exactly one store, so the store is implicit in every address.

| Concept       | Definition                                                                                                                                   | Not part of                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Store         | One bucket plus `meta/store`                                                                                                                 | —                                         |
| Tenant        | The application's own partition, set only by the transport, `"default"` for in-process code ([ADR 0059](0059-caller-and-tenant-defaults.md)) | object keys, shard ids                    |
| Actor address | `(tenant, type, id)` inside one store                                                                                                        | —                                         |
| Shard         | `hash(tenant, type, id) mod shards`, `shards` fixed in `meta/store` (default 16)                                                             | tenant isolation: one shard mixes tenants |
| Release       | One build of the application running against a store; its build id is recorded on every log segment                                          | any storage key                           |

### 2. The command log is the source of truth

Each shard has an ordered log of segments in the store's bucket ([ADR 0126](0126-shard-ownership-on-the-bucket-log.md)). A segment holds the entries of one group-committed batch. An actor's state is a cache rebuilt from the newest checkpoint plus the entries after it. The entry kinds are:

| Entry                                    | Records                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Open`                                   | a new owner took the shard; its offset is the owner's epoch                                                           |
| `Action`                                 | actor, command id, member, payload, caller, admission time, build, outcome, staged effects                            |
| `Fired`                                  | a timer or cron tick firing with its derived command id                                                               |
| `Delivered` / `Received`                 | a cross-shard send acknowledged by, or applied on, the receiving shard                                                |
| `JobStarted` / `JobStep` / `JobFinished` | job journal progress ([ADR 0129](0129-jobs-timers-and-shard-workflow-engine.md))                                      |
| `Forked`                                 | an actor created from another actor's history ([ADR 0132](0132-forks-and-retained-history.md))                        |
| `Audit`                                  | an operator mutation, in the same segment as its effect ([ADR 0137](0137-inspection-audited-operations-telemetry.md)) |
| `Released`                               | a drained owner gave the shard up for handoff                                                                         |

Every `Action` entry stores its outcome, so replay verifies determinism: an entry whose replayed outcome differs is a `ReplayMismatch` defect that stops the shard.

### 3. Nothing is visible before it is durable

No reply, event, view update, index change, cross-shard delivery or job start is observable before the segment that holds its entry exists in the bucket. Speculative state (the result of actions whose segment is not yet durable) is never authority and never published. [Contract 03](../contracts/03-durability.md) states the rule normatively.

### 4. The clean break

0.2 starts empty. There is no `akter migrate`, no importer of 0.1 rows, and no compatibility with 0.1 wire frames, receipts or SQL tables. The 0.1 command-id format `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>` survives as the external id; derived ids become UUIDv8 ([contract 03](../contracts/03-durability.md)).

### 5. Branch authority and retirement of 0.1 evidence

On `rewrite/0.2`, ADRs 0124–0137 and the contracts whose status line reads "proposal (0.2)" define the target. 0.1 code still on the branch is being replaced milestone by milestone (E1–E8). A proposal contract is promoted (its status line becomes normative) when the failure evidence of its milestone lands. On `main`, the 0.1 records and contracts stay authoritative until the swap, at which point old ADRs gain status lines and keep their bodies.

A 0.1 behavioral test or conformance group may be deleted from the branch only when one of these is true and the deleting change names it: its guarantee is restated in a 0.2 contract and a 0.2 test rejects the same wrong implementation; or an accepted 0.2 ADR removes the behavior ([ADR 0134](0134-removing-owned-tables-and-placement.md) for owned tables, adoption, blobs, content, placement and subscriptions; [ADR 0128](0128-constrained-actor-api.md) for the 0.1 API). Dated evidence pages stay as history and are never edited to read as 0.2 results.

## Supersedes and amends

Lists use the corrected mapping of the 0.2 documentation audit. A scoped supersession leaves the rest of the older record standing.

- Supersedes [ADR 0011](0011-direct-commands-outbox-and-performance.md) — scope: in full (receipt as admission record, actor outbox, pipelined turn batches, reducers and replica reads).
- Supersedes [ADR 0020](0020-two-round-trip-turn-pipeline.md) — scope: in full.
- Supersedes [ADR 0071](0071-fair-pools-query-pool-and-early-turn-release.md) — scope: in full.
- Supersedes [ADR 0072](0072-served-command-in-two-round-trips.md) — scope: in full.
- Supersedes [ADR 0084](0084-cross-actor-group-commit.md) — scope: in full (per-actor SQL group commit; per-shard batching replaces it).
- Supersedes [ADR 0115](0115-warm-actor-fast-path.md) — scope: in full (the warm SQL command path).
- Supersedes [ADR 0038](0038-retention-cleanup-and-receipt-horizon.md) — scope: receipt and event sweeps, `keepReceipts` and the receipt horizon.
- Supersedes [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) — scope: §6 commutative merging.
- Amends [ADR 0001](0001-repository-structure.md): the source tree under `packages/akter/src` is rebuilt in place; the one-package and license boundaries stand.
- Amends [ADR 0002](0002-v4-contract-clarifications.md): the relational transaction, outbox and JSONB model ends; explicit contract authority stands.
- Amends [ADR 0003](0003-failure-scoping-drain-and-hosted-trust.md): rollback becomes discard of staged effects; bounded drain and signed hosted assertions carry ([contract 09](../contracts/09-recovery.md), [contract 10](../contracts/10-security.md)).
- Amends [ADR 0004](0004-receipt-access-revocation-and-expiry.md): original-caller access, revocation and enforceable expiry carry onto stored outcomes ([contract 03](../contracts/03-durability.md)).
- Amends [ADR 0005](0005-turn-latency-batching-and-regional-placement.md): the turn model ends; one region per store replaces tenant home regions ([ADR 0136](0136-stores-the-bucket-is-the-store.md)).
- Amends [ADR 0007](0007-foundation-command-protocol.md): the external command-id shape, caller attribution and expiry carry; generation and receipt implementation end.
- Amends [ADR 0008](0008-foundation-completion.md): the `System` caller and the failure taxonomy carry; PGlite and transaction timeouts end.
- Amends [ADR 0013](0013-m0-reconciliation.md) and [ADR 0014](0014-adoption-observation-and-client-reach.md): their shipped-status lists and product order describe 0.1.
- Amends [ADR 0029](0029-licence-package-name-and-release-policy.md): package entries become `.`, `./server` and `./testing`; Apache-2.0, the scope and trusted publishing carry; `0.2.0-rewrite.<run>.<attempt>.g<sha12>` prereleases publish from the branch under the `rewrite` dist-tag, which never moves `next` or `latest`.
- Amends [ADR 0052](0052-read-your-writes-commit-versions.md): WAL-position tokens end; read-your-writes holds because the shard owner serves reads ([contract 07](../contracts/07-realtime.md)).
- Amends [ADR 0111](0111-framework-verification-workspace.md): conformance stays outside the published package; its suites become the seeded simulator, the bucket-protocol integration suites and the benchmark driver.

## Registry of earlier decisions

Every numbered framework ADR has one row. "Superseded" and "amended" name the 0.2 record that owns the change; "unchanged" means the decision holds on the branch as written; "historical" means it was already superseded before 0.2 and is not superseded again.

|       ADR | 0.2 fate                                                                                               | Owner                              |
| --------: | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
|      0001 | amended (tree)                                                                                         | 0124                               |
|      0002 | amended (transaction model ends)                                                                       | 0124                               |
|      0003 | amended (rollback, drain, hosted trust)                                                                | 0124, 0126                         |
|      0004 | amended (outcome access, expiry)                                                                       | 0124                               |
|      0005 | amended (turn model, home regions)                                                                     | 0124, 0126                         |
|      0006 | superseded in part: due scans 0126, query tiers 0131, placement and routing keys 0134                  | 0126, 0131, 0134                   |
|      0007 | amended (command-id shape carries)                                                                     | 0124                               |
|      0008 | amended (System caller, defects carry)                                                                 | 0124, 0125                         |
|      0009 | unchanged                                                                                              | —                                  |
|      0010 | superseded                                                                                             | 0128                               |
|      0011 | superseded                                                                                             | 0124                               |
|      0012 | superseded in part: §1 and §3 0129, §2 0128, §5 0134, §6 0124; §4 amended by 0125; §7 amended by 0136  | 0124, 0125, 0128, 0129, 0134, 0136 |
|      0013 | amended (status record)                                                                                | 0124                               |
|      0014 | amended: status 0124, client reach 0128, adoption 0134                                                 | 0124, 0128, 0134                   |
|      0015 | historical (superseded by 0017); fork wording replaced by 0132                                         | 0132                               |
|      0016 | unchanged (exploratory; not 0.2 scope)                                                                 | —                                  |
|      0017 | superseded in part: codec 0127, placement 0134                                                         | 0127, 0134                         |
|      0018 | historical                                                                                             | —                                  |
|      0019 | amended (`RunnerAtCapacity` carries; pool budget ends)                                                 | 0126                               |
|      0020 | superseded                                                                                             | 0124                               |
|      0021 | superseded                                                                                             | 0129                               |
|      0022 | superseded                                                                                             | 0129                               |
|      0023 | superseded                                                                                             | 0130                               |
|      0024 | superseded                                                                                             | 0129                               |
|      0025 | superseded (public mint and `createdBy`); deterministic child ids carry in 0125                        | 0128                               |
|      0026 | superseded                                                                                             | 0128                               |
|      0027 | superseded in part (wire and routes); auth and readiness carry                                         | 0130                               |
|      0028 | superseded                                                                                             | 0137                               |
|      0029 | amended (entries, release line)                                                                        | 0124, 0128                         |
|      0030 | superseded                                                                                             | 0130                               |
|      0031 | amended (one region per environment; assertions carry)                                                 | 0136, 0130                         |
|      0032 | amended (stored event and effect versions end; state evolution carries)                                | 0128, 0133                         |
|      0033 | superseded                                                                                             | 0134                               |
|      0034 | superseded                                                                                             | 0134                               |
|      0035 | superseded in part (production backend claim)                                                          | 0136                               |
|      0036 | superseded                                                                                             | 0127                               |
|      0038 | superseded in part (receipt horizon)                                                                   | 0124                               |
|      0040 | unchanged                                                                                              | —                                  |
|      0041 | historical                                                                                             | —                                  |
|      0042 | amended (cron zones, intervals and DST carry onto the timer wheel)                                     | 0129                               |
|      0043 | unchanged (docs process); nav changes follow 0124's pages                                              | —                                  |
|      0044 | superseded                                                                                             | 0134                               |
|      0045 | amended (cookie credentials apply to `/rpc` over HTTP)                                                 | 0130                               |
|      0046 | superseded                                                                                             | 0129                               |
|      0047 | superseded                                                                                             | 0128                               |
|      0048 | amended (mint, progress and inspection corrections are historical)                                     | 0125, 0130, 0137                   |
|      0049 | amended (stable names carry where meaningful)                                                          | 0137                               |
|      0050 | amended (operator grants and audited repair carry)                                                     | 0137                               |
|      0051 | superseded in part (RLS as actor-data authority); storage isolation amended                            | 0134, 0136                         |
|      0052 | amended (WAL token ends)                                                                               | 0124, 0130                         |
|      0053 | amended (readiness carries)                                                                            | 0130                               |
|      0054 | superseded                                                                                             | 0134                               |
|      0055 | superseded                                                                                             | 0130                               |
|      0056 | superseded                                                                                             | 0131                               |
|      0057 | historical (superseded by 0112)                                                                        | —                                  |
|      0058 | superseded                                                                                             | 0130                               |
|      0059 | amended (caller and tenant carry; global `authorize` removed; default access changes)                  | 0128, 0130                         |
|      0060 | superseded (closed as not accepted for 0.2)                                                            | 0130                               |
|      0061 | historical                                                                                             | —                                  |
|      0062 | amended (scale to zero needs drain-time checkpoints and `nextDue`)                                     | 0126, 0129                         |
|      0063 | superseded (items 1–6 replaced by the constrained API)                                                 | 0128                               |
|      0066 | superseded (fence mechanism); "a lease alone is never authority" carries                               | 0126                               |
|      0067 | superseded                                                                                             | 0126                               |
|      0068 | superseded (runner layout); socket runners, mTLS and readiness carry                                   | 0126                               |
|      0069 | amended (Node and Bun carry for every new layer)                                                       | 0135, 0136                         |
|      0070 | historical (superseded by 0112)                                                                        | —                                  |
|      0071 | superseded                                                                                             | 0124                               |
|      0072 | superseded                                                                                             | 0124                               |
|      0074 | amended (Cloud successors own hosted decisions)                                                        | 0136                               |
|      0075 | amended (no database probe; store readiness)                                                           | 0136                               |
|      0077 | amended (bounded refusal carries; Cluster mailbox and pool details end)                                | 0126                               |
|      0080 | unchanged                                                                                              | —                                  |
|      0084 | superseded                                                                                             | 0124                               |
|      0085 | amended (inspect, log, snapshot, fork, replay replace old operator commands)                           | 0137                               |
|      0086 | amended (SAN names store and release)                                                                  | 0130                               |
|      0087 | superseded (recorder); live telemetry restated                                                         | 0137                               |
| 0091–0097 | historical (superseded by 0112); not superseded again                                                  | —                                  |
|      0098 | amended (deferred client packages)                                                                     | 0128                               |
|      0103 | amended (removed client surfaces)                                                                      | 0128                               |
|      0109 | amended (self-host is one bucket)                                                                      | 0136                               |
|      0110 | historical (superseded by 0112)                                                                        | —                                  |
|      0111 | amended (verification workspace)                                                                       | 0124                               |
|      0112 | superseded in part: backend sentence 0136, routing-key and placement clauses 0134; Neki removal stands | 0134, 0136                         |
|      0113 | superseded                                                                                             | 0136                               |
|      0114 | superseded                                                                                             | 0127                               |
|      0115 | superseded                                                                                             | 0124                               |
|      0117 | superseded (turn lock authority); pooler evidence historical                                           | 0126                               |
|      0119 | superseded (transaction pooling for turns)                                                             | 0126                               |
|      0120 | superseded (cold-adapter entry); the no-AWS-in-the-root bundling rule carries                          | 0127, 0136                         |
|      0121 | amended (the exact 4.0.3 cohort carries; SQL packages leave it)                                        | 0135                               |
|      0122 | amended (suspend-safe time carries onto owner validity)                                                | 0126                               |
|      0123 | amended (request identity carries onto views and sessions)                                             | 0130                               |

## Alternatives

- **Side-by-side `packages/engine`** with parity tests against 0.1. Rejected by D7: the two engines share no semantics to compare, and two engines on one branch would mean two sets of true contracts.
- **Keep the per-command transaction engine and optimize it.** Rejected: the 0.1 warm path and cross-actor group commit already reached one commit flight per command; the next order of magnitude needs batched durability per shard and synchronous actions.
- **A Postgres log with objects for snapshots only** (D3). Superseded by D18: one storage dependency, no database to size or connect to, the same code in Cloud, self-host and `akter dev`.
- **An importer for 0.1 data.** Rejected by D5: no external users, and an importer would freeze 0.1 semantics into 0.2.
- **Keep "deployment" as the storage noun.** Rejected: it collides with the Cloud release and would reset stores on every redeploy.

## Consequences

- About half of the 0.1 tree is deleted on the branch, a third rewritten. The root entry imports no SQL, cluster or storage module.
- Per-action latency equals the store's PUT latency plus queueing (T1 restated in D20). Throughput rises with batch size.
- Contracts 02, 03, 04 and 06 are renamed or merged; links and redirects move with them.
- The registry above is the only place a reader needs to learn the 0.2 fate of an earlier record until the swap adds status lines.
- Cloud documents name these records as "framework ADR 01xx" because the Cloud repository uses the same numbers for unrelated decisions.

## Evidence

| Milestone | What proves this record                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | Seeded simulator on the memory store: invariants I1–I9 on 1,000 seeds, failures F1–F5, double-run determinism on Node and Bun                |
| E2        | `Store.s3` against MinIO in CI and the chosen provider nightly: F6–F12, the ambiguous-append case and T1/T2 measured with the provider named |
| E3–E7     | The failure rows each owning ADR names; T7 at 10,000 seeds before 0.2.0                                                                      |
| Swap      | Contracts, API pages, support matrix and evidence indexes agree with tested 0.2; docs nav and link checks pass                               |

## Revisit when

- The T5 probe or E2 measurements show the chosen provider cannot meet D20's latency statement or fails the conditional-create race (D21 names Tigris as the fallback; the engine does not change).
- A customer needs migration from 0.1 data, which would need its own ADR.
- A second log backend is proposed; it must keep the `Log` interface and pass the same failure suites.
