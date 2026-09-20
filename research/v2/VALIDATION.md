# Validation gates — prove the transaction before expanding the API

These are **proposed experiments, not passing tests**. The repository currently contains research and a preserved historical scaffold. Use disposable data only. Provisioning a paid/shared Neki environment requires authorization; do not infer it from the research request.

## Gate 0: preserve evidence

Completed during this research iteration:

- Downloaded the six generated documents and original ZIP from the source thread.
- Checked ZIP CRC integrity and rejected absolute paths, parent traversal, and symlink entries before extraction.
- Extracted all 323 archive entries without running imported scripts.
- Produced `../v1/SHA256SUMS` and compared extracted bytes against the archive.
- Read primary Neki/Postgres/PGlite/Restate documentation and inspected pinned Effect source. Sources and uncertainty are recorded in the [assessment](README.md).

These checks establish artifact integrity, not runtime correctness.

## Gate 1: transaction and authority, before freezing the schema

Owner: runtime/store implementation. Run on actual Postgres and at least two Neki data shards. PGlite is supplemental.

| Experiment | Plausible wrong implementation | Required observation |
| --- | --- | --- |
| Crash after business update, event, intent, and receipt writes, before commit | One operation escaped onto a second client | No partial turn survives; retry produces one committed transition |
| Disconnect during COMMIT; retry same command ID | Assumes timeout means rollback | Receipt lookup resolves outcome without applying the transition twice |
| Register local reply listener; stall/fail outer COMMIT | Reply callback publishes after nested savepoint but before commit | Client never observes “committed” before durable commit confirmation |
| Same URL, separately constructed SqlClients | Transaction identity mistaken for connection configuration | Test exposes partial durability; supported integration rejects/prevents this configuration |
| Two runners activate same actor; pause old runner before and during its turn | Lease treated as fence | Old generation cannot commit after new generation is installed; preexisting locked turn serializes before handoff |
| Concurrent first commands create same actor | Creation bypasses fence protocol | One actor lineage, no lost update, one receipt per command |
| Typed rejection after staged writes | Error receipt also commits partial state | Business writes/events/intents roll back; rejection receipt commits and retry returns it |
| Neki turn touches actor A, then actor B on another shard | `tx_mode` set on wrong pooled connection | Second-shard enlistment rejected and first-shard writes rolled back |
| Neki receipt/message/event joins and lookups | Hidden global runtime table | Plans route each turn operation to its actor shard; exact guarantee tested against the real router |
| Actor RLS under non-owner role, including pooled reuse | Context leaks to next request or router loses SET LOCAL | Wrong-row writes blocked, context reset, same-ID/different-type ownership distinguished |
| Change actor context with arbitrary SQL | RLS advertised as hostile-code sandbox | Documented trust boundary matches behavior; no claim of malicious-handler isolation |
| Read-only role tries UPDATE, TRUNCATE, SET ROLE, DDL | Default read-only flag mistaken for privileges | Grants prevent writes/admin escalation irrespective of default settings |

For Neki RLS, also test missing context, INSERT/WITH CHECK, zero-row UPDATE/DELETE, role inheritance, prepared statements, and rollback. If required enforcement fails, change the design/contract explicitly; do not hide it behind a parser fallback.

Exit: both Postgres and Neki satisfy the same advertised actor-turn invariants. If Neki access is unavailable, report support as unverified; do not label single-node Postgres tests “Neki compatible.”

## Gate 2: durable progress and recovery

Owner: messaging/activity implementation.

- Deliver an outgoing intent, kill relay after destination commit but before source acknowledgement, restart it: destination transition occurs once.
- Race two relay workers, expire a claim while the old worker is alive, reorder batches: duplicates are safe; any advertised ordering is actually enforced.
- Disable all notifications: polling still drains committed inbox/outbox rows.
- Restart after timer deadline and during activity completion: due work resumes; completion ID dedupes; lateness is measured.
- Retry one ID with a different payload: explicit conflict, not silent reuse of an unrelated receipt.
- Keep an intent pending beyond normal message retention: cleanup must not erase the destination's necessary dedupe protection.
- Simulate transient DB outage and poison payload separately: infrastructure outages do not exhaust a small generic defect counter into mass dead-lettering.
- Saturate one actor and the connection pool: bounded work, visible backlog age, unaffected actors make measurable progress, recovery does not amplify load indefinitely.
- Restore a disposable backup taken before a mocked external payment: effects remain paused until reconciliation prevents duplicate external work.
- Exercise partial Neki DDL and topology changes: incompatible schema is visible; stale topology cannot silently split an actor turn across shards.

Exit: lost processes and acknowledgements cause bounded retries and observable lag, not silent loss or duplicate committed effects.

## Gate 3: product fit and sustainable cost

Owner: application examples and measurements.

Build one inventory/order example and one durable agent example. Show normal SQL reporting plus command-only mutation. Include an explicit cross-actor reservation/saga rather than implying multi-actor ACID.

Measure uniform and highly skewed actor workloads on both backends: p50/p95/p99 command latency; one-hot-actor throughput; SQL round trips and WAL growth; pool wait; oldest pending message/intent; timer lateness; scatter query load; restart/rebalance drain time. Report hardware, versions, payload sizes, indexes, dataset size, and durability settings. Derive expected final state independently from accepted command IDs, not from handler output.

Compare the proposed always-outbox path with a same-domain optimization only if relay latency is materially harmful. Keep the simpler path unless the measured gain justifies topology/order/migration complexity.

Exit: publish measured limits, a pinned compatibility matrix, deployment/backup/restore instructions, and license choice. Do not inherit old estimates as benchmarks.

## Questions to settle before release

1. Does the exact Neki router support actor-context RLS, required locking SQL, nested savepoints, and chosen Effect SQL encodings?
2. How does the current Effect response path behave when the outer COMMIT fails after reply persistence?
3. Which routing key/polling scheme preserves locality without binding storage permanently to Effect's scheduler hash?
4. What dedupe window and permanent business IDs protect effects after pruning or restore?
5. Does PlanetScale offer source, an OSS license, and independent installation instructions for Neki? Until proven, self-hosting means the Postgres backend.
6. Which Bun/Node/Postgres/Effect versions pass the same suite? What is the supported upgrade and rolling-version window?
7. MIT or Apache-2.0 for new code? Imported licensing history is not the decision.
