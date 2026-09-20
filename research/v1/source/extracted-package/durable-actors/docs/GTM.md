# Positioning and go-to-market

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Lead with 'durable stateful applications in Effect', with a concrete control-plane workflow and failure demonstration. Do not lead with a list of every primitive or the promise that actors replace all APIs.

## Initial wedge

Find Effect teams that already coordinate a database, jobs, timers and realtime around a domain entity. Offer an implementation partnership for a bounded service: domain/certificate provisioning, deployment orchestration or collaborative project state. The buyer should feel the operational failure/recovery problem today.

## Evidence-led demo

Submit a command; kill the runner after the local commit; reconnect; retrieve the same result; show its receipt and outgoing work; then show a schema-compatible upgrade. Compare with direct Effect Cluster and their existing request/job code. This proves a useful abstraction better than a speculative million-actor diagram.

## Adoption path

Open documentation and contracts -> usable local/self-host alpha -> packed example -> design partner -> managed dedicated pilot -> measured public beta. Community integrations come after a stable public boundary and conformance kit exist. Do not ask the community to implement the correctness kernel.

## Metrics

Time to first actor, time to diagnose a failed command, successful recovery rate in testing, number of real production workflows, retained weekly active developers, conversion from self-host exploration to managed pilot, support hours per environment and gross margin by workload. Package downloads and GitHub stars are interest signals, not revenue proof.

## Brand

Durable Actors is the umbrella. `@durable-actors/core` is the framework. Scope/trademark/domain availability is not verified by a search absence; obtain actual ownership before launch. Agents may later use `@durable-actors/agent`, but do not dilute actor execution until the foundation works.

## Sources and evidence

- [C01: Rivet actor documentation](https://rivet.dev/docs/actors) — Closest general actor platform; current feature claims must come from docs, not blanket superiority claims.
- [C02: Rivet Effect SDK](https://rivet.dev/changelog/2026-06-16-introducing-the-effect-sdk/) — Effect integration means Effect-native alone is not differentiation.
- [C04: Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) — Runtime-owned identity/storage/lifecycle; use for architectural comparison.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
