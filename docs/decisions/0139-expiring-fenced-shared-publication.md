# ADR 0139: Fenced, expiring and shared publication epochs

Status: accepted, 2026-10-14. Amends the publication exclusion of [ADR 0127](0127-snapshots-pages-lists-history-gc.md) §4.

**Responsibility:** keep the store-wide page publication barrier from deleting a reachable page while letting a store recover from a publisher that stopped mid-publication, and let one runner's drain publish all its checkpoints in one barrier claim.

**Owner role:** storage and runtime.

## Context

ADR 0127 makes every checkpoint, fork and page-backed replay hold an immutable `publishing` epoch under `gc/` from its first page write through its durable reference. A `publishing` epoch never expired, and a publisher that ended in an interruption, defect or unknown outcome never advanced it to `idle`. Each publisher also claimed its own epoch, and a second publisher in the same process was refused at once and retried.

On Tigris (2026-10-14, 0.2.0, 16 shards, about 125 ms per request) this produced two failures:

- **Serialized drain.** A drain releases every shard concurrently, but each shard's checkpoint claimed the barrier alone: list `gc/`, read the newest epoch, create `publishing`, list and read again to confirm, upload pages, create the checkpoint, create `idle`. About eleven round trips per shard, strictly one shard after another, made a clean drain take 22.6 s with a 120-second deadline (32 epoch creates and 597 `gc/` listings). The default 15-second deadline released 10 of 16 shards.
- **Stranded store.** The deadline interrupted the shard holding the barrier after its `publishing` epoch was durable. Every later checkpoint, drain and collection in that store was refused for good: the next drain released 0 shards while polling `gc/` about 120 times a second, and a matching-build runner could recover a crash tail but never checkpoint or release it, so a new build stayed refused (ADR 0133). The same strand follows a SIGKILL, an OOM or a failed request during any checkpoint, on any provider; Tigris latency only widened the window.

The runs are summarized in [E6 pages and history](../verification/e6-pages-history.md#tigris-drain-and-stranded-barrier-2026-10-14).

## Decision

1. **Fence before the reference.** `gc.protect(upload, reference)` runs `upload` (every page write), then confirms that its `publishing` epoch is still the newest `gc/` key and that the confirmation answered within `validFor`, and only then runs `reference` (the checkpoint create, `Forked` or `Replayed` append). A failed confirmation fails the publication with `PagePublicationBusy` before any reference is written.
2. **Publishing epochs expire.** A `publishing` epoch may be taken over by a collector or a publisher `PUBLICATION_EXPIRY` (60 seconds) after its claim. The record format is unchanged: a `publishing` record's `expiresAt` has always held its claim time, so epochs stranded by 0.2.0 expire 60 seconds after they were claimed.
3. **One epoch per process.** Concurrent publishers of one process share one `publishing` epoch. A publisher joins the open epoch, including one whose claim is still in flight, while it is within `validFor` of its claim and no member's reference has ended without a known outcome; otherwise it waits for the epoch to close and claims the next one. The last member out creates `idle`. If any member's reference ended in an interruption, a defect or an unknown outcome, or any member's fence failed, no `idle` is written and the epoch expires. A member that failed or was interrupted before its reference sent nothing, so it does not mark the epoch unknown; a confirmed shard fence (`StaleEpoch`) is also a known outcome. The `idle` write itself runs interruptibly, so when the last member out is interrupted (a drain deadline during uploads, say), no `idle` is sent and the epoch stays `publishing` until it expires. A publisher that loses the race to claim, or whose claim confirmation fails, is answered `PagePublicationBusy`, which every caller retries. A failed `idle` write leaves the same expiring epoch and does not fail a publication whose reference is durable; a caller interrupted during the `idle` write sees its own interruption.
4. **Fresh page timestamps.** A page write answered `412` or `429` counts as written only when `HEAD` finds an object of the page's length whose last-modified time is no older than `T_trim` before the write began; otherwise the write is retried. A throttled PUT of a page stored long ago refreshes nothing, and expiry makes that timestamp load-bearing (below).
5. **`deleting` is unchanged.** A collector's unconditional DELETE cannot be fenced after it is sent, so a `deleting` epoch with an unknown outcome still blocks collection and publication until an operator acts.
6. **Bounded epoch listing.** Epochs are never deleted, so a process lists `gc/` from the newest epoch it has already seen instead of from the start.

## Why expiry is safe

The hazard the barrier closes is a collector deleting page `P` after checking that `P` is old and unreferenced, while a publisher rewrites `P` (refreshing its timestamp) and then writes a durable reference to it. The fence orders a publisher's steps: its page writes are acknowledged, then its confirmation observes its own epoch as the newest, then it sends its reference. Take any collector that claims a later epoch, by expiry or otherwise.

- If the claim is visible before the confirmation's listing, the confirmation fails and the publisher writes no reference. Its page writes, even ones that land late, are unreferenced, so deleting them is allowed.
- Otherwise the claim completes after the confirmation, and so after every acknowledged page write. The collector's timestamp checks come after its claim, so they read the timestamps those writes left, and the grace period (24 hours by default, more than twice the checkpoint interval plus `T_trim`) keeps those pages. A reference that lands later names pages that still exist.

The second case has two preconditions, and both are assumed, not enforced: `protect` does not measure how long its publication took, and a publisher cannot know a collector's grace period, which is an option of `collect`. Every page the reference names was written in this upload with a timestamp no older than `T_trim` before the upload began (decision 4), or is reachable from a checkpoint GC keeps as a root for the whole publication, as an engine checkpoint's unchanged subtrees are reachable from the shard's newest checkpoint. And the reference lands within the grace period less `T_trim` of the upload's start: a reference held back that long, by a paused process or a stuck request, can name a deleted page. With the default 24-hour grace that bound is about 23 h 50 min, against publications that take seconds; it is the same class of bound ADR 0127 already places on page reuse, and it is why `deleting` (where an issued request has no fence at all) does not expire. A store therefore requires that the collector's grace period exceed the longest publication plus `T_trim` plus the clock skew between hosts. The floor `collect` validates (more than twice the checkpoint interval plus `T_trim`) does not imply it. With a short grace and a publication that outlasts the 60-second expiry, a collector takes over, deletes the uploaded page, and the publication's reference then lands naming a deleted page; a memory-bucket reproduction with a 1-second grace and a 61-second stall between the fence and the reference did exactly that. A grace shorter than the expiry is safe only while no publication can last past 60 seconds.

Both cases otherwise rely on what the protocol already relies on: create-once epochs and listings that reflect every completed write ([storage contract](../contracts/06-storage.md)). Neither relies on the holder's clock or on its being alive. The expiry therefore only sets how long a stopped publisher blocks the store; a live publisher that outlasts it loses its fence and retries.

Sharing an epoch keeps this argument per member: each member fences after its own uploads and before its own reference, and `idle` is written only when every member ended with a known outcome.

## Alternatives

- **Keep strand-forever and raise the drain deadline.** Rejected: a clean drain still needs N × eleven round trips, and any crash during a checkpoint still disables checkpoints, drains, collection and cross-build handoff for that store with no recovery path.
- **Expire `publishing` without a fence, on a time margin.** Rejected: a paused holder could send a reference after the takeover, as the new fence test reproduces.
- **Advance the epoch chain as the fence (create the next epoch instead of listing).** Not needed: the existing confirmation already relies on consistent listing, and one extra create per member would serialize a shared epoch again.
- **Expire `deleting` too.** Rejected for now: an issued DELETE has no fence, so takeover would need a bound on how late a request lands.
- **Accept a `412`/`429` page write on size alone, as 0.2.0 did.** Rejected: under expiry it lets a collector delete a page that a confirmed publication is about to reference, as the throttled-refresh test reproduces.

## Consequences

- A drain claims the barrier once per runner: about a dozen round trips in total rather than per shard. The drain test runs 16 shards at 125 ms per request within the 15-second deadline.
- A publisher that stops mid-publication blocks checkpoints, drains and collection for up to 60 seconds, not forever. A publication that fails before its reference (a failed upload) blocks nothing. One that is interrupted while it is the last member out (a drain deadline during uploads) blocks the store for up to 60 seconds, because its `idle` write is interrupted too.
- A publication that runs past 60 seconds after its claim is preempted by any collector run: the collector takes over the expired epoch, the publication's fence fails and it retries. Nothing renews a `publishing` epoch.
- A process's publishers wait while an open epoch is past its `validFor` join window, so one long publication (a large fork) delays that process's checkpoints until it ends.
- Operator replay of a historical image reuses pages reachable from that retained checkpoint; the replay's reference must land before that checkpoint leaves retention, which a replay bounded to seconds meets.
- Mixed 0.2.0 and 0.2.1 runners: a 0.2.0 publisher does not fence, so a 0.2.1 collector that takes over its epoch after 60 seconds could race it. 0.2.0 checkpoints finish in seconds; do not run `Store.collect` while a 0.2.0 runner of the same store is live.
- `Store["gc"]["protect"]` takes `(upload, reference)`; every in-repo caller is changed.

## Evidence

- `packages/akter/src/store/gc.test.ts`: expiry at exactly 60 seconds for both a collector and a publisher after an interrupted publisher (memory and file system); a fenced publisher whose epoch was taken while its page refresh was in flight writes no reference and the collector deletes the page (rejects expiry without a fence); a throttled refresh of a 25-hour-old page is retried, so a collector that takes over after the confirmation keeps the page (rejects accepting a size-only `HEAD`); sixteen concurrent publishers share two epochs (rejects one epoch per checkpoint); one member's unknown reference keeps a shared epoch `publishing` although another member leaves last; an upload failure frees the barrier while a reference failure blocks until expiry; a lost takeover race is `PagePublicationBusy`; members waiting on an interrupted claim are answered busy and the process can publish again.
- `packages/akter/src/runtime/drain.test.ts`: a 16-shard engine drain at 125 ms per bucket request is `clean` within 15 seconds and leaves the barrier `idle` (0.2.0 reports `timedOut`).
- Tigris re-run with the fix: [E6 pages and history](../verification/e6-pages-history.md#tigris-drain-and-stranded-barrier-2026-10-14).

## Revisit conditions

Revisit if a provider's listing does not reflect completed creates, if a collector's grace period could fall below a publication's duration, or if `deleting` strands are observed in practice.
