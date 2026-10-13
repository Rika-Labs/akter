---
title: "Support matrix"
description: "Akter 0.2 runtime, bucket, client, and milestone evidence boundaries."
---

# Support matrix

Support requires failure evidence at the actual boundary. A proposal, TypeScript type, simulator pass, or MinIO run is not a production-provider result.

| Surface                                            | Evidence and limit                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Bun 1.4.2+ and Node 24+                            | Both supported runtime floors; exact local versions are recorded in milestone evidence                                    |
| Synchronous actions, discard, identity             | [E1 evidence](../verification/e1-execution.md); no external-provider I/O guarantee                                        |
| Checkpoint/tail recovery and epoch fencing         | [E2 evidence](../verification/e2-recovery.md); missing/corrupt data refuses rather than defaults                          |
| Multi-runner routing and handoff                   | [E3 evidence](../verification/e3-cluster.md), local MinIO and simulator; production peering amendment remains provisional |
| Effect client over WebSocket JSON and HTTP NDJSON  | [E4 evidence](../verification/e4-rpc-serve.md); no Promise, React, Python, SSE, OpenAPI, or MCP facade                    |
| Journaled jobs                                     | [E5 evidence](../verification/e5-jobs.md); provider idempotency is still required for ambiguous I/O                       |
| Self-host recipe                                   | [Local recipe evidence](../verification/self-host.md); one runner by default, not provider certification                  |
| Filesystem store                                   | Local one-host adapter for dev/tests; no distributed or power-loss guarantee inferred                                     |
| Memory store                                       | Test-only, non-durable                                                                                                    |
| Page-backed lists, retained history, GC, forks     | E6 target; schema/list reads alone do not prove races or unlimited-storage guarantees                                     |
| Owner-held persisted indexes and audited operators | E7 target; check the corresponding failure evidence before claiming complete support                                      |
| Hosted rollout, tenant isolation, billing, quotas  | E8 and private platform evidence; not established by framework tests                                                      |

## Providers

[Store provider evidence](../verification/store-providers.md) records the passing MinIO version and date and slots for actual R2, Tigris, and AWS S3 runs. No production-provider support is claimed here. Run `akter storage check` on the intended provider, region, and endpoint before deployment.

## Timing and unresolved guarantees

Under the required defaults, E3 local clean moves take about 15 seconds and crash takeover about 31 seconds. The five-second target is not met. General served tenant addresses are also incomplete: `Akter.serve` currently accepts only tenant `default`. Restore, clock discontinuity, slow-consumer end-to-end behavior, and hosted wake orchestration need their own evidence. Historical 0.1 verification pages describe former implementations, not support for this branch.
