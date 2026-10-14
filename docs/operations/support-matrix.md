---
title: "Support matrix"
description: "Akter 0.2 runtime, bucket, client, and milestone evidence boundaries."
---

# Support matrix

Support requires failure evidence at the actual boundary. A proposal, TypeScript type, simulator pass, or MinIO run is not a production-provider result.

| Surface                                            | Evidence and limit                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun 1.4.2+ and Node 24+                            | Both supported runtime floors; exact local versions are recorded in milestone evidence                                                                                        |
| Synchronous actions, discard, identity             | [E1 evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e1-execution.md); no external-provider I/O guarantee                                             |
| Checkpoint/tail recovery and epoch fencing         | [E2 evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e2-recovery.md); missing/corrupt data refuses rather than defaults                               |
| Multi-runner routing and handoff                   | [E3 evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e3-cluster.md), local MinIO and simulator; production provider behavior remains open             |
| Effect client over WebSocket JSON and HTTP NDJSON  | [E4 evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e4-rpc-serve.md); no Promise, React, Python, SSE, OpenAPI, or MCP facade                         |
| Journaled jobs                                     | [E5 evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e5-jobs.md); provider idempotency is still required for ambiguous I/O                            |
| Self-host recipe                                   | [Local recipe evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/self-host.md); one runner by default, not provider certification                       |
| Filesystem store                                   | Local one-host adapter for dev/tests; no distributed or power-loss guarantee inferred                                                                                         |
| Memory store                                       | Test-only, non-durable                                                                                                                                                        |
| Page-backed lists, retained history, GC, forks     | [E6 local evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e6-pages-history.md); actor forks only, no production-provider or 50 GB claim              |
| Seeded simulation at 10,000 seeds (T7)             | [T7 run](https://github.com/Rika-Labs/akter/blob/main/docs/verification/history/2026-10-14-t7-10000-seeds.md) on the memory bucket; simulator evidence, not provider evidence |
| Provider performance (T1/T2)                       | Not measured on a production provider; no provider latency or throughput claim. Local MinIO diagnostics in `BENCHMARKS.md` are not a T1/T2 pass                               |
| Owner-held persisted indexes and audited operators | [E7 evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e7-find-operators.md) for the `default` tenant, local and MinIO; no provider or hosted claim     |
| Hosted rollout, tenant isolation, billing, quotas  | E8 and private platform evidence; not established by framework tests                                                                                                          |

## Providers

[Store provider evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/store-providers.md) records the passing MinIO version and date and slots for actual R2, Tigris, and AWS S3 runs. No production-provider support is claimed here. Run `akter storage check` on the intended provider, region, and endpoint before deployment.

## Timing and unresolved guarantees

Under the required defaults, E3 local clean moves take about 15 seconds and crash takeover about 31 seconds. The five-second target is not met. General served tenant addresses are also incomplete: `Akter.serve` currently accepts only tenant `default`. Restore, clock discontinuity, slow-consumer end-to-end behavior, and hosted wake orchestration need their own evidence. Historical 0.1 verification pages describe former implementations, not support for 0.2.
