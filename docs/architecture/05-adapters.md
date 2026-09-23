# Backend and service adapters

**Responsibility:** separate portable contracts from provider mechanics.  
**Authority:** design.  
**Owner role:** platform/runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

The public distribution is one package, `durable-actors`, with four entries: `.`, `durable-actors/runtime`, `durable-actors/client`, and `durable-actors/testing`. Provider mechanics stay behind the runtime entry; browser contracts and clients never import SQL or Cluster internals.

The primary database adapter is Postgres. It must preserve transaction scope, `SELECT ... FOR UPDATE` fencing, tenant scoping, pooling behavior, migrations, receipts, and restore semantics. Neki is a hosted-deployment adapter with an explicit outbox relay and conformance gates; wire compatibility alone is not support.

Supported data-access adapters automatically derive tenant, actor ownership, phase, and transaction binding from the runtime context. An application chooses the integration at composition time and supplies only business fields and filters during ordinary actor-row access. The framework owns the scoping rule; adapter-specific builders translate it without requiring application ownership predicates or permitting caller overrides.

Query-client integrations and database backends have different obligations. A query-client integration must use the configured backend's turn connection and preserve scoped operations; a backend must also prove fencing, business rollback with retained failure receipts, migrations, and recovery. Neither is permission to use an independent pool for turn writes. Captured transaction-bound capabilities must reject use after the turn, and concurrent contexts must not share mutable ownership state.

Drizzle/Postgres is the first target, not an exclusive long-term integration. Other adapters require an operation matrix and the same conformance cases before support is claimed. Mutations use scoped operations, with `group` reserved for read-only joins within the placement group; advanced mutations require additional evidence. Do not build a universal query language, promise arbitrary ORM/database support, or treat TypeScript wrappers and optional RLS as sufficient authority. Missing scope or an unsupported operation fails closed. See [ADR 0003](../decisions/0003-failure-scoping-drain-and-hosted-trust.md).

Topology adapters provide single-runner operation or HTTP-connected runners using verified advertise addresses. Kubernetes topology was removed from the current public surface. Railway requires proof that replicas can reach each other's `railnet0` address. Transport adapters back Effect RPC, HTTP, WebSocket, SSE, and OpenAPI without changing actor semantics.

External calls are declared effects executed after commit under their retry and dead-letter policies. Framework blobs are database-backed chunks, not an external object-storage adapter. Runtime clocks use Effect `Clock` so tests can control time. Application provider integrations may narrow capabilities, but must report unsupported guarantees rather than silently weakening them.

The conformance suite in `durable-actors/testing` is the authority for Postgres, PGlite, and Neki behavior. See [support matrix](../operations/support-matrix.md).
