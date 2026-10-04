# ADR 0049: Observability: stable span and metric names, Prometheus, and defect spans

**Status:** accepted (2026-09-30, Dallen). Built with M4.3 ([#225](https://github.com/Rika-Labs/akter/issues/225)). It amends [observability](../operations/03-observability.md) and adds the metrics [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md), [ADR 0022](0022-workflow-engine-storage-and-version-markers.md), and [ADR 0026](0026-cross-actor-event-subscriptions.md) left to M4.3.

**Responsibility:** name the spans and metrics the runtime reports, say where each value comes from, and say where `durable defects list` reads defect spans.

**Authority:** decision record.

**Owner role:** operations/reliability.

**Change policy:** supersede through a new ADR.

## Context

[Observability](../operations/03-observability.md) named one span, `akter.<Actor>/<Command>`, and listed what operators should monitor without saying how any of it is reported. Invariant O1 requires stable names. Three accepted ADRs left metrics to M4.3: ADR 0021 a gauge of intents claimed at least 8 times and the lag of effects no runner executes, ADR 0022 `akter.workflow.pinned_events`, and ADR 0026 `akter.subscription.lag`, `.undeliverable_gaps`, `.pinned_events`, and an alert on subscription rows claimed at least 8 times. [M4](../milestones/M4.md) asks for OTLP spans for admission, turn, commit, relay, and effect execution; Prometheus metrics for mailbox age, relay lag, receipt, event and outbox growth, pool waits, and activation counts; and `durable defects list`, reading defect spans from the telemetry exporter.

The runtime already emits spans through Effect's tracer, so any Effect exporter (`OtlpTracer`) receives them. Metrics use Effect's `Metric` registry, which `PrometheusMetrics` formats.

## Decision

**Replay attribution amended by [ADR 0072](0072-served-command-in-two-round-trips.md):** replays resolve within the fenced turn, so the turn carries `turn.replayed=true` and `turn.outcome=replay`. The admission span no longer answers the receipt directly or sets `admission.replayed`.

### 1. Span names are public and bounded

| Span                            | Where                                          | Kind     |
| ------------------------------- | ---------------------------------------------- | -------- |
| `akter.admission`               | the runner that admits a command, to its reply | internal |
| `akter.<Actor>/<Command>`       | the owner's turn, admission group to reply     | server   |
| `akter.commit`                  | the turn's commit group, to the `COMMIT` reply | internal |
| `akter.relay.intent`            | one delivery of an intent, timer, or cron tick | producer |
| `akter.relay.subscription`      | one pass over a claimed subscription row       | producer |
| `akter.effect/<Actor>/<Effect>` | one executor attempt                           | client   |

- **Names never carry an id.** Actor types, commands, and effects are the deployment's declarations, so the name set is bounded; tenants, actor ids, command ids, and effect ids are attributes.
- **Attributes:** `actor.type`, `actor.tenant`, `actor.id`, `command.name`, `command.id`, `caller.kind` (`User`, `Anonymous`, or `System`), and `turn.trigger` (`command` for an external caller, else the System source: `actor`, `timer`, `cron`, `workflow`, `effect`, `subscription`) on admission and turn spans. The turn adds `actor.generation`, `turn.outcome` (`success`, `failure`, `defect`, `replay`, `acknowledged`), and `turn.replayed`; an admission that answers from a stored receipt adds `admission.replayed`. Relay spans carry `relay.attempt`; effect spans `effect.name`, `effect.id`, `effect.attempt`. No span carries a principal's subject, a credential, a payload, or state.
- **One trace per direct command.** The admission span is an ancestor of the owner's turn span, and the commit span is inside the turn. Across runners the parent travels in Cluster's envelope; the conformance case asserts the single-runner path only. A relay delivery's turn is a child of its `akter.relay.*` span. A durable hop (an outbox row, a subscription row, a workflow resume) starts a new trace on the relay: nothing in the row carries trace context, and M4 adds no column for it. The command id or effect id correlates the two sides.
- **A deterministic defect fails its turn span.** The span's exit is a failure with the defect as its cause, so an OTLP backend shows it as an error with the exception; the caller still receives `Defect`. A declared failure is a successful span with `turn.outcome = failure`.

### 2. Metrics are per runner, with bounded attributes

Names use dots; Prometheus exposition replaces `.` and `-` with `_`, so `akter.turns` is scraped as `akter_turns`. No metric carries a tenant, actor id, or command id ([data classification](../security/data-classification.md)).

Counted by the runner that did the work:

| Metric                                             | Type      | Attributes                                                     |
| -------------------------------------------------- | --------- | -------------------------------------------------------------- |
| `akter.turns`                                      | counter   | `actor_type`, `outcome` (the turn's, or `rejected`, `retried`) |
| `akter.turn.duration_ms`                           | histogram | `actor_type`                                                   |
| `akter.mailbox.age_ms`                             | histogram | `actor_type`: admission's send to the turn's start             |
| `akter.pool.wait_ms`                               | histogram | none: a turn's wait for a turn-pool session (Postgres)         |
| `akter.activations`                                | gauge     | `actor_type`: resident activations                             |
| `akter.activations.started`                        | counter   | `actor_type`                                                   |
| `akter.receipts.written` / `.replayed` / `.pruned` | counter   | `actor_type`                                                   |
| `akter.events.appended` / `.pruned`                | counter   | `actor_type`                                                   |
| `akter.outbox.staged`                              | counter   | `kind` (`intent`, `effect`)                                    |
| `akter.relay.delivered` / `.retried`               | counter   | `kind` (`intent`, `effect`, `subscription`)                    |
| `akter.effect.dead_letters`                        | counter   | `actor_type`, `effect`                                         |
| `akter.subscription.undeliverable_gaps`            | counter   | `subscriber_type`, `subscription`                              |

Sampled from the database by one runner of the deployment (a Cluster singleton), every `observability.sampleEvery` (default 15 seconds):

| Metric                             | Attributes                                     | Value                                                                                           |
| ---------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `akter.outbox.rows`                | `kind` (`intent`, `effect`, `feed`, `control`) | rows waiting                                                                                    |
| `akter.relay.lag_ms`               | `kind` (the four above, and `subscription`)    | how long the oldest due, unclaimed row has been due; 0 when none is                             |
| `akter.relay.stuck_rows`           | `kind` (`intent`, `subscription`)              | rows claimed at least 8 times and still pending                                                 |
| `akter.subscription.lag_events`    | `subscriber_type`, `subscription`              | the most source events any due row is behind its source's head                                  |
| `akter.subscription.lag_ms`        | `subscriber_type`, `subscription`              | the age of the oldest undelivered matching event of any due row                                 |
| `akter.subscription.pinned_events` | `actor_type` (the source)                      | events past `keepEvents`, inside the subscriber hold, above the lowest active row's `delivered` |
| `akter.workflow.pinned_events`     | `actor_type`                                   | events past `keepEvents` above an open execution's cursor or pending wait                       |

- **Counters and gauges are per runner.** Sum counters across runners. The sampled gauges exist on the one runner that holds the singleton; after it moves they appear on the new holder, so aggregate them with `max` over runners.
- **The samples read backlog, not stored actors.** The outbox is pending work; subscription lag reads only rows with a due time, through `actor_subscriptions_due`; pinned counts read only events past `keepEvents`, which stay only while something pins them. A series that stops appearing (a recovered subscription, an emptied kind) is reported as 0 once.
- **ADR 0026's single `akter.subscription.lag` becomes two gauges,** `lag_events` and `lag_ms`, because Prometheus gives one metric one unit. Its "alert on rows with `attempts ≥ 8`" and ADR 0021's intent gauge are `akter.relay.stuck_rows`; ADR 0021's "effect relay lag" for rows no runner executes is `akter.relay.lag_ms{kind="effect"}`.
- **Pinned counts are sampled for the actor types the sampling runner registers,** because the hold depends on each type's `keepEvents`. A deployment whose runners register disjoint types sees pinned counts only for the singleton holder's types.
- **Mailbox age crosses runner clocks.** The admitting runner stamps the request with its clock, and the owner subtracts it from its own; skew between runners shifts the observation, and negative values are recorded as 0.

### 3. `durable defects list` reads each runner's defect spans

- **Every runner keeps the defect turn spans it ended** in a bounded in-memory log (`observability.defects`, default 1,000, oldest dropped first): span name, trace and span id, time, tenant, actor type and id, command and command id, trigger, and the pretty-printed cause. The same span also goes to whatever exporter the application installs.
- **`Telemetry.serve({ auth })`** adds two routes to the application's `HttpRouter`: `GET /metrics`, the Prometheus text of every metric, unauthenticated like any scrape target; and `GET /defects?actor&sinceMs&limit`, authenticated by the given `Actor.auth` provider and filtered to the authenticated principal's tenant, as the inspector is. Serve both on an operator listener, not the public one.
- **`durable defects list --url <runner> … [--actor T] [--since 1h] [--limit n] [--token-env NAME] [--json]`** reads `/defects` from every runner named, with the bearer token from the named environment variable (`DURABLE_TOKEN` by default), and prints them merged oldest first. A restarted runner starts with an empty log; history older than the log lives in the exporter's backend, found by the trace id each line prints.
- **M4.6 replaces the tenant principal with operator authority** for `/defects` (ADR 0050).

## Alternatives rejected

- **Querying the OTLP backend from the CLI.** Every backend (Tempo, Jaeger, Axiom, Honeycomb) has its own query API; the CLI would need an adapter per backend, and a deployment without one would have no defect list.
- **A durable defect table.** Defects are telemetry, not authority, and M4.3 has no migration; a table would also need retention, tenancy, and RLS decisions of its own.
- **A background sampler on every runner.** N runners would run the same statements N times per interval for identical values.
- **Trace context in outbox and subscription rows.** It would need a migration, add bytes to every staged row, and link traces whose parent may be long gone; the command id already correlates them.
- **Per-row subscription lag series.** Rows are per source and subscriber, unbounded by the deployment's declarations.

## Consequences

- The runtime reports every metric above through the Effect `Metric` registry in the runtime's context, so an application that installs `OtlpMetrics` exports the same series over OTLP.
- `Actors.layer` takes `observability: { defects, sampleEvery }`; `@rikalabs/akter/runtime` exports `Telemetry`, `DefectLog`, `DefectRecord`, `DefectRecords`, `TelemetrySampler`, `Metrics`, and `SpanNames`.
- The internal `Request` gains `queuedAtMs`, which is not part of a command's identity or its receipt hash.
- A turn's defect now fails its span; exporters that alert on span errors see deterministic defects.

## Verification

`conformance/observability.ts`, on PGlite and Postgres:

- `names the turn span akter.<Actor>/<Command> and correlates it with the command id (O1)`: the span's name, kind, attributes, generation, and outcome; the admission span as its ancestor in the same trace; one commit span inside it; no principal in any attribute.
- `answers a retried command id from its receipt in the admission span, without a second turn`.
- `fails a defect's turn span with its cause, keeps it in the defect log, and counts it`.
- `names the relay's intent delivery, the receiver's turn, and the effect attempt`.
- `counts turns, receipts, events, and activations, records mailbox age, and exposes them to Prometheus`, with no tenant or id in the text.
- `samples outbox rows, the lag of an effect no runner executes, and intents claimed 8 times`, and the reset to 0 after delivery.
- `samples subscription lag, stuck rows, and pinned events, and counts a gap without a recipient`.

`apps/cli/src/commands/defects/list.test.ts` serves `Telemetry.serve` over a runtime whose turns defect in two tenants and checks the CLI's merge, tenant filter, actor filter, refusal without a token, and formats.

## Revisit when

- A backend needs cross-hop traces (the row would carry a `traceparent`).
- Operators need defect history across runner restarts without a telemetry backend.
- A deployment's runners register disjoint actor types and need pinned counts for all of them.
