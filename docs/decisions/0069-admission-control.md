# ADR 0069: Admission control: shed load with `ActorUnavailable` and `retry-after`

**Status:** implementation decision (2026-10-03), for #494; amends ADR 0019's mailbox mapping.

**Responsibility:** keep accepted commands' latency bounded when offered load exceeds what a runner can serve.

**Authority:** design decision record.

**Owner role:** runtime and reliability.

**Change policy:** supersede through a new ADR.

## Context

Open-loop writes past a runner's capacity queued for seconds (BENCHMARKS.md, open loop: p50 4.2 s and p99 4.7 s at 2,000 offered/s with 944/s served). Nothing refused work early. A command could wait in five places, none bounded by default:

- the accept path: once the Bun event loop is saturated, requests sit unseen in their sockets before any handler runs;
- the dispatch fibers between `Actors.execute` and the Cluster send, including the pre-delivery read on the off-turn pool;
- Cluster's entity mailbox, set to `unbounded` for every actor without `policy.mailboxCapacity`;
- the activation mailbox, which holds every command Cluster delivered until its batch commits;
- the turn and off-turn pool waiter lists.

`ActorUnavailable` already answers `503` with `retry-after`, carries no command effects, and callers can retry it under the same command id; served clients already support that retry metadata.

## Decision

1. **Runner admission.** `Actors.layer({ admission: { concurrency, wait, requests } })`. At most `concurrency` external commands (default 64) run at once, from admission to reply. Up to `concurrency` more wait for a slot in arrival order, each at most `wait` (default 100 ms); a freed slot goes to the oldest waiter. Any other command, and a waiter whose wait runs out, fails `ActorUnavailable` with an internal overload marker before anything of it runs. Relay deliveries are not counted: their concurrency is bounded by the relay.
2. **Serve entry.** A runtime-wide `admission.requests` gate (default 64) admits command request handlers before authentication and body parsing, across all of that runtime's serve layers. The next handler receives `503 ActorUnavailable` with `retry-after` immediately. There is no server-side request waiter queue. Queries are not counted in this command gate; their SQL checkouts are bounded separately. This bounds application request processing, not a kernel socket backlog or an upstream proxy's queue. A loop-lag heuristic was removed because unrelated CPU pressure could refuse ordinary protocol tests and it cannot prove the length of an upstream queue.
3. **Activation and Cluster mailboxes.** An actor without a declared `mailboxCapacity` is registered with a Cluster mailbox of 1,024 commands, which bounds the activation mailbox too, since a command stays in Cluster's active requests until its reply. Past it, dispatch answers `ActorUnavailable` (an internal overload marker) when the activation is resident. `MailboxFull` stays reserved for a declared capacity, so no handle type changes; a non-resident rejection is still `RunnerAtCapacity`.
4. **No in-place retry of a refusal.** Dispatch retries other `ActorUnavailable` failures until `deliveryTimeout`; an overload-marked refusal is returned at once, because retrying it inside the runner would rebuild the hidden queue as sleeping fibers.
5. **Pool checkout bounds.** Turn, off-turn and replica pools hold at most their connection capacity plus 64 checkout attempts. Excess checkouts fail before sending a statement, including queries and background traffic. Slots follow the connection scope; cancellation frees them. A failed turn-pool checkout is identified before any fence or handler work and is returned as an overload refusal without restarting or retrying the command in place. Ordinary SQL failures retain their existing retry/unknown-outcome semantics. Pool capacity is separate from runner admission, because query and background callers do not use command admission.

A refused command never reached a turn: it writes no receipt and changes no state, and its retry under the same command id runs it at most once. Admitted commands keep exactly-once semantics, because admission changes only transient scheduling and connection acquisition, not fence, receipt, handler, or commit ordering.

## Alternatives

- **A fixed in-flight limit with immediate refusal.** Measured first. 64 slots capped throughput near 670/s on the benchmark container, because transient stalls (cold activations, collections) filled the slots and every arrival during them was refused; 128 and 256 slots refused almost nothing at 2,000/s while requests queued for seconds in the accept path, which no in-process counter sees.
- **Refuse inside the activation.** The internal overload marker must survive runner RPC serialization; a local-only error subclass would lose that distinction and be retried in place. The public HTTP envelope still exposes no cause or internal marker.
- **Bound pool waiters with an acquire timeout.** A timed-out turn would fail its whole batch and restart the activation after work was done; admission refuses the same load before any of it.
- **`MailboxFull` for the default bound.** It would add `MailboxFull` to every handle's error type and change a documented reason's meaning.

## Evidence

Final performance collection runs in one 4-CPU/4-GiB Daytona sandbox: the app and Postgres 18.6 share a 3-CPU Docker container and a separate 1-CPU driver container reaches it over loopback, without a preview proxy. Before/after variants run in alternating order for three repeats. The reused `bench-1001/driver.ts` records 503s separately: 1,000 prepopulated keys, 20 s per offered rate, a 4,096 in-flight cap, 10 s timeout, and no client retry. Accepted latency starts at scheduled arrival; failures and dropped submissions remain separate. Mac measurements collected under competing workload and a Daytona preview-proxy run are diagnostic only, not evidence for selecting defaults.

Three-repeat medians (ranges are in [BENCHMARKS.md](../../BENCHMARKS.md#admission-control-bounded-overload-494)):

| Offered/s | Before accepted p99 ms | After accepted p99 ms | Refused after |
| --------- | ---------------------- | --------------------- | ------------- |
| 200       | 19.360                 | 10.023                | 0%            |
| 500       | 41.183                 | 12.699                | 0%            |
| 1,000     | 677.110                | 145.958               | 4.075%        |
| 2,000     | 4,495.733              | 178.688               | 57.357%       |
| 4,000     | 4,554.435              | 250.860               | 84.264%       |

All after-variant failures were 503 refusals; no submissions were dropped. Every receipt-count delta matched acknowledged commands across 30 measured case boundaries; refused attempts added no extra receipts. Successful throughput falls at extreme offered load because answering refusals costs CPU. The 64-slot default preserves low-load acceptance and bounds the high-load tail, rather than maximizing saturated throughput.

The conformance cases in `capacity.ts` (Postgres; the mailbox case needs independent connections) and `http.ts`, and the unit cases in `runtime/admission.test.ts`, reject an implementation that runs or receipts a refused command, retries a refusal in place, reports `MailboxFull` for the default bound, leaks a slot on failure or interruption, lets a newcomer overtake a waiter, or authenticates and decodes a served command before refusing it.

## Revisit

Revisit the defaults when per-command CPU falls (#491), when the pools change (#492), and on multi-runner deployments, where a hot actor's owner receives commands admitted by every runner and only the activation bound protects it.
