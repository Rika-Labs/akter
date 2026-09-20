# Workflow adoption decision

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Effect Workflow is the preferred reuse candidate for recoverable external work. Adoption is conditional on a bridge spike, not a blanket promise that all actor Effects become durable automatically.

## What source confirms

Activity is itself an Effect parameterized by workflow engine/instance requirements. Completed outcomes can be memoized; suspended activity bodies may execute again. This is more specific than a generic `Activities.start(fn)` API. The framework must honor names, inputs, code compatibility and replay.

## What we add

A committed actor intention needs a stable workflow execution ID, versioned workflow type and encoded input. The relay safely resolves duplicate starts. A completion command returns to the actor and carries source task revision so stale completion can be ignored. Work status and unknown outcomes appear in operator inspection.

## Prototype before abstraction

Build one workflow with a read-only external step, a provider-idempotent write step and a durable wait. Kill its worker before/after each boundary. Test replay under a new actor activation and a supported code upgrade. Inspect stored outcomes and trace IDs. If the desired actor API requires private engine internals or silently replays unsafe side effects, narrow the adapter instead of wrapping everything.

## Do not duplicate

Do not add another DAG DSL, universal saga engine or retry scheduler merely because our public service is named Activities. Use the existing engine's semantics and expose only necessary actor-aware start/status/completion capabilities. A future public workflow integration should be a separate package or subpath, not core required syntax.

## Sources and evidence

- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [C10: Temporal durable execution](https://docs.temporal.io/workflows) — Procedure replay/activity orchestration, not automatic actor-local SQL semantics.
