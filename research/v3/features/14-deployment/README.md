# 14 — Local, self-hosted, cloud and managed private

**Status:** accepted deployment direction; infrastructure sizing, packaging and provider compatibility remain unverified.

[Index](../../README.md) · [Sources](../../SOURCES.md) · [Operations](../15-operations/README.md) · [Testing](../16-testing/README.md)

## One runtime model

```diagram
                      Actor application
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        Local / tests    Self-hosted       Our public cloud
        same contracts   Postgres          PlanetScale Neki
        test adapters    own operations    managed by us
                              │
                              ▼
                     Managed private/BYOC
                     customer boundary,
                     vendor-operated deployment
```

The framework, required Postgres path, adapters and recovery tooling should be OSS. Self-hosting requires no vendor account or hosted control plane. The exact license is still to be chosen. This does not assert that Neki itself is open-source/self-hostable.

## Proposed application and runner

```ts
const application = Actors.application({
  actors: [Chat, Board],
  authorize: accessPolicy,
})

// Self-hosted: placeholders use runtime secret resolution.
const program = application.serve.pipe(
  Effect.provide(PostgresRuntime.layer({
    databaseUrl: Config.redacted("DATABASE_URL"),
    blobs: BlobStorage.s3({
      bucket: Config.string("BLOB_BUCKET"),
      credentials: workloadIdentity,
    }),
  })),
)
```

The cloud supplies a Neki-backed runtime layer. Customers using our service do not need their own PlanetScale account. Managed private/BYOC uses the same contracts in an agreed customer environment; control-plane access, telemetry egress, keys, operational responsibility and disaster recovery must be explicit, not implied by the word VPC.

Bun/Node compatibility is a target inherited from the architecture. Minimum versions and driver support require a tested matrix. Components may run all-in-one locally or as separately scaled actor, worker, gateway and query-service roles. Do not introduce a new runtime implementation for each role.

## Postgres and Neki are not interchangeable transaction systems

- Put all turn-owned business rows, inbox/receipt/event/timer/intent records in the same routed transaction domain.
- On the reviewed Neki interface, set `__neki.tx_mode = 'single'` on the actual connection before BEGIN. Verify routing against the current provider release.
- Validate actor colocation, unique-key locality and runtime polling paths with real query plans; protocol compatibility is not sufficient.
- No global atomic cross-shard transaction or shared fanout snapshot claim.
- Distributed schema changes can partially apply; expose migration progress and prevent incompatible code from running against incomplete schema.
- RLS/session settings, CDC/before-images and required driver behavior must pass Neki-specific gates.
- Actor routing key/hash must be stable and versioned independently of assumptions about Effect internals. The historical fixed 300-bucket scheme is not an accepted decision.

## Local development and growth

Local dev should run the same command, receipt, ownership, event and work protocols, with convenient storage/blob/test-clock adapters. PGlite is a candidate for quick feedback, not proof of multi-process behavior. Real Postgres development should remain available.

Avoid mandatory external brokers/caches for the basic deployment. The connection gateway and live-query engine add logical responsibilities, but may share a supervised process until measured isolation needs justify separation.

Cells/regions are operational topology, not an everyday actor API. Initial fixed home and independent transaction domains are candidate simplifications. Automatic regional relocation, nearest-on-create placement, multi-master writes and lowest-cost millions-idle claims are not approved guarantees.

## Validation gates

1. Start an air-gapped/self-contained Postgres deployment and exercise commands, blobs, realtime, background work and recovery without contacting our cloud.
2. Run conformance on actual multi-shard Neki, including resharding/topology changes and partial DDL where supported.
3. Inspect plans for actor initialization, receipts, events, transfer coordinator and timer/work polling; identify every cross-shard operation.
4. Run local and production adapters against the same invariant suite; publish meaningful differences instead of calling them equivalent by name.
5. Simulate gateway/worker/actor process restarts independently; no role transition relies on hidden process-local authority.
6. Verify a managed-private deployment's network flows, administrative access and recovery ownership against its declared boundary.

No infrastructure provisioning, deployment, paid-provider access, or shared database writes are authorized by this research document.
