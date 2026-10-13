# Failure and recovery

Status: partially normative (0.2), owned by ADR 0126. E2b promotes checkpoint-plus-tail recovery, unknown outcomes, engine drain/report, fenced reassignment and same-runtime build matching in [E2 recovery](../verification/e2-recovery.md). [E3 cluster evidence](../verification/e3-cluster.md) adds assignment, routed ownership, readiness and host drain. Store-scoped peering is the accepted transport identity; cross-runtime recovery, lazy paging, jobs, connection cleanup, clock discontinuities, restore and Cloud rollout orchestration remain proposal.

**Responsibility:** define how shards open and recover, how unknown outcomes resolve, how runners drain and hand off, which build replays a tail, and how a store is restored.  
**Authority:** normative target on `rewrite/0.2`.  
**Owner role:** runtime and reliability.  
**Change policy:** every change needs crash-point evidence on the simulator and on a real bucket.

## Recovery derives from the log

Recovery MUST derive authority and consequences only from `meta/store`, segments, checkpoints and pages, never from process memory, lease objects or caches.

## Opening a shard

1. Store MUST choose the newest intact checkpoint and list the segments after its offset. The tail MUST be gapless; a gap MUST refuse the shard. A checkpoint whose manifest is undecodable or names a missing page MUST be skipped; if the remaining log no longer reaches the skipped checkpoint's offset, the shard MUST be refused rather than reopened from an incomplete prefix.
2. Store MUST create the next empty open segment using `If-None-Match: *`. Its offset is the new epoch. A conflict means another runner opened first: re-list and retry a bounded number of times, then give the shard up. Taking this epoch alone MUST NOT permit the engine to serve before recovery succeeds.
3. The engine MUST load the checkpoint's shard state and replay the tail. Replay MUST compare each recorded outcome and raise `ReplayMismatch` on a difference ([actions](02-actions.md)). An incompatible build or an undecodable checkpoint state MUST refuse the shard, never substitute default state.
4. After successful recovery, deliver pending sends, resume open jobs, and fire timers that came due. A timer due during downtime MUST retain its original due time while recovery decides whether to fire it. Connection cleanup (run `disconnect` for every connection the previous owner recorded) remains a proposal obligation for runner integration.

Actors are rebuilt lazily from their manifest plus their tail entries when first used. A replayed shard MUST reach the same states and outcomes from any retained checkpoint (I3).

## Unknown outcomes

- A crash before an action's segment is durable MUST lose the action and everything staged by it and by same-shard actions that ran on it; none of it may have been observed (I2).
- A crash after the segment is durable but before the reply MUST be answered on retry from the stored outcome without running the handler again ([durability](03-durability.md)).
- An append whose outcome is unknown MUST be resolved by the segment header before any reopen; if the bucket cannot be reached, the owner MUST close the shard without publishing and the next open decides.
- A retryable failure of an admitted action MUST answer the caller with a retryable reason (`ActorUnavailable` or `ShardMoved`); the caller retries with the same id.
- Corrupt or missing pages and undecodable checkpoints MUST NOT produce default state ([storage](06-storage.md)).

## Drain and release handoff

- For each owned shard, engine drain MUST stop admission (callers get `ShardMoved` with `retryAfter`), flush the committer, write a checkpoint, and append a final segment holding one `Released` entry. Drain MUST finish within its configured bound and report `{ outcome: "clean" | "timedOut", shards: [{ shard, offset, nextDue }], actions?, jobSeconds? }`. `offset` is the final durable offset; `nextDue` is the earliest pending timer or cron tick in epoch milliseconds, or `null` when none remains. Optional top-level `actions` and `jobSeconds` are cumulative runner-local attribution since open, including previously released or lost shards and locally interrupted attempts. New producers MUST include them; decoders MUST accept legacy reports without them. Missing totals are unknown, not zero. If release cannot complete within the bound, drain MUST close the shard without publishing undurable work and report `timedOut`.
- The runner integration MUST make the runner unready before engine drain stops admission. A self-hosted runner MUST print `DRAINED` followed by the JSON report, then close its runtime scope. `RuntimeControl.waitForSignal` waits for SIGTERM or SIGINT without prematurely interrupting the engine; the self-host recipe uses it on Bun and Node.
- Closing the runtime MAY cut off admitted actions; a cut-off action, or one sent during or after shutdown, MUST fail with a retryable reason within a bound and MUST NOT wait without end.
- A runner of another release MUST NOT open a shard whose last segment is not `Released` unless the owning runner's lease object has expired; the create-once fence decides between racers.
- A new release MUST start in standby and open shards only through the rule above.
- An orderly assignment change MUST write the shard's `Released` record before releasing its advisory lock. While a runner drain is still writing `Released` records, the runner MUST keep renewing its heartbeat and MUST NOT release any advisory lock, even after its own membership view has disabled it. A failed release MUST NOT hand that live runner's lock to another release. A drained runner MUST NOT re-register or renew its heartbeat; unregistration and advisory cleanup use only the remaining drain budget.
- After an orderly durable release and advisory cleanup, the runner MUST notify its registered peers to refresh membership immediately. A release notification MUST NOT precede the durable release barrier, grant write authority, or replace periodic refresh; a dropped notification still recovers through the periodic path. A notification arriving before the next refresh wait MUST remain pending until that wait consumes it. Forced cleanup and a timed-out drain MUST NOT send a clean-release notification.
- A shard fenced by a newer epoch MUST remain closed on the old runner. Only the runner layer's `engine.assign` may make that runner try to reopen it; callers and autonomous engine restart MUST NOT do so. `ShardMoved` is the caller-visible result while it is fenced.

## Build-matched replay

- Every segment records its build (application bundle digest, framework version, JavaScript engine and version).
- A tail written by another build MUST be replayed by a runner of that build. A runner without it MUST refuse the shard and report it, unless the operator configured `replay: "current"`. A tail written by another JavaScript engine MUST be refused without operator opt-in, even when the bundle matches ([ADR 0133](../decisions/0133-build-matched-replay.md)). Bookkeeping-only segments such as an empty `Open` segment or `Released`/`Skipped` entries do not require application-code replay; the build check applies to segments that run handlers or schemas.
- A runner that cannot decode a checkpoint's state with its schemas MUST refuse the shard.

## Clocks and suspension

Owner validity uses elapsed time on the owner's own clock ([actor authority](01-actor-authority.md)). The runtime MUST measure it with a clock that counts suspended time where the platform has one, MUST treat a wall/monotonic disagreement over 250 ms or a backward monotonic step as an expired validity, and MUST verify every owned shard before serving after one. Hosts that suspend runners SHOULD drain them first; a pause of both clocks that the platform does not correct before the next request is outside what the runtime can detect.

## Restore

- A store is restored from a copy of its bucket. Every runner of the store MUST be stopped before a restore and stay stopped until it completes.
- A restore MUST include `meta/store`, each shard's newest checkpoint and every segment after it, and every page reachable from those checkpoints; before any runner restarts, every restored checkpoint's pages MUST be verified by existence and digest. A shard whose copy is incomplete MUST be refused, never opened with default state.
- A restore MUST also include `meta/retention` when present and the operator audit objects; omitting it would silently restore the initial retention rather than the effective policy. An absent retention record in a store that never changed policy still uses `meta/store`.
- After a restore, pending sends, timers, job journals and deduplication state recover as after a crash. An external id that expired MUST stay refused. Actions durable after the copy was taken are lost; a retry of such an id MAY run again, and their external consequences are the operator's to reconcile.
- A stopped `akter dev` store is copied by copying its whole directory.

## Startup and runners

- A runner MUST read `meta/store` before taking any shard and MUST refuse to start if its shard count, format version or store id disagree. The first runner of a store creates `meta/store` once; concurrent first runners race on the create-once write and the loser reads the winner's descriptor.
- A multi-runner store MUST use real peer transport over mTLS and a unique, directly reachable advertised address per runner; wildcard advertisement MUST be refused.
- Readiness MUST report `routing` until registration and the opening of every assigned shard, `storage` while the store is unreachable or its credential cannot be refreshed, and `peering` while mTLS credentials are expired or unloadable ([protocol](protocol.md)).
- Bucket runner defaults are three-second liveness expiration, 250-millisecond membership refresh and two-second configured lock refresh. Effect caps the effective lock refresh at one third of expiration; a serialized 1.5-second floor between completed heartbeat writes normally yields a heartbeat every two seconds, well below one write per second per key. Liveness MUST use observed heartbeat ETag changes and the observer's monotonic elapsed time, not timestamps from another runner. Before taking an apparently expired owner's advisory lock, the runner MUST check the current heartbeat ETag rather than rely on an expired cache entry. The create-once log fence remains the sole write authority when a slow or paused runner is falsely suspected.

## Verification

I3, I6; F5, F6, F6′, F7, F8, F9, F10, F11 (drain under load), F12 and F12′ (tail from another build or engine), F24 (no open before release), F26 (interrupted store retirement, Cloud), T6 (a shard moves in at most 5 s and replays a 10,000-entry tail in at most 1 s). [E3 cluster evidence](../verification/e3-cluster.md) separates historical 30-second/15-second measurements from the current defaults. Shorter expiration and release notifications establish the timing mechanism, not an unconditional five-second bound under storage outages or unmeasured provider latency.
