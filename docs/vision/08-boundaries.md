# 08 — Boundaries

**Responsibility:** define product promises and explicit non-guarantees.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Akter should remove routine coordination work while naming every boundary it cannot make disappear.

## We promise

- durable actor identity with fenced generations;
- serialized command turns and one transactional local commit;
- receipts that replay successful and declared-failure outcomes;
- actor-controlled mutation of keyed state and relational rows;
- durable events with cursors;
- workflows, schedules, timers, and retryable jobs with dead letters;
- typed connections with hibernation and best-effort broadcast;
- caller and tenant attribution decided by the transport, with per-actor access policies, and tenant-aware placement;
- embedded, served, and hosted operation with one model;
- inspectable failure and recovery state.

## We do not promise by default

- global transactions across actors, shards, or external providers;
- exactly-once external side effects without provider cooperation;
- a globally consistent snapshot across regions;
- automatic incremental maintenance for arbitrary SQL;
- unbounded event retention;
- linear scale for one hot actor;
- zero-downtime relocation without availability tradeoffs;
- hostile-code isolation;
- arbitrary continuation checkpointing.

## Product boundaries

This is a full actor framework, not a workflow-only system or a standalone background-work system. It does not add a separate activities abstraction outside workflow activities and actor jobs. It does not provide a broker-like topic subsystem in v4; cross-actor fan-out uses explicit durable actor intents and projection actors.

There is no AI-specific framework layer. Contracts, receipts, cursor-based events, dead letters, workflow `waitFor`, and connections make agents straightforward to build; OpenAPI is the integration surface for external tool generation.

Durable agent orchestration belongs outside this framework; an application can use the published package, compile to actors, and keep model and sandbox execution behind jobs ([ADR 0017](../decisions/0017-m1-record-corrections.md)). This repository ships no agent runtime, and the core framework provides no first-party POSIX VM or hostile-code isolation.

Generated durable applications are a gated future product direction, not a current guarantee. Generated code must be validated, versioned, and isolated from the host; TypeScript capabilities and row-level security alone are not a sandbox.

When an application needs a stronger property, the framework should surface the tradeoff and require an explicit architecture rather than quietly weakening the guarantee.
