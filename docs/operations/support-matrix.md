# Backend support matrix

**Responsibility:** show real capability differences by backend.  
**Authority:** operational evidence.  
**Owner role:** platform/verification.
**Change policy:** a change requires operator review when a procedure or limit changes.

Support means the shared `durable-actors/testing` conformance suite passes and the deployment-specific gates are demonstrated. The embedded foundation covers bounded command/state/receipt cases on Postgres and PGlite — see the [conformance ledger](../verification/01-conformance.md#foundation-evidence), which records per-revision outcomes — including process death and independent-connection locking on Postgres. No complete runtime/backend combination below is certified. “Target” describes intended full coverage, not support established by the partial foundation suite. Run one runtime process per database; multi-runner operation is not claimed.

| Capability                       | PGlite                               | Postgres                                     | Neki                             | Evidence required                                                              |
| -------------------------------- | ------------------------------------ | -------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| Real turn path and serialization | target; unverified                   | target; unverified                           | gated; unverified                | conformance suite                                                              |
| Generation `FOR UPDATE` fence    | single-connection target; unverified | target; unverified                           | gated; unverified                | lock and pinning tests                                                         |
| Multi-connection lock tests      | not a valid proof backend            | target; unverified                           | gated; unverified                | `holdLock` cases                                                               |
| Tenant-scoped transactions       | target; unverified                   | target; unverified                           | gated; unverified                | isolation tests                                                                |
| Direct intent write with turn    | target; unverified                   | target; unverified                           | not the accepted design          | Neki uses actor-shard outbox and relay                                         |
| Neki intent relay                | not applicable                       | not required                                 | gated; unverified                | crashes across destination insert/source acknowledgment; logical deduplication |
| Cross-runner wake notification   | TestClock harness target; unverified | polling plus runner wake message; unverified | polling/relay target; unverified | delivery latency and recovery with lost notifications                          |
| Two-round-trip turn and batches  | round-trip count only; unverified    | target; unverified                           | gated; unverified                | turn-batch checks and round-trip counts                                        |
| `routing_key` placement          | target; unverified                   | target; unverified                           | gated; unverified                | `EXPLAIN (NEKI_PLAN)` single-shard checks                                      |
| Multi-region home placement      | not applicable                       | not applicable                               | hosted design pending            | home-region routing, cross-region relay, and tenant move                       |
| Migrations and restore           | development target; unverified       | target; unverified                           | gated; unverified                | migration and restore rehearsal                                                |

Topology is a separate gate. Multi-replica Railway support requires a reachable per-replica `railnet0` advertise address. A service-per-runner alternative needs equivalent evidence; `Topology.k8s` was removed from the agreed public API. Singleton support requires a two-runner uniqueness and failover test.

An unverified cell remains gated. Postgres wire compatibility is not evidence of locking, pooling, transaction, or restore equivalence.
