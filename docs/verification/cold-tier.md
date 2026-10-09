# Cold-tier framework evidence

**Responsibility:** bind ADR 0036/0114 lifecycle claims to executed runtime scenarios.  
**Authority:** verification evidence.  
**Owner role:** runtime/storage reliability.  
**Change policy:** a new cold transition or collector rule requires failure evidence.

The framework tier is opt-in on Postgres; PGlite refuses it. Migration `0034_cold_tier` adds pointer/maintenance constraints, garbage candidates and the inspection marker. This page is runtime evidence, distinct from the earlier [SQL amendment model](cold-tier-amendment.md). Hosted latency, object replication/encryption policies, provider disaster recovery and physical data sharding are not established here. The million-idle-actor storage target is not a scale measurement.

## Fixture and decisive failures

[`postgres/cold-tier.ts`](../../tooling/conformance/src/conformance/postgres/cold-tier.ts) constructs real runtime layers and disposable Postgres databases with two turn sessions. The actor has state `17/43`, three chunks in two blob entries, one event and an ordinary timer. Handlers attempt state/blob/event/timer writes before declared failure or defect. Independent owner assignments use separate runtime/Cluster memory stores but the **real Postgres generation lock** is authority: a fetch holding that lock would block the competing turn. Expectations come from those fixed asymmetric inputs, not the restoration implementation.

| Required transition or failure                                              | Runtime evidence and result                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Due offload without activation or command delivery                          | `cold-tier.test.ts`: relay offload removes material only, leaves one receipt/event/ordinary timer and the same generation; query read-through leaves the pointer unchanged.                                            |
| Truthful maintenance shape, disabled-storage claims, unlimited upload retry | Same file: malformed outbox updates fail real constraints, a runner without storage leaves cold work unclaimed, repeated PUT failure backs off with no dead letter or state loss.                                      |
| Declared failure followed by success in one activation                      | Same file: failure commits only its receipt, retains pointer and no material rows; success restores untouched state and every chunk without another GET.                                                               |
| Defect after restoration and business writes                                | Same file: every tentative consequence rolls back; next success restores the last committed snapshot.                                                                                                                  |
| Receipt replay during GET outage; same-id retry                             | Same file: replay fetches nothing; a new unavailable command retains its id and later succeeds once. Expiry/conflict refusals also fetch nothing.                                                                      |
| Receipt appears only at renewed admission                                   | Same file, `receipt` race: competing owner commits during paused GET; resumed original replays without restoring again, one receipt/transition.                                                                        |
| Restore loses race to warm state or a new cold pointer                      | Same file, `warm`/`pointer` races: discard stale bytes for database state, or release/fetch the replacement; untouched keys/chunks survive.                                                                            |
| Whole batch release/retry, no partial publication                           | Same file: paused commit exposes no results or material; declared failure and two successes retain original ids and commit their receipts together.                                                                    |
| Fetch timeout, digest/envelope corruption                                   | Same file: timeout is retryable `ActorUnavailable`; deterministic corruption writes no new receipt/material and retains the pointer.                                                                                   |
| Wake races uploaded or empty snapshot                                       | [`cold-garbage.test.ts`](../../tooling/conformance/src/conformance/postgres/cold-garbage.test.ts): obsolete flip/delete leaves the replacement timer; later offload stores the newer state.                            |
| Competing same-key claims; stale garbage naming live object                 | Same file: create-only reuse verifies identical bytes; stale attempt never garbage-records the live key, and neither collector deletes an injected live candidate.                                                     |
| Aged object protected by retrying cold work                                 | Same file: an old unflipped upload survives a 12-attempt cold row; only after a wake removes the obligation may reconciliation collect it.                                                                             |
| Latest-unreference backup window, not creation age                          | Same file: rehydration advances an old garbage timestamp; both collectors retain an old object's recent unreference, then collect after the full window.                                                               |
| Failed garbage check, failed DELETE, unknown DELETE                         | Same file: independent real-PG check error or storage failure retains the candidate; an unknown deletion's later retry confirms absence before removing it.                                                            |
| Old state version, shortened chain, complete upcast write-back              | [`cold-compatibility.test.ts`](../../tooling/conformance/src/conformance/postgres/cold-compatibility.test.ts): two-step read-through writes nothing, shortened startup refuses, success restores current keys/version. |
| Snapshot restores old cold reference                                        | Same file: stop runtimes, clone the whole Postgres database, rehydrate/advance the source, then start the restored snapshot. Original receipt replays, lost work reruns once, all old chunks read and the fence rises. |

Paths in the first nine rows refer to [`postgres/cold-tier.test.ts`](../../tooling/conformance/src/conformance/postgres/cold-tier.test.ts). These suites assert material rows, receipts, events, timers and pointers, not private call order. Test hooks pause actual boundaries; they do not replace the database/storage behavior being proved.

## Process death

[`crash/cold.test.ts`](../../tooling/conformance/src/conformance/crash/cold.test.ts) starts Bun child runtimes with a create-only filesystem store and real Postgres, waits for each actual boundary, sends **SIGKILL**, observes committed rows/object presence, then starts a fresh runtime. Boundaries: after snapshot, upload, flip, admission rollback, fetch, tentative write-back, confirmed COMMIT, and before/after object deletion. Nine cases recover to exactly one new receipt, total 24, untouched 43 and all three chunks; no missing or doubled material. Before commit the pointer/material reflects only the previous commit, and after commit the original id replays. Collector crashes retain/retry the durable candidate and confirm absence.

## Storage and latency boundaries

[`runtime/storage/cold-storage.test.ts`](../../packages/akter/src/runtime/storage/cold-storage.test.ts) checks memory and filesystem create-only concurrent publication, complete bytes, copying, prefix listing, idempotent deletion and filesystem path escape refusal. Filesystem process-kill evidence proves no partial publication, not power-loss or replicated storage durability.

[`crash/drills/cold-storage.test.ts`](../../tooling/conformance/src/conformance/crash/drills/cold-storage.test.ts) uses one private disposable MinIO container/bucket. It proves conditional concurrent PUT, immutable reuse, paginated listing of 1,003 objects, credential refusal, idempotent DELETE/missing GET, paused-server receipt replay and retryable query outage, then successful complete cold wake. It also compares plain/cold wakes and GET alone; [published local measurements](../../BENCHMARKS.md#local-cold-wake-versus-plain-wake-2026-10-09) explicitly include extra admission overhead. MinIO compatibility does not certify AWS S3, R2, regional networking, SSE/KMS permissions or provider replication.

## Run and evidence scope

Set `TEST_DATABASE_URL` to a disposable-database-capable Postgres 18.6 server; never a production database. Use Bun 1.4.2. Focused runtime command:

```sh
bun --bun node_modules/vitest/vitest.mjs run \
  tooling/conformance/src/conformance/postgres/cold-tier.test.ts \
  tooling/conformance/src/conformance/postgres/cold-garbage.test.ts \
  tooling/conformance/src/conformance/postgres/cold-compatibility.test.ts \
  tooling/conformance/src/conformance/crash/cold.test.ts \
  packages/akter/src/runtime/storage/cold-storage.test.ts
```

Docker S3/latency command: `bun --bun node_modules/vitest/vitest.mjs run tooling/conformance/src/conformance/crash/drills/cold-storage.test.ts`. The integration project includes the Postgres/crash files; framework units explicitly include adapter tests; the existing Docker drill shard includes MinIO. Local focused cases, lint and framework/conformance typechecks pass; exact-head PR CI supplies the full backend, packaging and shared-pipeline regressions. Do not close the hosted L.2 performance/durability gates from this local evidence.
