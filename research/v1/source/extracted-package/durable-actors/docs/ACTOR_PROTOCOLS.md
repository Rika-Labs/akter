# Protocol and transport semantics

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Use Effect Schema/RPC definitions as the basis for command input, success and error encodings. Add the actor address, durable command identity and protocol version around that contract. Do not treat TypeScript types as runtime validation or generated HTTP status codes as domain semantics.

## Envelope fields

Application/environment, actor type/id/incarnation, command ID, idempotency key or stable request identity, payload digest, protocol name/version, encoded payload, authenticated principal/grant context, causation/root submission, optional deadline and attempt metadata. Trusted fields are constructed by the gateway/runtime, not accepted verbatim from a browser.

## Outcomes

A command can be accepted, locally committed, domain-rejected, blocked for retry, dead-lettered or externally uncertain. A caller waiting for a result may disconnect. The retained submission ID is how it resumes. Infrastructure errors remain visible in addition to declared domain errors; a typed `OutOfStock` error union does not eliminate network/store failures.

## Idempotency

Same stable identity and same payload retrieves the original result within the retention contract. Same identity with different payload is a conflict. Generated retry IDs must not change on each network attempt. Store domain error outcomes as deliberately as successes when the chosen policy promises repeatable rejection.

## Versioning

Payload and result schemas may outlive code deployments. Decode only explicitly supported versions. Keep old decoders until their retained messages/events have aged out or been migrated. Internal completion messages for activities/projections also need versions; marking them internal does not make them ephemeral.

## Authorization

A typed ActorRef does not prove permission. Resolve application identity from trusted caller context and validate operation grants. Queue execution can require fresh authorization for sensitive operations. Preserve enough audit metadata to explain which policy allowed a committed action without copying secrets into receipts.

## Cross-actor calls

Public consumers import protocol/definition only. Mutating actors stage outgoing requests instead of making long synchronous calls under local write locks. Keep business reservation/compensation protocols explicit. A projection read is not an authoritative invariant check.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
