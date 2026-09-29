# ADR 0053: `Actor.serve` answers readiness at `GET /ready`

**Status:** accepted (2026-09-30, Dallen; proposed 2026-09-29). It amends [ADR 0027](0027-served-protocol.md) section 1's route table and section 6's OpenAPI document.

**Responsibility:** decide how a served runner reports readiness over HTTP.

**Authority:** design decision record.

**Owner role:** runtime.

**Change policy:** supersede through a new ADR.

## Context

M4.2 ([#245](https://github.com/Rika-Labs/durable-actors/pull/245)) built `RuntimeControl` from [ADR 0003](0003-failure-scoping-drain-and-hosted-trust.md). `RuntimeControl.readiness` answers `{ ready: true }` or `{ ready: false, reason }`, and `drain` makes the runner unready before it refuses new work. A served runner had no route that exposed this. Every deployment had to wire `readiness` into a route of its own, and the hosted edge ([ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md)) had no standard way to probe a runner before routing to it. Dallen decided on 2026-09-29 that `Actor.serve` exposes readiness itself.

## Decision

1. **Route.** `Actor.serve` adds `GET {basePath}/ready` beside `/protocol` and `/command-ids`:

   | Member    | Method and path | Body | Response                                                                       |
   | --------- | --------------- | ---- | ------------------------------------------------------------------------------ |
   | Readiness | `GET /ready`    | –    | `200 { ready: true }`, or `503 { ready: false, reason }` from `RuntimeControl` |

   `reason` is one of `draining`, `drained`, `storage`, `routing`, or `unregistered`, as `RuntimeControl.readiness` defines them. A `503` tells a load balancer or the edge to stop routing to this runner; the body tells an operator why.

2. **No credentials.** Load-balancer and orchestrator probes cannot authenticate, so `/ready` takes no credentials, like `/protocol`. It reveals nothing tenant-specific: only whether this runner should get traffic, and why not. It still passes the origin and `durable-protocol` checks of every route.
3. **Never cached.** Responses carry `cache-control: no-store`, because a cached `200` would keep sending traffic to a draining runner. Each probe reads `RuntimeControl` state at once. On Postgres, the database check behind `storage` is a `SELECT 1` on the off-turn pool, reused for at most one second, so probes at any rate cost at most one query per second per runner. An embedded PGlite has one connection, which a turn holds for its whole transaction, so a probe there would queue behind any long turn and report a busy runner as a storage outage. On PGlite, readiness therefore skips the probe: the in-process database is usable for as long as the layer is.
4. **OpenAPI.** The document lists `GET /ready` as `durable.ready`, with `Ready` as its `200` response and `NotReady` as its `503` response, and without security requirements. `durable.ready` joins the reserved protocol operation ids, and `/ready` joins the paths that `openapi.path` may not take. `Actor.serve` fails at startup on either collision, as it does for the other protocol routes.
5. **Dependency.** `Actor.serve` requires `RuntimeControl`, which `Actors.layer` provides beside `InternalActors`.
6. **Liveness is out of scope.** A runner that answers `/ready` at all is alive, so a separate liveness route adds nothing. An orchestrator should restart a runner only on a failed connection or a timeout, never on a `503`: a drained runner answers `503` until its process exits, and restarting it early would cut the drain short.

## Alternatives

- **Keep wiring to each deployment.** This is what M4.2 shipped. It was rejected because every hosted and served deployment needs the probe, and the edge needs one fixed path.
- **Authenticate `/ready`.** Rejected: probes carry no application credentials, and the answer holds nothing tenant-specific.
- **Report readiness in `/protocol`.** Rejected: clients cache `/protocol` once per `baseUrl` (ADR 0027 section 9), while readiness must never be cached, and a `503` on `/protocol` would stop clients from minting ids.
- **Return the status without the reason.** Rejected: the reason is the operator's first diagnostic step, and it reveals no more than the status code does.

## Consequences

- Load balancers, Kubernetes readiness probes, and the edge probe `GET /ready` with no extra code.
- A draining runner stops getting new traffic as soon as it turns unready, before it refuses anything.
- `Actor.serve` gains a `RuntimeControl` requirement. `Actors.layer` already provides it, so an application that provides the runtime changes nothing.

## Evidence

`conformance/http.ts`, on PGlite and real Postgres:

- `answers /ready without credentials: 200 while serving, then 503 drained, and refuses commands`;
- `stays ready while a command is in flight, then answers /ready with 503 draining while a drain waits for it, and it still commits` (on PGlite it fails without the embedded-database rule in decision 3);
- `documents every served route and serves every documented one; the document is deterministic`, which now expects `durable.ready` with no security;
- `fails Actor.serve at startup when openapi.path collides with a protocol route`, which now includes `/ready`.

## Revisit when

- The edge needs readiness per tenant or per actor type rather than per runner.
- An orchestrator needs a liveness signal that differs from answering at all.
