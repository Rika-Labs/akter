# Product definition and customer experience

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## The first customer

Target a small TypeScript team already using Effect that owns a stateful control plane: deployment jobs, domains/certificates, device commands or collaborative workspaces. They need recoverable commands and realtime status more than unrestricted global joins. A good first design partner can describe an actual lost-work or race-condition incident and provide a representative workload for fault testing.

## First product, not three products

Ship an actor framework with a reference self-hosted deployment. Use that framework for one substantial reference application and a small managed pilot. Do not simultaneously launch a general queue service, workflow service, SQL engine, agent framework and global application cloud. The agent package remains a future consumer of the actor API.

## Developer journey

1. Define protocol and actor-local schema.
2. Implement small repositories/domain services and an actor Layer.
3. Test locally using the in-process adapter and deterministic clocks.
4. Test production semantics against real PostgreSQL/libSQL in a separate integration lane.
5. Deploy the application image with registered actor types.
6. Submit a command, receive a stable receipt, inspect its status and follow retained events.
7. Enable an explicit projected table only when global query requirements justify the pipeline.

## Managed offering

Initially manage one application/environment per dedicated runner deployment with shared provider infrastructure only where credential/isolation boundaries are proven. Customer code is untrusted relative to other customers; an Effect Scope is not a security sandbox. A broad multi-tenant code cloud is a later security project.

Manage routing, accepted-work tracking, actor database provisioning, upgrade orchestration and observability. Provide actor-namespaced object storage. Let the customer choose/own the global query DB. Optional managed projection databases can be added only with a clear tenancy/schema model.

## Product acceptance

The first success is not a benchmark headline. A customer must reproduce a killed-runner recovery, inspect exactly which command committed, retrieve a result after disconnect, and migrate an actor database without losing queued work. Measure time-to-first-success and recovery diagnosis time against their current codebase.

## What is not delivered by this skeleton

No working actor runtime, no automatic database provisioning, no cloud authentication flow, no SDK publication and no paid plans. Those are milestones with acceptance evidence. This package gives the contracts, scope, research, build/test/release scaffolding and decisions needed to implement them.

## Sources and evidence

- [C01: Rivet actor documentation](https://rivet.dev/docs/actors) — Closest general actor platform; current feature claims must come from docs, not blanket superiority claims.
- [C04: Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) — Runtime-owned identity/storage/lifecycle; use for architectural comparison.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [T04: Turso Platform API](https://docs.turso.tech/api-reference/introduction) — Provisioning/control API is separate from SQL data-plane client.
