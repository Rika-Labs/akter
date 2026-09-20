# Implementation backlog

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Epic A: actor identity and protocol

A1: choose canonical address and incarnation encoding; test collisions/untrusted input. A2: compile Effect RPC group into persisted command protocol; prove handler input/output/error inference. A3: submission receipt and query-by-ID; distinguish accepted/committed/unknown. A4: expected revision and idempotency payload conflict.

## Epic B: local durable turn

B1: migrations/internal schema. B2: storage-side fence handoff and validation. B3: command receipt lookup/save. B4: rollback/savepoint domain rejection policy. B5: local outbox/events in same transaction. B6: crash/lost-ACK oracle tests. No external I/O in this turn.

## Epic C: Cluster bridge

C1: direct PostgreSQL runner storage setup. C2: explicit persisted messages. C3: receipt-to-Cluster reply bridge. C4: stable outgoing IDs. C5: relay discovery/high-water race. C6: draining and version routing. C7: two-runner Railway reachability test.

## Epic D: actor database provider

D1: Turso libSQL endpoint capability suite. D2: deterministic provisioning catalog and retries. D3: per-actor client scope/token lifecycle. D4: lazy migration compatibility. D5: deletion/restore incarnations. D6: cost and database-count benchmark.

## Epic E: developer product

E1: actual Actor.make/toLayer API after type spike. E2: Todo/control-plane example. E3: HttpApi mapping + auth. E4: retained event journal/SSE snapshot cursor. E5: CLI inspect/submission. E6: local versus integration dev modes. E7: packed package fixtures.

## Epic F: durable capabilities

F1: timer revision/occurrence delivery. F2: Effect Workflow launch/completion bridge. F3: unknown external outcome UX. F4: BlobStore immutable upload/reference/GC. F5: optional bounded cache. F6: secret grant/version binding.

## Epic G: projections, after core gates

G1: table codec/metadata scope. G2: SQLite triggers/outbox. G3: sink schema/table identity. G4: transactional sink receipt/checkpoint. G5: snapshot/backfill. G6: deletes/key moves. G7: schema evolution/resnapshot. G8: backlog/SSRF/credential policy. G9: single-source projection actor proof, not full multi-source engine.

## Epic H: managed operation

H1: dedicated app deployment and control plane auth. H2: observability/cardinality controls. H3: provider cost metering. H4: backup/restore runbooks. H5: support/security process. H6: design partner workload. H7: release/provenance and contractual limits.

Each issue should reference its gate, threat model row, source version, expected behavior and independent test oracle. Do not estimate all epics from this document without an actual implementation spike.
