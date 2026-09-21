# Milestones

**Responsibility:** index the milestone documents and their delivery order.  
**Authority:** delivery plan.  
**Owner role:** delivery/runtime lead.
**Change policy:** a change requires delivery lead sign-off.

Each milestone owns a vertical slice with explicit non-goals, acceptance tests, evidence, and exit criteria. No later feature is allowed to hide an unproven earlier invariant.

These are future implementation milestones, not a claim that the framework exists or an instruction to start building it. The current reconciliation changes documentation only. Provider and recovery gates apply when their corresponding feature is introduced; their grouping under M5 does not permit claiming support before they pass.

- [M0](M0-foundation.md): framework package skeleton, Postgres runtime, fenced command turns, receipts, `ActorTest`, and database conformance
- M1: actor members, state, owned tables, events, intents, timers, effects, and retention policies
- M2: workflows, connections, hibernation, singleton cron, and activation `run` loops
- M3: served HTTP, WebSocket, SSE, OpenAPI, and the browser-safe Promise client
- M4: embedded, served, and hosted operations, tenancy, placement, observability, and recovery
- M5: Postgres and Neki conformance, multi-runner fault testing, and all verification gates
