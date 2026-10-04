# ADR 0087: Live runtime telemetry for the console

**Status:** implementation decision (2026-10-04), for [#574](https://github.com/Rika-Labs/akter/issues/574); extends the read-only inspector of [ADR 0028](0028-sql-inspection-views.md) and the console runtime endpoints of #577, and composes with [ADR 0082](0082-attributed-console-commands.md)'s service credential.

**Responsibility:** decide what a runner records durably and what it reports live for the console's runtime pages, how the live command stream reaches the console, and the bounds, redaction, tenant scoping and cost of each.

**Authority:** design decision record.

**Owner role:** runtime and control plane.

**Change policy:** supersede through a new ADR.

## Context

#577 answers the console's runtime pages from the inspector's durable views and leaves `null` or `NotImplemented` wherever the views hold nothing: a receipt's commit time and turn duration, per-type activity and latency, the live command stream, connection and subscriber counts, whether an actor is awake, its mailbox depth, the runner and region holding it, and schedules. Two kinds of fact are missing. Some describe a committed turn and belong with its receipt. Others exist only in a runner's memory: which activations are resident, what waits in their mailboxes, which sockets and SSE responses are open, and the turns that just committed.

The inspector is the console's only path to a runner: the control plane reaches it through the edge with its deployment service credential, the edge signs an assertion naming the deployment's tenant, and the runner filters every read to that tenant. The edge sends each request to one ready runner of the tenant's home region and holds no shard map, so one request sees one runner's memory.

No value may be synthesized. A fact nobody measured is `null` or `NotImplemented`, never zero, never extrapolated.

## Decision

### 1. Durable: receipt timing

Migration `0030_receipt_timing` adds two nullable columns to `actor_receipts`:

- `started_at_ms`: the database clock read by the batch's fenced admission statement, which the turn already selects. A batch's members share it.
- `committed_at_ms`: the database clock when the commit flight writes the receipt row, from a column default (`clock_timestamp()`), so the runtime binds nothing for it. It precedes the transaction's commit record by at most the rest of that flight.

Both are the database's own clock, without the framework's test-clock offset, so their difference is a duration on one clock. Receipts written before the migration keep `null` in both; nothing is backfilled. `durable.receipts` (version 2) adds `started_at_ms`, `committed_at_ms`, `committed_at` and `duration_ms` (`committed_at_ms - started_at_ms`). No index is added.

The console reads them as `Receipt.at` and the command log's `at` and `durationMs` (the turn from its fenced read to its receipt write: handlers included, mailbox wait, pool wait and the `COMMIT` flush excluded). `ActorInstance.lastCommand` and `lastActivityAt` are the command and commit time of the actor's receipt with the newest `committed_at_ms`, found on the receipts primary key's actor prefix.

Payloads are not stored: a receipt keeps only the payload hash, so the durable command log's `payloadPreview` stays `null`.

### 2. Live: each runner's own memory

The runtime layer owns one in-memory recorder per runner, reset when the process starts. It records:

- **Committed turns.** After a batch commits, at the point that already counts `akter.turns`, each command that wrote a receipt adds to its tenant's and actor type's one-minute bucket (the last 60 minutes) and one-hour bucket (the last 7 days): a count and a failure count per command, and one latency histogram per bucket on the `akter.turn.duration_ms` boundaries plus the bucket's maximum. Latency here is the turn's transaction time on the database clock, from the fenced admission read to the clock read after `COMMIT`. Replays wrote no receipt and are not counted.
- **Nothing else per command.** Awake activations, mailbox depths, runner placement and connections are read from state the runtime already holds when a request asks: the resident activations and their mailboxes, and the WebSocket sessions and SSE responses `Actor.serve` holds, counted when each opens and closes by tenant, actor type, actor id and kind (socket, feed, stream, watch), with each feed's event names.

Every live answer names the answering runner and its region as the deployment configured them (`Inspector.serve({ runner, region })`, `null` when unset), `since` (when this runner began recording) and `peers`, the other runners the cluster's runner storage lists. Rates cover only buckets at or after `since`: a window reaching further back holds no points for that time, not zeros. A rate divides a bucket's count by the seconds of it that were observed. A percentile is the upper bound of the histogram bucket it falls in, or the observed maximum when it falls past the last bound, and `null` when the window holds no turn.

**One runner answers.** A live answer covers one runner. When `peers` is 0 that runner holds every activation and connection of the deployment, and the console reports its numbers. When it is not, the control plane does not add up a sample of runners: endpoints that are wholly live (activity, latency, connections, the stream) answer `NotImplemented`, and live fields inside durable answers (awake, mailbox, placement, a type's rate and p99) are `null`. Fan-in across runners is not implemented; hosted deployments run one runner per release-region today ([ADR 0075](0075-deployment-and-runner-orchestration.md)).

### 3. The live command stream

The runner serves `GET <inspector>/commands/stream?type&outcome&after` as SSE: one `command` message per receipt-writing command of the principal's tenant that this runner commits, published after the commit is proven, with `id` the runner's epoch and a sequence. The control plane reads it through the edge and re-serves it as the console's `GET .../runtime/commands/stream`.

- **Cost when nobody watches.** Publishing is one map lookup that returns unless the tenant has a stream open or had one in the last 60 seconds. Only then does the runner build the entry and its payload preview.
- **Bounds.** A runner holds at most 4 streams per tenant and 64 in all, and refuses more with `ActorUnavailable`; each tenant keeps a ring of its last 256 entries while it is watched; each stream buffers at most 1,024 entries and ends with a `gap` message if it falls further behind. A stream ends when its assertion expires (at most 60 seconds); the control plane reconnects with `after` set to the last id, the runner replays from the ring, and an `after` the ring no longer holds, or one from another runner or epoch, answers `gap`. On `gap` the control plane ends the console's stream, so a reconnecting console knows it missed entries; it never skips them silently.
- **Redaction.** The preview is built on the runner from the command's payload JSON and is all of the payload that leaves it: at most 3 levels deep, 8 members per object or array, 32 characters per string, 256 characters in all, and the value under any key that names a credential or personal identifier (`password`, `secret`, `token`, `key`, `auth`, `cookie`, `credential`, `session`, `card`, `cvv`, `ssn`, `email`, `phone`, case-insensitive substrings) replaced with `"[redacted]"`. A declared failure's error value is not sent; only its tag.
- **Keepalive.** The runner writes a comment every 4 seconds and the control plane's event-stream responses one every 5 seconds, so neither the edge nor the API server, both of which close a connection idle for 10 seconds, ends a quiet stream; the API's comment also flushes headers before the first command.
- **Edge.** The edge allowlists the new inspector paths for the control plane's service credential only, as #577 did, and serves the stream without taking a connection lease from the tenant's plan allowance: the control plane is not the tenant's client, and the runner's caps bound it. A tenant credential on these paths stays an unsupported billing route.

### 4. Schedules

Schedules are declarations plus durable rows, so every runner answers them alike. `GET <inspector>/schedules` lists each cron entry the runtime registers (actor type, command, expression) with the tenant's soonest pending tick from `durable.timers` (`null` when no actor of the type holds one) and the newest committed tick receipt (caller source `cron`) among the type's newest 10,000 receipts by expiry, with its commit time, outcome and duration, `null` when none is found there.

### 5. Tenant scoping

Every live read and the stream are filtered to the authenticated principal's tenant, like the durable reads, and the edge signs only the deployment's own tenant for the service credential. The control plane checks project read access before it asks. Live state of other tenants on the same runner is never returned, and counts are keyed by tenant, so a tenant cannot learn another's activity from totals.

### 6. Hot-path cost

Each committed command adds one bound `bigint` and one column default to its receipt insert, and one recorder update: two map lookups, three counter increments and a histogram bucket increment. The stream adds one map lookup unless the tenant is watching. The serve layer adds a counter change per connection, not per command. The recorder's memory is bounded by the active tenants, actor types and commands in the last 7 days; buckets older than their ring are dropped on write and read.

## Contract changes

- `TurnLatency` percentiles are nullable (an empty window has none); `ActorTypeActivity` and `TurnLatency` carry `since`.
- `ConnectionsSummary.parked`, `replayGaps`, `openVersusParked` and `byActorType[].parked` are nullable: runners do not measure them.
- `Schedule.nextRunAt` is nullable.
- `CommandCaller.kind` is `user`, `anonymous` or `system`; there is no `apiKey` kind, since a runner records an API key's command as `User` with subject `api-key:<id>` ([ADR 0082](0082-attributed-console-commands.md)).

## Alternatives

- **Activity and latency from receipts.** Exact across runners and restarts, but each console read would scan every retained receipt of a type, since only `(actor_type, expires_at_ms)` is indexed; a `(tenant_id, actor_type, committed_at_ms)` index would add a B-tree insert to every command, and retention ends at the retry window, short of 7 days.
- **Persisted rollups.** Each runner flushing its buckets to a table would survive restarts and add up runners. It needs a table outside the routing-key layout, a flush and pruning loop, and loses a crashed runner's last interval; it is the path when multi-runner deployments need fan-in.
- **Commit time on the turn's own clock.** The runner's clock after `COMMIT` cannot be written into the row that commit made durable; a second write would double the receipt's cost.
- **Stream from the durable log.** Polling receipts by `committed_at_ms` needs the same per-command index, and still carries no payload.
- **Full payloads in the stream.** Would make the inspector a second path to tenant data that the receipts read deliberately withholds.

## Consequences

- Receipts committed after the migration carry their timing; older ones show `at: null` until they expire.
- The console's live numbers restart from `since` on every runner start, deploys included, and are reported only while one runner serves the deployment.
- The control plane holds one upstream SSE per console stream and reconnects at least once a minute.

## Evidence

Hot-path cost was measured on the #529 Daytona harness (one 4-CPU sandbox, app and Postgres on three pinned CPUs, driver on the fourth, three ordered before/after rounds against `origin/main` `15fa78f3c`): sequential 468 against 432 op/s, 64 callers over 10,000 keys 1,627 against 1,589 op/s, 256 callers 1,415 against 1,446 op/s (medians, every range overlapping), with app CPU per command 0.751 against 0.766 ms (spread) and 0.884 against 0.856 ms (overload). A first round, in which the recorder ran as its own Effect per batch, read 0.755 against 0.796 ms; the recorder is now a plain function called after the existing metrics. The difference is inside run-to-run noise.

The `inspector` conformance cases run real turns on Postgres and check receipt timing against clocks read around each command, the recorder's counts against the commands sent, the stream's entries and redaction, and tenant isolation. The `apps/api` stack scenario deploys a real runner behind the real edge and checks activity, latency, receipts, the stream, connections and schedules through the console API, with values derived from the commands the test sent, refusal to another organization, and the edge's allowlist.

## Revisit when

- A deployment runs more than one runner per release-region and the console needs its live numbers: persisted rollups or an edge fan-in.
- The console needs history across restarts.
