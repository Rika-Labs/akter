# Non-goals

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Durable Actors does not replace every API/service or database. It does not make cross-entity transactions free. It does not make mutable shared data safe merely by using Effect. It does not eliminate the need for domain validation, idempotency or operational recovery.

Do not build a custom storage engine, SQL query planner, CDC platform for arbitrary databases, schema migration inference engine, Temporal clone, Redis replacement or global scheduler before the actor kernel works. Reuse existing machinery and own only the missing integration semantics.

Do not market an API sketch as production code. Do not publish a scaffold package that declares runtime factories with no implementation and lets users discover failure after install. Source in this archive is intentionally contract-only; design examples are labelled.

Do not claim every backend is transparently swappable. SQL dialects, transactions, trigger features, authentication, provisioning and topology matter. A provider adapter needs a conformance result and documented supported limits.

Do not host all unrelated customers' projection schemas in one universal table layout. The default sink is application-owned. A future managed sink is a separate product with an explicit isolation and schema lifecycle model.

Do not treat successful exit from a fake/empty test as evidence that correctness gates pass. The validation report distinguishes scaffold checks, toolchain checks and unimplemented runtime tests.
