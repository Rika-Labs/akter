# Benchmark plan

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Questions to answer

How expensive is a private DB per actor? How much latency does the cross-store receipt/relay path add? When does a projection actor beat a direct indexed PostgreSQL query? How many dormant identities can the catalog and provider plan sustain? None of these is answered by the number of Effect fibers.

## Workload matrix

Measure hot actor read/write, cold existing DB activation, brand-new DB provision, one versus many actor keys, payload sizes, transaction write amplification, outbox batches, projector throughput, SSE fan-out and reconnect storms. Include direct PostgreSQL and a simple shared-store implementation as baselines. Use realistic data distributions including hot keys and skewed tenant traffic.

## Method

Publish hardware/region, provider tier, runtime/compiler/package versions, connection pooling, concurrency, dataset size, indexes, warmup, run length and error rate. Report p50/p95/p99, not only average or peak throughput. Include CPU/RSS, provider requests, bytes and estimated cost per successful committed command. Do not compare local SQLite to remote PostgreSQL while attributing the difference to actors.

## Projection experiment

Run identical board queries against indexed PostgreSQL, a cached API, a hot projection actor with remote SQLite, and a cold projection actor. Measure update cost and freshness lag in addition to read latency. Specialized SQLite indexes may reduce query work but add duplicated storage and write amplification. Choose the projection actor only if the full workload benefits.

## Tools

Use k6 or another HTTP/SSE/WebSocket load tool for external traffic, and a typed Effect internal harness for command semantics. Use dedicated repeatable CI runners for trends. Do not treat noisy shared CI performance as a production SLA. Flamegraphs/profiles diagnose bottlenecks after a representative case reproduces them.

## Release policy

Initial targets are experimental budgets, not marketing claims. Store baseline artifacts by version and investigate regressions above an agreed threshold. Correctness failures always dominate performance wins.

## Sources and evidence

- [D06: Blacksmith documentation](https://docs.blacksmith.sh/) — CI runner labels, cache and security model; runner availability is account-dependent.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [T02: Turso pricing](https://turso.tech/pricing.md) — Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.
- [D04: Railway resource pricing](https://railway.com/pricing) — Meter and plan source; model unverified rates as assumptions.
