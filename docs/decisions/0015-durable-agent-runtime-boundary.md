# ADR 0015: Durable agent runtime boundary

**Status:** accepted product direction; implementation and provider evidence gated (2026-09-23)

**Responsibility:** define the framework's agent-runtime direction without turning the actor core into an AI product.

**Authority:** product and architecture direction.

**Owner role:** runtime/product.

**Change policy:** supersede with a new ADR when the authority or isolation boundary changes.

## Context

Rivet agentOS combines an agent session with a durable actor and an isolated VM. Rebuilding its Rust kernel, virtual filesystem, process model, and guest networking would duplicate a mature and difficult subsystem. Akter already has stronger primitives for transactional business state, caller attribution, receipts, effects, workflows, and relational observation.

## Decision

The future agent runtime is an adapter package, not a new framework primitive. It defines an ordinary actor contract with:

- durable transcript, budgets, approvals, tool calls, and workspace metadata in actor-owned state/tables/blobs;
- model calls and sandbox calls as retryable effects with provider-specific reconciliation;
- token deltas as live broadcasts, with completed semantic events persisted;
- approvals as actor-owned workflow waits;
- an explicit fork operation that copies durable rows and shares content-addressed blobs;
- a replaceable `Sandbox` provider boundary for Firecracker, containers, agentOS, or no sandbox for typed-tool agents.

The database is authoritative. A sandbox is disposable activation-local compute and may be recreated after hibernation or failure. No model response or tool call is retried blindly when the provider cannot prove idempotency; unknown outcomes remain visible for reconciliation.

The package may expose a declarative helper such as `Agent.definition(...)`, but it must compile to `Actor.make` and must not add a second actor lifecycle or mutation path. The core `akter` package remains AI-neutral.

## Consequences

This direction can enforce budgets and approvals transactionally, query many agents with ordinary SQL, export/fork state, and swap compute providers. It does not provide a POSIX or hostile-code isolation environment itself. Provider conformance and pricing remain separate work.

## Alternatives rejected

- Copying agentOS's VM/kernel stack: large scope, poor leverage, and a race on cold-start and sandbox maturity.
- Persisting the filesystem as the sole agent authority: strong session ergonomics but weak relational reporting, budget accounting, and cross-agent governance.
- Making agent concepts part of `Actor.make`: reduces reuse and violates the product boundary that an agent is an actor workload, not a second runtime.

## Evidence and revisit conditions

M7 requires tests for crash/retry reconciliation, budget races, approval recovery, transcript ordering, fork isolation, blob sharing, and sandbox loss. Revisit if customers consistently require first-party POSIX isolation rather than durable agent orchestration, or if external sandbox providers cannot meet the required latency and cost envelope.

See [illustrative API sketches](../api/post-foundation-sketches.md) and the [research sources](../../research/v5/SOURCES.md).
