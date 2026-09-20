# Decisions summary

Research date: 2026-09-17. This is a setup-only execution package, not an implemented framework.

## Settled product/engineering direction

- Actor framework first, future agents built on it.
- `@durable-actors/core`, explicit package graph, mirrored src/test folders.
- Opinionated standard runtime with public Effect-native boundaries, not arbitrary plugin knobs.
- Definition + protocol separated from implementation Layers; direct Effect imports.
- Bun primary runtime/package manager, Node 24 LTS compatibility.
- Private actor relational data, explicit authoritative/derived-state distinction.
- Effect SQL as default; optional Drizzle rather than a new ORM.
- Customer-owned projection database; automatic projection feature is later beta.
- Typed durable submissions/results, retained event cursors and clear cancellation semantics.
- No custom storage engine, workflow engine, universal query planner or agent runtime in V1.

## Selected, conditional on experiments

| Choice | Gate |
|---|---|
| Effect v4 rc.115 ecosystem and native compiler/diagnostics tuple | G01 registry/setup/sentinel |
| Effect Cluster | G03 ownership, G04 receipt bridge, G06 network/session behavior |
| Turso/libSQL | G02 remote transaction/trigger/read/restore capabilities |
| PlanetScale Postgres | G06 direct-session advisory-lock behavior |
| Railway | G06 unique per-runner routing and drain behavior |
| Effect Workflow | G10 named execution/completion/replay bridge |
| Generated projected table triggers | G07 snapshot/replay/order/backpressure |
| Alchemy / Effect-Vite | Exact version/API/provider verification before runnable integration |

## Correctness commitments

An actor DB transaction commits state, receipt and local intentions together. PostgreSQL transport is reconciled afterward; no cross-DB atomicity is claimed. Storage-side fences reject stale writers. External side effects are not exactly-once. Projection/history retention and actor incarnations are explicit. Scope/fibers/cache/live streams do not substitute for durable state.

## Default operational choices

Memory cache first; S3-compatible BlobStore with R2 pilot; explicit secret grants with external manager; OTLP telemetry with Grafana Cloud evaluation. Blacksmith builds/tests, protected supported GitHub-hosted npm publication. Changesets/Renovate and ESM/declaration builds. No actual publication/deployment is enabled.

## Still unresolved

Exact public client syntax after a type spike; provider contractual limits/rates; remote fence/discovery proof; default projection codec set; Alchemy/Effect-Vite integration details; final license/security contact; real SLOs and public pricing; shared multi-tenant code-hosting isolation.

See docs/OPEN_QUESTIONS.md, docs/VALIDATION_GATES.md, docs/adr/, and VALIDATION.md. A documented choice is not evidence that its implementation already passed.
