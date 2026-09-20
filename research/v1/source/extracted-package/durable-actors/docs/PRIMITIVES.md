# Per-actor primitives

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

| Primitive | Meaning | Persistence / transaction | Provisioning |
|---|---|---|---|
| Database | Actor-private relational authority | Local fenced turn | Scoped client, provider DB |
| Actors | Typed peer addressing/submission | Durable transport path as specified | Shared runtime capability |
| Events | Retained committed domain history | Same local commit when appended | Internal actor tables |
| Scheduler | Future named messages | Local intent then control-store delivery | Shared runtime |
| Activities | External recoverable work | Local launch intent + workflow engine | Shared workers/provider capabilities |
| BlobStore | Large immutable artifacts | External object plus committed reference | Shared bucket namespace |
| Secrets | Authorized read-only credentials | External manager, never projection data | Scoped grant/version |
| Broadcast | Live notifications | Ephemeral after commit | Shared gateway fan-out |
| Cache | Recomputable optimization | Disposable | Memory first, shared cache optional |
| Clock/tracing | Standard Effect time/telemetry | Not durable state by themselves | Runtime-provided Effect services |

## Minimal mandatory core

Database authority, typed address/protocol, committed receipt/outbox and lifecycle are the irreducible kernel. Timers/events/work bridge are standard runtime features introduced only with their conformance tests. Blob/cache/secrets are standard capabilities, not independent servers per actor. Do not require all infrastructure to boot a simple local Counter.

## Uniform API, honest semantics

`const db = yield* Database` and `const blobs = yield* BlobStore` are ergonomic, but they have different atomicity. The service syntax cannot imply one transaction includes both. Methods must make staged work versus direct external I/O clear.

Keep infrastructure names in adapters: Turso/libSQL, PostgreSQL, S3/R2, Valkey and secret manager. Public contracts describe behavior and limits. A backend swap is supported only when conformance and operational feature compatibility are documented.

## Sources and evidence

- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [A01: S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) — Object-store consistency does not create atomicity with actor database commits.
- [A04: Valkey](https://valkey.io/) — Shared ephemeral cache candidate; loss must not affect correctness.
- [A09: AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) — Choose control-plane-managed secrets, grants, rotation and audit.
