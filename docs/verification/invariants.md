# Invariants

The 0.2 invariant names refer to the bucket engine, not SQL transactions or the retired client runtimes. The [dated 0.1 table](history/2026-10-12-invariants-0.1.md) is preserved separately.

| Id  | Guarantee                                                                               | Evidence and limit                                                                                                                      |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Only the newest create-once log epoch writes.                                           | [Store protocol](store-protocol.md), [E2](e2-recovery.md) and [E3](e3-cluster.md); no provider claim follows from memory or MinIO.      |
| I2  | Replies, state, events, sends, jobs and index entries expose only durable transitions.  | [E1](e1-execution.md), [E2](e2-recovery.md), [E4](e4-rpc-serve.md) and [E7](e7-find-operators.md).                                      |
| I3  | A discarded action leaves no staged consequence.                                        | E1 synchronous failure/defect tests and E7 index discard tests.                                                                         |
| I4  | A retained command identity applies once and returns only an authorized stored outcome. | E1 deduplication, E2 unknown append, E4 client retry, E5 derived job-call and E7 operator scope tests.                                  |
| I5  | Durable cross-shard sends are neither lost nor applied twice.                           | E3 simulator and real-process MinIO evidence.                                                                                           |
| I6  | A checkpoint plus its retained tail equals live durable state.                          | E2 recovery and E7 checkpoint/index/replay tests; E6 owns lazy pages and full history.                                                  |
| I7  | Garbage collection never deletes reachable data.                                        | E6 owns this gate; earlier filesystem/MinIO protocol tests are not a completed collector proof.                                         |
| I8a | A store's credentials and peer identity authorize no other store.                       | E3 mTLS refusal and storage protocol evidence; hosted credential issuance needs provider evidence.                                      |
| I8b | An application operation stays within its tenant.                                       | The current server refuses every non-default tenant. General multi-tenant addresses remain unverified, including general-tenant `find`. |

Each row requires a test rejecting a plausible wrong implementation, not a test count or a type declaration. [The failure matrix](02-failure-matrix.md) maps the transitions; [the support matrix](../operations/support-matrix.md) bounds current claims.
