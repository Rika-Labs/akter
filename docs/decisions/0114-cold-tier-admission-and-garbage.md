# ADR 0114: Cold-tier admission and referenced-object garbage

**Status:** accepted (2026-10-09). Amends ADR 0036 sections 3–5.

**Responsibility:** reconcile cold rehydration with owner-side admission and make immutable-key reuse safe for both garbage-collection paths.

**Authority:** design decision record.

**Owner role:** runtime architecture / storage.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0036](0036-cold-tier.md) was accepted before [ADR 0072](0072-served-command-in-two-round-trips.md) removed the off-turn `readAdmission` on which its fetch protocol depends. On the current runtime, dispatch checks authorization and identity shape, then the owner resolves expiry and receipts under the generation fence. Restoring a pre-delivery database read for every command would undo ADR 0072 and add work to warm actors. Fetching after fenced admission without ending the transaction would violate [contract 03](../contracts/03-transactions.md).

ADR 0036 also says every aborted flip makes its uploaded object an orphan. That is not true when attempts reuse an immutable key. An earlier attempt can upload at generation `g`; after its lease expires, a replacement attempt can snapshot the same bytes, verify the same create-only key, and flip successfully. The earlier attempt's already-cold abort still names the current `cold_ref`. A garbage-table entry is therefore not proof that the object is unreferenced. The three deletion conditions in ADR 0036 section 5 must apply to the garbage-table fast path as well as reconciliation.

Finally, reconciliation's object-creation-age test cannot substitute for the backup window after an unreference. An object may have been cold for years, then rehydrate immediately after a backup. It is now old, unreferenced by the current database, and has no cold timer, but that recent backup still names it. Reconciliation must honor the same latest-unreference window as the garbage fast path instead of deleting it immediately.

The [real-Postgres model](../verification/cold-tier-amendment.md) reproduces these interleavings and distinguishes age-only deletion from reference-, in-flight-, and backup-window-gated deletion. It is design evidence, not cold-tier runtime conformance: no cold-tier implementation or migration exists yet.

## Decision

### 1. Detect under the fence, fetch with no transaction, then re-enter

Keep dispatch and ordinary warm/wake admission unchanged. Extend the owner's existing fenced admission result with `cold_ref`, `cold_digest`, and the cold state version. Do not add a pre-delivery database read.

1. The owner's ordinary admission locks the generation row and applies the existing identity, expiry, caller, payload, receipt, subscription-cursor, and creation checks before deciding that any handler must run. A retained receipt replays without fetching or writing back cold material. Refused or already-acknowledged deliveries also require no fetch. This applies to external commands and trusted internal deliveries.
2. If a handler must run and `cold_ref` is present without matching fetched material, capture its reference, digest, and state version, **roll back the whole admission transaction, wait for its ending reply, and release the session**. Run no handler and publish no result from this abandoned admission. Its generation increment, timer deletion, and any other tentative writes roll back too. For a batch, retain the same requests and command ids; do not publish a partial batch or keep a successor admission open across the fetch.
3. Outside every transaction, fetch the immutable object, verify its digest, and decode its envelope. Preserve ADR 0036's timeout, `ActorUnavailable`/`retryAfter`, and deterministic-corruption failure rules. A retry retains the command ids and existing admission-status semantics; the fetch is not permission to bypass a later identity, expiry, or receipt check.
4. Re-enter ordinary admission with the same requests. Resolve receipts again before using fetched material. A receipt that committed during the fetch replays without write-back. For a handler that still needs cold state, require the current reference, digest, and version to match the fetched material. If another turn already rehydrated the actor, discard it and use the database state. If the pointer changed to another cold object, end the transaction and fetch that object through the same protocol. A stale generation follows ordinary retry rules.
5. Run the handler only after this second admission proves authority. Complete state/blob write-back, `cold_ref` clearing, garbage-candidate recording, and the handler's consequences commit atomically with the first successful turn. A declared failure commits only its failure receipt and retains the cold pointer; a defect rolls back. Subsequent turns in the same activation must still stage every unwritten state key and blob entry until a successful commit proves restoration.

Fetched-but-unwritten material has separate activation-local ownership. It is never a committed `ActivationCache.state`, and cannot qualify a turn for a speculative warm fast path. Rehydrating turns do not join cross-actor shared-turn groups. A future warm fast path must require a null `cold_ref` in its database guard, not merely trust residency or a cached generation. There is no new durable admission record or intermediate restored state.

This changes only the cold fetch path: warm commands, ordinary non-cold wakes, and receipt-only replays keep their current database flights. A cold wake adds the abandoned admission, transaction release, object GET, and renewed admission; these costs must be measured rather than described as only an extra GET. The published target remains wake latency plus one GET, with any excess explicitly reported in L.2 evidence.

### 2. Treat garbage rows as candidates, never deletion authority

An aborted flip must examine the locked generation row before recording its key as garbage. If the row's current `cold_ref` is that key, the object is live, even if this attempt did not create the reference. Do not record it as unreferenced. An abort must still leave a newer claim or replacement `$cold` timer alone.

Both the garbage-table fast path and deployment-prefix reconciliation must prove all of the following before deleting an object:

- The backup-retention-plus-grace interval has elapsed since its latest recorded unreference. Reconciliation may use object creation age only for an object with no garbage record, such as an upload that never flipped. An old creation time must never bypass a recent garbage record.
- Its actor's current `cold_ref` is not the candidate key.
- Its actor has no `cold` outbox row, including a future timer, a claimed row, or a retrying attempt.

Check reference and outbox conditions together against current durable rows, not a cached activation or an earlier candidate scan. A stale garbage row that names a live object causes no object deletion. A read/check failure also causes no deletion; leave the candidate for a later sweep. A garbage candidate never bypasses the in-flight gate, even if its age exceeds the backup window. Reconciliation uses these same gates, not an alternative safety rule.

Every genuine unreference records the current database time in the flip-abort or successful rehydration transaction. If a garbage record for the key already exists, advance its timestamp to the latest unreference; never keep an earlier deletion deadline after a new reference lifetime. Keep that record until object deletion is confirmed. A deletion failure or unknown outcome retains it so reconciliation cannot fall back to creation age and bypass the retention gate.

Object I/O still occurs outside transactions. Safety relies on the existing lifecycle: the `$cold` row precedes upload and lasts through flip or abort; a later offload follows a wake that raises the generation and uses another key. Backup restore must stop every runner and its maintenance pool before replacing the database, as [contract 09](../contracts/09-recovery.md) requires, and verify every restored `cold_ref` before restarting. Restoring an older database is not allowed to race a live sweep. Retries using the same create-only key must verify its bytes before treating an upload as done.

### 3. Acceptance and implementation boundary

This proposal changes no public API, applied migration, supported backend, or runtime behavior. Acceptance authorizes these amendments, not a claim that L.2 is built. Implementation still requires ADR 0036's next-free-number migration, storage adapters, timer/relay offload pool, query read-through, state-chain guard, failure tests, operations amendments, and latency evidence. PGlite remains excluded from the cold tier.

## Alternatives

- **Restore the old off-turn preflight:** simpler fetch preparation, but adds a database flight to every command or non-cold wake where enabled and reverses ADR 0072's deliberate tradeoff.
- **Fetch while fenced:** holds a turn transaction across network I/O and violates contract 03.
- **Add a durable fetching/restoring state:** adds a second durable admission/lifecycle protocol without changing the authority needed for the eventual turn.
- **Give every offload attempt a unique object key:** avoids this particular key reuse, but abandons the accepted deterministic create-only retry protocol and still needs reference checks for restore safety.
- **Trust garbage age or lease renewal alone:** neither proves that another attempt has not referenced the candidate. Retain the existing immutable object key and repair the deletion predicate instead.

## Consequences and required evidence

Cold wakes make additional database flights without adding any to ordinary warm work. A fetch outage cannot block receipt replay, and a fetch never holds a generation lock. Garbage candidates can remain longer when an actor has pending cold work; safety wins over eager reclamation.

Before L.2 is claimed, real-Postgres runtime and process-crash tests must cover: receipt replay during an object-store outage; a receipt appearing only at renewed admission; crash after admission rollback and after fetch; pointer changes while fetching; declared failure followed by a successful complete write-back in the same activation; competing same-key offloads; a stale garbage candidate naming a live object; an aged object protected by a retrying cold row; garbage-check failure; failed or unknown object deletion retaining its candidate; reconciliation immediately after rehydrating an old object; and restore to a snapshot holding an old cold reference. The existing ADR 0036 failure cases remain required. The linked SQL model is not a substitute for those tests.

## Revisit when

- Measured cold-wake latency makes the added admission unacceptable.
- Admission or shared-turn batching changes the transaction-release seam.
- Object keys, backup horizons, or restore procedures change.
