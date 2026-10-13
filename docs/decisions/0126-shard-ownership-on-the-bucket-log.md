# ADR 0126: Shard ownership on the bucket log

Status: proposed, 2026-10-12 (rewrite/0.2).

E2b implements the engine/store boundary. E3 adds bucket-backed Cluster routing and handoff as described below. The release-to-store peering amendment remains an explicit captain question; clock-suspension and production-provider claims are not established by this evidence.

**Responsibility:** decide how a runner becomes the one writer of a shard, how batches become durable in the store's bucket, how a stale owner is fenced, how admission is bounded, and how a shard moves between releases.

**Owner role:** runtime architecture and reliability.

## Context

0.1 fences writers per actor with a generation row locked by `SELECT ... FOR UPDATE` in every command transaction ([ADR 0066](0066-authoritative-coordination.md)), schedules due work by scanning bucket ranges ([ADR 0067](0067-due-work-shard-ranges.md)), coordinates runners through Effect Cluster's SQL runner storage and advisory locks ([ADR 0068](0068-production-multi-runner.md), [ADR 0117](0117-pooler-safe-locking.md), [ADR 0119](0119-transaction-pooling.md)), and sheds load with runner admission and pool checkout bounds ([ADR 0077](0077-admission-control.md)).

D18 makes the store's bucket the log, the fence and the cluster bookkeeping. The one property the design rests on is that two concurrent create-once writes (`PUT` with `If-None-Match: *`) to the same key never both succeed. AWS S3, MinIO and Tigris document it; Cloudflare R2 supports the header but does not document atomicity under concurrency, which the T5 probe tests (64 writers × 10,000 rounds, zero double successes required). `akter storage check` makes the same test part of what "supported store" means ([ADR 0136](0136-stores-the-bucket-is-the-store.md)).

## Decision

### 1. Keys

```text
s/<nn>/log/<offset>          segment, created once; offset is 16 lowercase hex digits
s/<nn>/cp/<inverted offset>  checkpoint manifest, created once; 0xFFFF_FFFF_FFFF_FFFF − offset in 16 hex digits
```

`<nn>` is the shard number in two hex digits (`00`–`ff`; a store has at most 256 shards). The inverted offset makes an ascending list with `max-keys=1` return the newest checkpoint. A segment is `{ format, writer, open, build, entries }`, where `writer` is the runner id, `open` is the owner's epoch and `build` is the release's build id ([ADR 0133](0133-build-matched-replay.md)).

### 2. Opening a shard: the epoch is an offset

1. List `cp/` with `max-keys=1`: newest checkpoint `C` at offset `L` (none for a new shard).
2. List `log/` after `log/<L>`: the tail `L+1 … H`, which must be gapless.
3. Load `C`'s shard state and replay the tail. The head is `H`.
4. Create `log/<H+1>` holding one `Open` entry. A `412` means another runner moved first: list again from `H` and retry a bounded number of times, then give the shard up.
5. The lease is `{ shard, open: H+1, head: H+1 }`. The epoch is the open offset; there is no counter anywhere else.

A runner owns a shard only while its lease is valid (§5). Effect Cluster's shard assignment decides who should try to open a shard; it never decides who may write ([ADR 0135](0135-effect-primitive-inventory.md)).

### 3. Appending: create-once is the fence

The owner appends one batch per segment: `PUT log/<head+1>` with `If-None-Match: *`.

- Success: the batch is durable; `head` advances.
- `412`: read the existing segment's header. If `writer` and `open` are this owner's, the write is our own whose response was lost: treat it as success. Otherwise the owner has lost the shard (`StaleEpoch`): it drops every activation of the shard, publishes nothing pending, and answers waiting callers with retryable `ShardMoved`.
- Timeout or connection loss: retry the identical `PUT` (same key, same bytes); the header check above makes the retry idempotent. When retries are exhausted the outcome is unknown: the owner stops admitting to the shard, drops its activations without publishing, and closes the shard. The next open, by any runner, lists the log and learns whether the segment exists; callers retry with the same command id and deduplication answers ([contract 03](../contracts/03-durability.md)).

There is no clock in the commit path.

### 4. Adaptive group commit per shard

Each shard has one committer. The next append starts as soon as the previous one returns and takes every entry queued since, up to a cap (4,096 entries or 4 MiB encoded, whichever first). When the queue is idle, the first entry waits at most 2 ms for company. A store may set a minimum interval between appends per shard (a tick floor); Akter Cloud sets one per plan tier. Shards append in parallel, so durable appends per second are shards × ticks, and one shard sustains `cap ÷ PUT latency` actions per second.

An actor's next action runs on the speculative result of the previous one before it is durable; same-shard sends run immediately and their entries follow the sender's in the same shard log, so a lost segment loses everything that depended on it.

### 5. Validity: `T_valid` and `T_trim`

A deleted segment key could be created again by a stale owner whose head is behind, which would then believe its write committed. Two constants close that window:

- **`T_valid` = 10 s.** An owner that has neither appended successfully nor verified within `T_valid` MUST verify before it appends or answers a read: the newest checkpoint's offset is at or below its head, and `HEAD log/<head+1>` is 404. A failed verification closes the shard.
- **`T_trim` = 10 min.** Trim deletes only segments covered by a checkpoint older than `T_trim`, and only after their history retention ends ([ADR 0132](0132-forks-and-retained-history.md)).

Because `T_trim ≫ T_valid`, any owner that could target a trimmed key has already failed verification. Both bounds are elapsed time on the owner's own clock, not synchronized wall clocks. That makes process suspension the hazard: a suspended runner whose monotonic clock paused could resume believing no time passed. So the owner MUST measure validity with a clock that counts suspended time where the platform has one, MUST treat any detected discontinuity (wall and monotonic elapsed time disagreeing by more than 250 ms, or the monotonic clock moving backward) as an expired validity, and MUST verify every owned shard before serving after one. If both clocks pause together and the platform does not correct the wall clock before the next request, detection is impossible; hosts that suspend runners SHOULD drain shards before suspension. This carries [ADR 0122](0122-suspend-safe-served-clock.md)'s rule that time after a discontinuity is never trusted.

### 6. Checkpoints

A checkpoint writes pages with plain `PUT` (content-addressed, so rewriting identical bytes is harmless and refreshes the object's timestamp for GC), then the manifest at `cp/<inverted offset>` with `If-None-Match: *`. The manifest covers every actor manifest pointer, the timer wheel and `nextDue`, the pending cross-shard sends, the job table, the deduplication state, the open connections and the index pages of the shard at its offset. A stale owner can only produce a manifest at an older offset, which recovery ignores. Checkpoints are written for dirty shards every 60 s, 64 MiB or 2,000 segments, whichever first, and at drain.

### 7. Admission and backpressure

Refusals happen before an action runs, write nothing, and are retryable under the same command id. A refusal is never retried inside the runtime; the caller backs off by `retryAfter`.

- **Runner admission.** At most `admission.concurrency` external actions (default 64) are in flight per runner, from admission to reply; up to as many more wait in arrival order for at most `admission.wait` (default 100 ms). Others fail `ActorUnavailable` with `retryAfter`. HTTP `/rpc` handlers past `admission.requests` (default 64) are refused before authentication and body parsing.
- **Per-actor queue.** An actor holds at most 1,024 queued actions; past it, `MailboxFull` with `retryAfter`.
- **Committer inbox.** A shard's committer holds a bounded number of entries waiting for durability; past it, `RunnerAtCapacity` with `retryAfter`.
- **Residency.** A runner holds at most `maxResidentActors` activations; an idle activation is evicted to admit a new one, and when none can be evicted the action fails `RunnerAtCapacity`.
- A caller that stops waiting does not cancel its action or free its slot until the action settles.

### 8. Runner leases are advisory

Runner registration and shard locks use Effect Cluster's `RunnerStorage` implemented on the bucket: `cluster/runners/<address>` registrations, `cluster/beats/<address>` heartbeats, `cluster/locks/<shard>` shard locks and `cluster/machines/<id>` machine-id claims; registrations, locks and claims are updated with `If-Match` on their ETag. Shard assignment is not stored: each runner computes it from the runner leases with `HashRing`. These objects decide who should open a shard and how peers find each other. They never authorize a write: only the segment chain does. Nothing in the framework uses Cluster's SQL storage, advisory locks or message storage.

### 9. Release handoff: drain, then open

Releases of one store overlap during a rollout. E3 uses one bucket-backed membership and a stable store-scoped peering identity, so the new runner can forward to the old owner while it is in standby. This amends the earlier separate-release-cluster proposal; the reason and outstanding confirmation are recorded in the E3 amendment below.

- A new release starts in standby: it registers, serves `/rpc` through the gateway path and opens no shard of the store.
- Draining a shard stops admission (callers get `ShardMoved` with `retryAfter`), flushes the committer, writes a checkpoint, and appends a final segment holding one `Released` entry. The drain report lists each shard's offset and `nextDue`.
- A runner of another release MUST NOT open a shard whose last segment is not `Released` unless the owning runner's lease object has expired. The create-once fence still decides between racers.
- Graceful drain therefore leaves an empty tail for the next owner; only a crash leaves an old-build tail ([ADR 0133](0133-build-matched-replay.md)).

### 10. Shard count

The shard count is fixed in `meta/store` at store creation (default 16, at most 256). A runner configured with another count refuses to start. Resharding is a later, offline operation.

## E2b amendment: engine ownership, freshness and release

Store opens an epoch before the engine loads and replays its checkpoint and tail. The open segment is empty (`open` equals its own offset); it is the `Open` operation, not an application entry. Recovery must succeed before admission or publication. Store falls back from an undecodable manifest or one naming a missing page only while the gapless log still reaches every skipped checkpoint's offset. A failed replay refuses the shard even though Store took the epoch.

On `StaleEpoch`, the engine discards pending work, answers `ShardMoved` and stays `fenced`. Only the runner layer's `engine.assign` can assign that shard back and initiate another open; caller reads, retries and autonomous restart cannot. An assigned shard's own crash or unavailable append may restart with backoff, so accepted timers and sends do not wait for a caller. These are distinct failure paths, not two names for the same restart policy.

Store owns `validFor` (default 10 seconds), confirmation time and `fresh(lease)`. The engine uses that freshness for reads and admission, including duplicates answered from memory, and calls `verify` when it expires. Successful append or verification renews Store's window; a detected fence never remains fresh. The discontinuity/suspend-safe-clock requirements of §5 remain proposals, not established by advancing `TestClock`.

Engine drain stops admission, flushes, writes the checkpoint, then appends a segment containing only `Released`. It returns `{ outcome: "clean" | "timedOut", shards: [{ shard, offset, nextDue }] }`, with `nextDue` in epoch milliseconds or `null`. An incomplete release closes without publishing undurable work. The next build has no application entries to replay, although the bookkeeping-only `Released` tail remains. The runner layer still owns unready/readiness, registration and routing, rollout standby/no-open-before-release (F24), advisory lease release, and self-host `DRAINED` output; `engine.assign` establishes none of those guarantees.

[E2 recovery](../verification/e2-recovery.md) maps F6–F12 to the seeded ownership suite and the six real-store engine scenarios. Provider performance and production-bucket atomicity remain T5 evidence, not simulator or filesystem claims.

## E3 amendment: assignment, peering and the release barrier

`runtime/sharding.ts` is the Akter adapter over Effect Cluster's `Sharding`, volatile shard entities and `SocketRunner`. `store/runners.ts` supplies `RunnerStorage.makeEncoded` over the Store's bucket. Cluster computes assignments with `HashRing`; no assignment object or second durable message store exists. Only newly acquired advisory locks call `engine.assign`; a refresh that loses a lock calls `engine.unassign`. Repeated requests never call assignment. The defaults remain 30-second lock expiration and 15-second assignment refresh, rather than silently shortening them to meet T6.

An orderly Cluster lock release first runs engine release: stop admission, flush, checkpoint, append `Released`, then release the advisory lock. A failed checkpoint or release keeps that live runner's lock instead of letting another release open an unreleased tail. Lock expiration still permits crash recovery, whose actionable tail requires the matching build. Readiness remains `routing` until the bucket registration and all HashRing-assigned shards are open; expired Store verification and peer-credential health produce `storage` and `peering` respectively.

The runner is unready before drain starts, rejects new gateway calls with `ShardMoved`, unregisters before releasing its advisory locks and does not renew its heartbeat afterwards. A disabled self remains only in the drained runner's local Cluster membership view, preventing Cluster's automatic registration loop from recreating it; other runners see only the bucket. Host signal handling keeps the runtime alive through the bounded drain and prints `DRAINED <JSON report>` before scope close. `nextDue` remains a checkpoint field and a per-shard drain-report value; there is no `next_due` table or instance directory.

**Provisional peering choice requiring captain confirmation.** D27 requires cross-runner forwarding, including a standby new release reaching an old owner, while the earlier §9 and security proposal required release-specific certificates that reject that connection. E3 takes the closest D24/D27 option: one trusted cluster per store, with a stable identity shared only by that store's authorized releases. The kept peering implementation still spells its option `deployment` and its URI `spiffe://akter/deployment/<identity>`; for 0.2 that identity must name the store, not a release. Hosted assertion audiences remain release-specific. This does not authorize credentials or peers of another store. Confirm this amendment before promoting the security boundary or launching a rollout.

[E3 cluster evidence](../verification/e3-cluster.md) separates the seeded engine simulator from real mTLS/MinIO process evidence and records the T6 limits. It does not establish R2/Tigris behavior, suspend-safe clocks, Cloud wake orchestration or old-build image retention.

## Supersedes and amends

- Supersedes [ADR 0066](0066-authoritative-coordination.md) — scope: transaction-owned authoritative rows, local data fences and the coordination pool; its rule that a lease alone is never authority carries.
- Supersedes [ADR 0067](0067-due-work-shard-ranges.md) — scope: in full.
- Supersedes [ADR 0068](0068-production-multi-runner.md) — scope: SQL runner layout and acquired-shard readiness formula; socket runners, directly reachable addresses and mTLS carry.
- Supersedes [ADR 0117](0117-pooler-safe-locking.md) — scope: turn and Cluster lock authority through Postgres sessions.
- Supersedes [ADR 0119](0119-transaction-pooling.md) — scope: transaction pooling for socket runners.
- Supersedes [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) — scope: due-work bucket scans.
- Amends [ADR 0003](0003-failure-scoping-drain-and-hosted-trust.md): bounded drain carries as §9.
- Amends [ADR 0005](0005-turn-latency-batching-and-regional-placement.md): two-flight turns and per-actor batches become per-shard group commit.
- Amends [ADR 0019](0019-runner-capacity-and-pool-size.md): `RunnerAtCapacity` and `maxResidentActors` carry; the pool size ends.
- Amends [ADR 0062](0062-scale-to-zero-serving.md): a store scaled to zero needs a drain-time checkpoint and `nextDue` ([ADR 0129](0129-jobs-timers-and-shard-workflow-engine.md)).
- Amends [ADR 0077](0077-admission-control.md): bounded refusal with `retryAfter`, no in-place retry and caller-deadline rules carry as §7; Cluster mailbox and pool checkout details end.
- Amends [ADR 0122](0122-suspend-safe-served-clock.md): its discontinuity rule governs owner validity (§5).

## Alternatives

- **A mutable head pointer updated with `If-Match`.** Rejected: one write per second per key on R2 caps a shard at one batch per second, and a pointer adds a second write per batch.
- **An epoch counter object.** Rejected: the open offset already orders owners; a separate counter is a second authority that can disagree with the chain.
- **Postgres for the log** (D3). Superseded by D18.
- **Run both releases as one cluster.** Rejected: Cluster would route actors to runners of either build and mix builds per actor.
- **Open shards on lease expiry alone during a rollout.** Rejected: shards would thrash between releases until the old one stopped; the fence keeps data correct but availability suffers.
- **Wall-clock leases.** Rejected: no synchronized clocks are assumed; validity is elapsed time on the owner's clock plus verification.

## Consequences

- Per-action latency is one PUT round trip plus queueing. The product statement names the provider (D20).
- Every append is a Class A operation; cost per action falls as batches grow, and a tick floor bounds it at low load.
- A long-idle owner pays one LIST and one HEAD before serving.
- Trim never runs before history retention ends, so segments double as the history archive.
- Suspension of a runner is a correctness concern that hosts must handle (§5).

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0        | T5 probe: zero double successes in the conditional-create race on the chosen provider; PUT latency from Fly `iad`                                                                                                                                                            |
| E1        | Simulator: I1 (at most one epoch appends) under partitions, lost responses and paused runners; the trim-race scenario with an owner paused past `T_trim` (R19)                                                                                                               |
| E2        | F6 (crash after append before reply), F6′ (append succeeded, response lost: resolved by header), F7 (stale append after move), F8 (two runners believe they own a shard), F10 (bucket unavailable or slow), F11 (drain under load); T1 and T2 against MinIO and the provider |
| E3        | F24 (a new release does not open a shard the old release has not released); epoch increments per minute during a rollout; T6                                                                                                                                                 |

## Revisit when

- The probe or `akter storage check` finds a provider that passes atomicity but fails list consistency or the per-key write rate; the key layout may need to change.
- Measurements show `T_valid` verification dominates idle latency or `T_trim` delays trim enough to matter for cost.
- A platform offers a suspend-safe clock guarantee, or one is shown not to, which changes §5's host rule.
- Resharding becomes necessary.
