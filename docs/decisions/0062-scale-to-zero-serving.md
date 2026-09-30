# ADR 0062: Scale-to-zero serving

**Status:** proposed (2026-09-30). It gates M6.7 and is the last item of [ADR 0014](0014-adoption-observation-and-client-reach.md)'s order. When accepted it amends [ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md) §1, whose edge refuses a region with no ready runner, and uses [ADR 0053](0053-served-readiness-route.md)'s `GET /ready` as the edge's readiness probe.

**Responsibility:** decide how a served deployment runs with no runners, how the first request starts one, and what a cold runner guarantees.

**Authority:** design decision record.

**Owner role:** runtime and hosted edge.

**Change policy:** supersede through a new ADR.

## Context

ADR 0014 item 7 allows a request-scoped runner only after benchmarks quantify wake cost, state loading, due-work scanning, and parked-connection behavior, and requires that durable work never depend on a runner's process memory. The M6 plan narrows it: a cold runner recovers committed and due work, and parked-connection continuity is not claimed without a gateway.

What exists:

- Every durable fact is already in Postgres: receipts, state, outbox rows, timers, effects, cron ticks, workflow journals. A runner that starts on a database recovers all of it, as a restart after a crash does.
- M4.2 ([ADR 0003](0003-failure-scoping-drain-and-hosted-trust.md)) gives `RuntimeControl.drain`: unready, refuse new commands, stop claims, bound in-flight turns and effect attempts by a deadline. ADR 0053 exposes readiness at `GET /ready`.
- The hosted edge (M4.8, ADR 0031) forwards to rows of `deployment_runner` marked ready in the tenant's home region, cached for a poll interval, and answers `503 ActorUnavailable` when there are none. Nothing in the repository starts or stops runners; operators write `deployment_runner` until the `Runners` control-plane actor and providers exist.
- A self-served deployment behind a platform that starts processes on demand (Cloud Run, Fly Machines, Knative) needs nothing from the framework beyond a correct cold start and a readiness route.

## Decision

1. **A deployment opts in.** `deployment.scale_to_zero` (control-plane migration `0004_scale_to_zero`, default `false`) says the deployment may have no runners. Without it the edge refuses a region with no ready runner at once, as today.
2. **The edge asks for a runner.** When a request to a scale-to-zero deployment finds no ready runner in the tenant's home region, the edge upserts `runner_wake (deployment_id, region, requested_at)` in the control-plane database. The runner provider (the future `Runners` actor, or any process that watches the table) starts a runner, registers it in `deployment_runner` as soon as it has an address, and deletes the wake row. The table decouples the edge from providers and survives an edge restart; many edges asking at once leave one row.
3. **The edge waits for readiness, not registration.** The edge probes each registered runner's `GET <base_path>/ready` every 100 ms, each probe bounded by one second, and forwards once one answers `200`. A runner registered before it can serve, or one draining, is never sent a request. The wait is bounded by `EDGE_COLD_START_TIMEOUT` (default 30 seconds); after it the request is refused with `503 ActorUnavailable` and `retry-after`, and the client retries with the same command id.
4. **One cold start per region per edge.** Every request that finds the same region empty on one edge waits on the same cold start, and the edge writes the wake row once per cold start. Asking again while the provider's runner is booting would start a second runner; a provider whose runner never registers is recovered by the next request after the timeout, which asks again.
5. **The assertion is signed after routing.** A request's assertion is signed once a runner is ready, so a cold start does not consume the assertion's lifetime.
6. **Scaling down is the provider's drain.** To reach zero, the provider deletes the runner's `deployment_runner` row, then stops it with `RuntimeControl.drain` (SIGTERM) and exits. No runtime change is needed: pending durable work stays in the database, a turn interrupted by the drain rolls back, and a turn whose commit was sent answers the client's retry from its receipt. The edge may still forward to the drained runner for one poll interval; the runner answers `503 ActorUnavailable`, and the client retries.
7. **Due work waits for the next cold start.** No runner means no relay: timers, intents, effects, and cron ticks that come due at zero run when the next request starts a runner. They are late, never lost; cron keeps its documented rule of firing once inside `cronSkipIfOlderThan` after downtime. The edge does not wake a region for due work. A deployment whose due work must run on time keeps a runner.
8. **Parked connections end.** A drained runner closes its WebSocket and SSE sessions, and the client reconnects, which may cold-start a runner. The edge proxies sockets and holds none (ADR 0031 §4), so continuity across a scale-to-zero cycle is not claimed.
9. **Warm and cold latency are reported separately.** The `cold-start` benchmark scenario measures a served command on a warm runner and, per drill, a new runner's `/ready`, first answered command, and delivery of intents that came due at zero, all from the runner's start. The runner starts in the benchmark process, so the platform's process boot is added on top.

## Alternatives

- **A launcher interface inside the edge** that calls a provider API directly. Rejected: it binds the edge to provider credentials and APIs, and a request lost with an edge restart would lose the start request. The table keeps the edge a reader and writer of the control plane only.
- **`LISTEN/NOTIFY` for wakes.** Not chosen: ADR 0006 keeps notifications off hot paths, and a provider polling one small table is simple. A provider may add a notification later without changing the edge.
- **Waking a region for due work.** The earliest due time lives in the regional runtime database, which the edge does not read, and a runner has no credential for the control plane. Rejected until a later ADR gives the control plane that signal.
- **Forwarding to a runner once registered.** Rejected: a runner registers before it listens, and ADR 0053 made readiness the signal.
- **An idle timer in the runtime** that drains the runner itself. Rejected: whether and when to scale down is a platform decision, and the runtime needs nothing new to be stopped safely.

## Consequences

- A scale-to-zero deployment's first request after idle pays a runner start plus runtime startup; the numbers are in the performance document once T15 runs.
- Due work at zero is late by up to the idle period. Deployments with timers or cron on a schedule should not scale to zero.
- A provider must register a runner as soon as it has an address and delete the wake row when it starts one; the edge does the rest.

## Evidence

`conformance/cold-serve.ts`:

- `recovers committed and due work after scaling to zero, and runs every retried command once` (PGlite and Postgres): a committed deposit, an interrupted turn, a refused command during the drain, and an intent due while the runtime is stopped; after a cold start the committed deposit answers from its receipt without a second run, the interrupted and refused commands run once under their original ids, and the intent is delivered once;
- `cold-starts one runner for a burst of requests to a deployment with none, forwards once it answers ready, and again after it scales to zero` (the real edge on Postgres, `apps/edge/src/server.test.ts`): eight concurrent requests start one runner whose `/ready` fails three times first, and after the runner is unregistered and stopped, a retried command id starts a second runner and answers from its receipt;
- `refuses at once without a wake when scale-to-zero is off, and after the cold-start bound when no runner answers ready`.

## Revisit when

- The control plane can learn a region's next due time, so a region can be woken for due work.
- The edge holds sockets (a gateway), so a session can outlive its runner.
