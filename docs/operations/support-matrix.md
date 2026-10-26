---
title: "Support matrix"
description: "What Akter 0.2 supports today, and the evidence behind each claim."
---

# Support matrix

Akter claims support only where there is failure evidence at the real boundary. A TypeScript type, a simulator pass, or a MinIO run is not a production-provider result. Use this page to see what is covered and what is not.

## Runtime and features

| Surface                                              | Status and limit                                                                                                                                 | Evidence                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Bun 1.4.2+ and Node 24+                              | Supported runtime floors                                                                                                                         | Package `engines`                                                                                                                    |
| Synchronous actions, discard, identity               | No guarantee for external I/O                                                                                                                    | [Execution](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e1-execution.md)                                          |
| Checkpoint and tail recovery, epoch fencing          | Missing or corrupt data refuses instead of defaulting                                                                                            | [Recovery](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e2-recovery.md)                                            |
| Multi-runner routing and handoff                     | Local MinIO and simulator only                                                                                                                   | [Cluster](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e3-cluster.md)                                              |
| Effect client over WebSocket JSON and HTTP NDJSON    | No Promise, React, Python, SSE, OpenAPI, or MCP client                                                                                           | [RPC and serving](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e4-rpc-serve.md)                                    |
| Journaled jobs                                       | Ambiguous I/O still needs provider idempotency                                                                                                   | [Jobs](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e5-jobs.md)                                                    |
| Page-backed lists, retained history, GC, actor forks | Local evidence only; no production-provider or 50 GB claim                                                                                       | [Pages and history](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e6-pages-history.md)                              |
| `find` and audited operators                         | The `default` tenant; local and MinIO                                                                                                            | [Find and operators](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e7-find-operators.md)                            |
| Self-host recipe                                     | One runner by default; not provider certification                                                                                                | [Self-host](https://github.com/Rika-Labs/akter/blob/main/docs/verification/self-host.md)                                             |
| Filesystem store                                     | One host, for development and tests; no distributed or power-loss guarantee                                                                      |                                                                                                                                      |
| Memory store                                         | Tests only; not durable                                                                                                                          |                                                                                                                                      |
| Seeded simulation                                    | The single-runner and two-runner moving-owner matrices ran 10,000 seeds each on Bun and Node, over the memory bucket. This is simulator evidence | [10,000-seed run](https://github.com/Rika-Labs/akter/blob/main/docs/verification/history/2026-10-14-t7-10000-seeds.md)               |
| Provider performance                                 | Not measured on a production provider; no provider latency or throughput claim                                                                   | [Deferred](https://github.com/Rika-Labs/akter/blob/main/docs/verification/history/2026-10-14-t1-t2-provider-performance-deferred.md) |
| Akter Cloud                                          | Not covered by framework tests                                                                                                                   | [Akter Cloud](../cloud/get-started.md)                                                                                               |

## Storage providers

[Provider evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/store-providers.md) records the passing MinIO run. Cloudflare R2, Tigris, and AWS S3 have no recorded run, which means "not established", not "fails". Run `akter storage check` on your provider, region, and endpoint before you deploy.

## Known limits

- **Handoff time.** Locally, a clean handoff takes 1.1 to 3.6 seconds, and crash takeover takes 3.6 to 5.9 seconds. Four of 12 runs missed the five-second crash target. See [Deployment](./01-deployment.md#handoff-timing).
- **Tenants.** `Akter.serve` serves only the `default` tenant and refuses the others.
- **Not yet evidenced.** Restore, clock discontinuities, slow-consumer behavior end to end, and waking a stopped store need their own evidence.
- **Old docs.** Historical 0.1 verification pages describe the former implementation, not 0.2.
