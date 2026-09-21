# Deployment

**Responsibility:** define supported operating shapes.  
**Authority:** operational.  
**Owner role:** operations/platform.
**Change policy:** a change requires operator review when a procedure or limit changes.

The intended deployment has one shared relational database and one `Actors.layer` runtime per runner process; a deployment may have multiple runners. These operating shapes describe the accepted design, not currently implemented deployment support:

- **Embedded:** provide `Actors.layer` from `durable-actors/runtime` inside the application.
- **Served:** add `Actor.serve` for HTTP, WebSocket, SSE, and OpenAPI access.
- **Hosted:** deploy served containers on our runners behind `apps/edge`, with Neki and parked sockets.

The hosted control plane uses `packages/deployments`: `Deployment`, the `Runners` singleton, and `UsageMeter` run embedded in `apps/api`. `apps/edge` resolves deployment hosts to runners, converts API keys to `Principal`, enforces limits, and owns parked client sockets. Infrastructure is Alchemy plus Railway.

The planned `durable` CLI lives in `apps/cli`: `login`, `dev`, `deploy`, `migrate`, and `dead-letters`. These commands are not implemented; the package has no bin until the first command exists. Customer-served deployments do not require the hosted control plane.

Before enabling multiple Railway replicas, prove that every replica advertises a private `railnet0` address reachable by every other replica. A one-service-per-runner alternative requires its own reachability and failover evidence; `Topology.k8s` is not part of the current API. Also verify singleton failover and Neki conformance before claiming those capabilities.

Intended deployment order: provision database and secrets; run framework and actor-table migrations; start compatible runners; verify readiness; route new traffic; drain old runners. The `/runtime` layout reserves `RuntimeControl`, but its readiness/drain interface still needs specification and implementation; do not treat `RuntimeControl.ready` as an available API. Keep database URLs redacted and set auth explicitly—`Actor.serve` requires an auth policy.
