# Backend and service adapters

**Responsibility:** separate portable contracts from provider mechanics.  
**Authority:** design.  
**Owner role:** platform/runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

The public distribution is one package, `durable-actors`, with four entries: `.`, `durable-actors/runtime`, `durable-actors/client`, and `durable-actors/testing`. Provider mechanics stay behind the runtime entry; browser contracts and clients never import SQL or Cluster internals.

The primary database adapter is Postgres. It must preserve transaction scope, `SELECT ... FOR UPDATE` fencing, tenant scoping, pooling behavior, migrations, receipts, and restore semantics. Neki is a hosted-deployment adapter with an explicit outbox relay and conformance gates; wire compatibility alone is not support.

Topology adapters provide single-process HTTP sharding, Kubernetes placement, or another verified advertise-address strategy. Railway requires proof that replicas can reach each other's `railnet0` address. Transport adapters back Effect RPC, HTTP, WebSocket, SSE, and OpenAPI without changing actor semantics.

External calls are declared effects executed after commit under their retry and dead-letter policies. Blob storage, clocks, and external providers may narrow capabilities, but must report unsupported guarantees rather than silently weakening them.

The conformance suite in `durable-actors/testing` is the authority for Postgres, PGlite, and Neki behavior. See [support matrix](../operations/support-matrix.md).
