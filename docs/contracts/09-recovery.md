# Failure and recovery

Status: proposal (0.2), owned by ADR 0126; promoted when E2 failure evidence lands.

**Responsibility:** define how shards open and recover, how unknown outcomes resolve, how runners drain and hand off, which build replays a tail, and how a store is restored.  
**Authority:** normative target on `rewrite/0.2`.  
**Owner role:** runtime and reliability.  
**Change policy:** every change needs crash-point evidence on the simulator and on a real bucket.

## Recovery derives from the log

Recovery MUST derive authority and consequences only from `meta/store`, segments, checkpoints and pages, never from process memory, lease objects or caches.

## Opening a shard

1. List the newest checkpoint; list the segments after its offset. The tail MUST be gapless; a gap MUST refuse the shard.
2. Load the checkpoint's shard state (actor pointers, timers, pending sends, jobs, deduplication state, connections, index) and replay the tail. Replay MUST compare each recorded outcome and raise `ReplayMismatch` on a difference ([actions](02-actions.md)).
3. Create the next segment with an `Open` entry using `If-None-Match: *`. A conflict means another runner opened first: re-list and retry a bounded number of times, then give the shard up.
4. Run `disconnect` for every connection the previous owner recorded, deliver pending sends, resume open jobs, and fire timers that came due.

Actors are rebuilt lazily from their manifest plus their tail entries when first used. A replayed shard MUST reach the same states and outcomes from any retained checkpoint (I3).

## Unknown outcomes

- A crash before an action's segment is durable MUST lose the action and everything staged by it and by same-shard actions that ran on it; none of it may have been observed (I2).
- A crash after the segment is durable but before the reply MUST be answered on retry from the stored outcome without running the handler again ([durability](03-durability.md)).
- An append whose outcome is unknown MUST be resolved by the segment header before any reopen; if the bucket cannot be reached, the owner MUST close the shard without publishing and the next open decides.
- A retryable failure of an admitted action MUST answer the caller with a retryable reason (`ActorUnavailable` or `ShardMoved`); the caller retries with the same id.
- Corrupt or missing pages and undecodable checkpoints MUST NOT produce default state ([storage](06-storage.md)).

## Drain and release handoff

- Drain MUST make the runner unready before it stops admission, then for each owned shard: stop admission (callers get `ShardMoved` with `retryAfter`), flush the committer, write a checkpoint, and append a final segment holding one `Released` entry. Drain MUST finish within its configured bound and report `{ outcome: "clean" | "timedOut", shards: [{ shard, offset, nextDue }] }`; a self-hosted runner prints it as `DRAINED` followed by the JSON report.
- Closing the runtime MAY cut off admitted actions; a cut-off action, or one sent during or after shutdown, MUST fail with a retryable reason within a bound and MUST NOT wait without end.
- A runner of another release MUST NOT open a shard whose last segment is not `Released` unless the owning runner's lease object has expired; the create-once fence decides between racers.
- A new release MUST start in standby and open shards only through the rule above.

## Build-matched replay

- Every segment records its build (application bundle digest, framework version, JavaScript engine and version).
- A tail written by another build MUST be replayed by a runner of that build. A runner without it MUST refuse the shard and report it, unless the operator configured `replay: "current"`. A tail written by another JavaScript engine MUST be refused without operator opt-in, even when the bundle matches ([ADR 0133](../decisions/0133-build-matched-replay.md)).
- A runner that cannot decode a checkpoint's state with its schemas MUST refuse the shard.

## Clocks and suspension

Owner validity uses elapsed time on the owner's own clock ([actor authority](01-actor-authority.md)). The runtime MUST measure it with a clock that counts suspended time where the platform has one, MUST treat a wall/monotonic disagreement over 250 ms or a backward monotonic step as an expired validity, and MUST verify every owned shard before serving after one. Hosts that suspend runners SHOULD drain them first; a pause of both clocks that the platform does not correct before the next request is outside what the runtime can detect.

## Restore

- A store is restored from a copy of its bucket. Every runner of the store MUST be stopped before a restore and stay stopped until it completes.
- A restore MUST include `meta/store`, each shard's newest checkpoint and every segment after it, and every page reachable from those checkpoints; before any runner restarts, every restored checkpoint's pages MUST be verified by existence and digest. A shard whose copy is incomplete MUST be refused, never opened with default state.
- After a restore, pending sends, timers, job journals and deduplication state recover as after a crash. An external id that expired MUST stay refused. Actions durable after the copy was taken are lost; a retry of such an id MAY run again, and their external consequences are the operator's to reconcile.
- A stopped `akter dev` store is copied by copying its whole directory.

## Startup and runners

- A runner MUST read `meta/store` before taking any shard and MUST refuse to start if its shard count, format version or store id disagree. The first runner of a store creates `meta/store` once; concurrent first runners race on the create-once write and the loser reads the winner's descriptor.
- A multi-runner store MUST use real peer transport over mTLS and a unique, directly reachable advertised address per runner; wildcard advertisement MUST be refused.
- Readiness MUST report `routing` until registration and the opening of every assigned shard, `storage` while the store is unreachable or its credential cannot be refreshed, and `peering` while mTLS credentials are expired or unloadable ([protocol](protocol.md)).

## Verification

I3, I6; F5, F6, F6′, F9, F10, F11 (drain under load), F12 and F12′ (tail from another build or engine), F24 (no open before release), F26 (interrupted store retirement, Cloud), T6 (a shard moves in at most 5 s and replays a 10,000-entry tail in at most 1 s).
