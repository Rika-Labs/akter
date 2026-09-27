# Deployment

**Responsibility:** define supported operating shapes.  
**Authority:** operational.  
**Owner role:** operations/platform.
**Change policy:** a change requires operator review when a procedure or limit changes.

The intended deployment has one shared relational database and one `Actors.layer` runtime per runner process; a deployment may have multiple runners. These operating shapes describe the accepted design, not currently implemented deployment support:

- **Embedded:** provide `Actors.layer` from `@durable-actors/core/runtime` inside the application.
- **Served:** add `Actor.serve` for HTTP, WebSocket, SSE, and OpenAPI access.
- **Hosted:** deploy served containers on our runners behind `apps/edge`, with Neki and parked sockets.

The hosted control plane uses `packages/deployments`: `Deployment`, the `Runners` singleton, and `UsageMeter` run embedded in `apps/api`. `apps/edge` resolves deployment hosts to runners, converts API keys to `Principal`, enforces limits, and owns parked client sockets. Infrastructure is Alchemy plus Railway.

The planned `durable` CLI lives in `apps/cli`: `login`, `dev`, `deploy`, `migrate`, and `dead-letters`. These commands are not implemented; the package has no bin until the first command exists. Customer-served deployments do not require the hosted control plane.

Before enabling multiple Railway replicas, prove that every replica advertises a private `railnet0` address reachable by every other replica. A one-service-per-runner alternative requires its own reachability and failover evidence; `Topology.k8s` is not part of the current API. Also verify singleton failover and Neki conformance before claiming those capabilities.

Intended deployment order: provision database and secrets; run framework and actor-table migrations; start compatible runners; verify readiness; route new traffic; drain old runners. Keep database URLs redacted and set auth explicitly—`Actor.serve` requires an auth policy.

## Readiness and bounded graceful drain

The accepted behavior in [ADR 0003](../decisions/0003-failure-scoping-drain-and-hosted-trust.md) requires usable storage, compatible schemas, registered actors, operational routing, and a runner that is not draining before advertising readiness. Listening on a port is insufficient; waking every actor or finishing all workflows is unnecessary.

Drain makes the runner unready, stops new local admission and acquisition of additional work, and waits for in-flight work within a bounded deadline. At expiry it interrupts remaining local execution, preserves pending durable obligations, and reports deadline expiry or forced shutdown distinctly from a clean drain. Release ownership only once the old writer cannot still commit; otherwise use safe expiry and fencing before takeover. A receipt committed before reply loss remains recoverable with the original command id.

Stopping an executor cannot undo a completed external call; ambiguous provider outcomes require reconciliation or proven idempotency. Parked sockets survive activation sleep, not transport-process shutdown. Draining one runner is not deployment-wide quiescence: [restore](04-backup-restore.md) also pauses ingress and all relevant execution.

`RuntimeControl` remains unimplemented. Its concrete signatures and default deadline still need specification; no example timeout is an accepted default or availability guarantee. Verification must exercise both clean and deadline-expired drain, new-work rejection, interrupted transactions, pending delivery, safe takeover, and provider ambiguity.
