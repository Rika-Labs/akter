# Vision

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## The problem

Teams often assemble a database, request handlers, retry jobs, cron, websocket fan-out, caches and ownership rules around one long-lived resource. The same resource appears in multiple execution contexts and failure recovery is spread across them. Durable Actors should make that coordination boundary explicit without requiring a separate service deployment for each domain.

The first target is an Effect/TypeScript team building a control plane or collaborative stateful application: deployments, domains, build jobs, workspaces and support cases. An ordinary CRUD application with easy relational joins may be better served by shared PostgreSQL and ordinary services. We must make that tradeoff visible rather than sell actors as universally superior.

## Promise

Define an entity protocol and its behavior. Address an entity by stable identity. Give it actor-private relational state. Submit durable work, observe a retained result, and survive process replacement. The public programming model should remain the same in a local development environment, self-hosted deployment, or our managed service, subject to explicit capability and durability differences.

## What differentiates the product

The hypothesis is a coherent Effect-native programming model with excellent inspectability and safe relational projections—not a new actor concept and not a novel storage engine. Rivet already has actors and an Effect integration. Cloudflare already integrates execution and durable storage. Our advantage must be demonstrated by less integration code and better failure reasoning in actual applications.

## Non-promises

We do not promise exactly-once external effects, infinite scale for one actor, instant cold starts, zero cost per dormant identity, or unrestricted interchangeable storage engines. A projection is not a synchronous join against every actor. A durable identity does not preserve an arbitrary OS process, JavaScript stack, or in-memory fiber after a crash.

## Product sequence

Actor correctness kernel first; a useful HTTP/CLI example second; durable events and a narrow projection beta next. Managed single-tenant design-partner environments follow measured operations. Agents and a general multi-tenant code-hosting cloud are later products.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [C01: Rivet actor documentation](https://rivet.dev/docs/actors) — Closest general actor platform; current feature claims must come from docs, not blanket superiority claims.
- [C02: Rivet Effect SDK](https://rivet.dev/changelog/2026-06-16-introducing-the-effect-sdk/) — Effect integration means Effect-native alone is not differentiation.
- [C04: Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) — Runtime-owned identity/storage/lifecycle; use for architectural comparison.
