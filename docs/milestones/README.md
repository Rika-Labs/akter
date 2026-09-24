# Milestones

**Responsibility:** index the milestone documents and their delivery order.  
**Authority:** delivery plan.  
**Owner role:** delivery/runtime lead.
**Change policy:** a change requires delivery lead sign-off.

Each milestone owns a vertical slice with explicit non-goals, acceptance tests, evidence, and exit criteria. No later feature is allowed to hide an unproven earlier invariant.

M0's embedded Postgres foundation is complete, and M1 is in progress; later milestones remain planned. Provider and recovery gates apply when their corresponding feature is introduced; their grouping under M5 does not permit claiming support before they pass.

- [M0](M0-foundation.md): framework package skeleton, Postgres runtime, fenced command turns, receipts, `ActorTest`, and database conformance
- [M1](M1.md): actor members, state, owned tables, blobs, events, intents, timers, effects, server reducers, and retention policies
- M2: workflows (including version markers and deployment compatibility checks), connections, hibernation, singleton cron, and activation `run` loops
- M3: served HTTP, WebSocket, SSE, OpenAPI, and the browser-safe Promise client
- M4: embedded, served, and hosted operations, tenancy, placement, observability, and recovery
- M5: Postgres and Neki conformance, multi-runner fault testing, and all verification gates
- M6 (planned): adoption of existing Postgres schemas, bounded live-query observation, inspection/export, offline clients, generated MCP and language clients, and scale-to-zero serving
- M7 (withdrawn): the durable agent runtime is Outlast, a separate product ([ADR 0017](../decisions/0017-m1-record-corrections.md)); features it needs from the framework are scheduled in ordinary milestones
- M8 (gated): generated durable applications with validation, isolation, versioned activation, and rollback
