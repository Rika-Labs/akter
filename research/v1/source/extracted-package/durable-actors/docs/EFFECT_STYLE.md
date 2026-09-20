# Effect service and Layer style

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Adopt from OpenCode selectively

The inspected OpenCode conventions favor small service modules, explicit interfaces, Context.Service, named Effect.fn operations, explicit Layers and ordinary private helpers. These are useful. Its application-specific workspace InstanceState/global managed-runtime patterns must not become actor lifetime or durability by analogy.

## Contract and construction

```ts
// Illustrative v4-style capability declaration; no implementation here.
export interface Interface {
  readonly read: (key: string) => Effect.Effect<Uint8Array, ReadFailure>
}
export class Service extends Context.Service<Service, Interface>()(
  "@durable-actors/BlobStore",
) {}
```

Provide concrete behavior in an adapter Layer. Do not let a supposedly core defaultLayer construct a hosted SDK or environment credential behind the user's back. Defaults belong in the opinionated application runtime assembly.

## Lifetimes

A service that captures an actor database is activation-specific. Its operations must use the current turn transaction when mutating. Do not acquire actor resources once in a process-wide Layer and assume the service tag scopes itself automatically. Scope teardown is graceful cleanup, not the recovery log.

## Requirements

Keep service interfaces focused on their behavior and typed failure; Layer construction captures fixed dependencies. Preserve dynamic requirements deliberately when an operation truly needs turn context. Do not force `R=never` with casts. Layer.provide binds inputs; merge combines outputs without satisfying arbitrary sibling inputs.

## External operations

Use Effect HTTP/fs/process/time/config services rather than raw global calls inside portable behavior. An SDK Promise boundary is acceptable when no native service exists; wrap and test it at one adapter boundary. Do not run Effect.runPromise/runSync inside normal service methods. That breaks context, cancellation and structured lifetime.

## Error/cancellation behavior

Use typed expected errors with enough recovery information. Do not catch everything and retry forever. Interruption closes the current computation; it does not prove a remote operation never committed. Durable work records distinguish attempt interruption from logical command cancellation.

## Version discipline

Check examples against the pinned v4 source. Do not mix v3 `Context.Tag`/Layer examples or older OpenCode API spellings into package source without a compatibility test. The scaffold contains only minimal service/type boundaries until the public API spike is complete.

## Sources and evidence

- [O01: OpenCode service conventions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md) — Flat modules, small Interface, Context.Service, layer/defaultLayer, named Effect.fn, scoped workspace state. Application conventions are not actor semantics.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
- [E01: Effect v4 package snapshot](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/package.json) — Inspected source snapshot identifies 4.0.0-rc.115. A repository version is not proof that every registry artifact is available.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
