# Deployment

**Responsibility:** define supported operating shapes.  
**Authority:** operational.  
**Owner role:** operations/platform.
**Change policy:** a change requires operator review when a procedure or limit changes.

Deploy one runtime and one Postgres database per deployment. Select one supported shape:

- **Embedded:** provide `Actors.layer` from `durable-actors/runtime` inside the application.
- **Served:** add `Actor.serve` for HTTP, WebSocket, SSE, and OpenAPI access.
- **Hosted:** deploy served containers on our runners behind `apps/edge`, with Neki and parked sockets.

The hosted control plane uses `packages/deployments`: `Deployment`, the `Runners` singleton, and `UsageMeter` run embedded in `apps/api`. `apps/edge` resolves deployment hosts to runners, converts API keys to `Principal`, enforces limits, and owns parked client sockets. Infrastructure is Alchemy plus Railway.

Use the `durable` CLI from `apps/cli`: `login`, `dev`, `deploy`, `migrate`, and `dead-letters`. The package has no bin until the first command is implemented. Customer-served deployments do not require the hosted control plane.

Before enabling multiple Railway replicas, prove that every replica advertises a private `railnet0` address reachable by every other replica. Otherwise deploy with `Topology.k8s` or one service per runner. Also verify singleton failover and Neki conformance before claiming those capabilities.

Deployment order: provision database and secrets; run framework and actor-table migrations; start compatible runners; check `RuntimeControl.ready`; route new traffic; drain old runners. Keep database URLs redacted and set auth explicitly—`Actor.serve` requires an auth policy.
