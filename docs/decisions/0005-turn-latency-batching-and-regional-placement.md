# ADR 0005: Turn round trips, turn batches, and regional placement

**Status:** accepted design (2026-09-23); implementation, conformance, and benchmarks remain pending.

**Responsibility:** record the owner's choices for closing the per-write latency, hot-actor, and remote-user gaps against Rivet Actors and Cloudflare Durable Objects.

**Authority:** historical decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when these semantics change.

## Context

A competitive review estimated that a warm in-region write costs roughly the same on Durable Actors, Rivet (FoundationDB tier), and Durable Objects: single-digit milliseconds. Three gaps remained:

- **Round trips.** PlanetScale Postgres acknowledges a commit only after at least one replica in another availability zone stores it ([replica consistency](https://planetscale.com/docs/postgres/scaling/replicas)). Every statement also passes through a Neki router. A turn issued as sequential statements (`BEGIN`, tenant scope, fence, receipt, state read, writes, receipt result, `COMMIT`) pays one network hop per statement.
- **Hot actors.** With one committed transaction per command, one actor's durable throughput is roughly `1 / turn latency`: an estimated 150–400 commands/second. Cloudflare documents a soft limit of 1,000 requests/second per Durable Object; Rivet's `c.state` goes faster by saving on a one-second throttle, accepting loss of unsaved writes on a crash.
- **Distance.** One database per deployment means users on another continent pay 50–150 ms per request. Durable Objects place an object near its first caller; Rivet places actors per region.

These figures are estimates from published benchmarks and vendor documentation, not measurements of this runtime. [Performance](../verification/03-performance.md) defines the benchmarks that must confirm or replace them.

## Decisions

### A turn uses two database round trips

The framework issues each turn's statements in two pipelined round trips, preserving the order in the [command-turn contract](../contracts/02-command-turns.md):

1. **Admission round trip:** `BEGIN`, tenant scope, the generation `FOR UPDATE` fence, and receipt insert-or-resolve for every command in the turn batch.
2. **Commit round trip:** dirty state, staged framework writes, receipt results, and `COMMIT`.

The handler runs between them. Handler-issued `ctx.rows` reads, and writes whose results the handler awaits, add their own round trips; the framework adds none beyond these two. Round trips per turn are a measured benchmark output.

The activation caches decoded state from its wake read. A later turn in the same activation reuses the cached value instead of reading `actor_state` again, because the generation fence proves no other writer committed since. The cache changes only after a successful commit. A declared failure keeps the pre-turn value; a retryable defect or commit-unknown result restarts the activation and discards the cache. The migration chain therefore runs when an activation loads stored state, not on every turn.

### Waiting commands for one actor may share a transaction

When more commands for the same actor are already waiting in its mailbox, the activation may run them as one **turn batch**: consecutive turns, in delivery order, committed in one framework-owned transaction.

- **No added wait.** A command with nothing queued behind it commits immediately. Batching only takes commands that are already waiting.
- **Bounded.** A batch has a maximum command count (initial default 32) and a transaction-duration budget. The count stays below the 64-subtransaction threshold at which PostgreSQL subtransaction caches overflow ([GitLab incident](https://about.gitlab.com/blog/why-we-spent-the-last-month-eliminating-postgresql-subtransactions/)).
- **Per-command semantics hold.** Each command keeps its own receipt, output, and declared-failure outcome. A declared failure discards only that command's staged consequences; later commands in the batch observe state as if it had not run. Implementation may use in-memory staging or one savepoint per command. The backend must prove either one, as the [transaction contract](../contracts/03-transactions.md) already requires for savepoints.
- **Defects isolate.** A deterministic or retryable defect aborts the whole batch. Its commands are redelivered and executed one per transaction until the failing command has been processed, so one bad command cannot repeatedly roll back its neighbors.
- **Replies follow commit.** No command in a batch replies, broadcasts, or releases intents before the shared commit.
- **Serialization unchanged.** At most one turn transaction per actor is in flight, preserving foundation F2's serialized handling. The delivery mechanism (draining a `concurrency: 1` Cluster mailbox, or a framework serializer fed by a higher Cluster concurrency) is an implementation choice gated by conformance.

This amends "every admitted command attempt MUST execute as one framework-owned transaction" to "within one framework-owned transaction". The glossary's **Turn** still means one command's execution.

### Hosted deployments may place tenants in home regions

A hosted deployment may span several regions. Each region has its own Neki database and runner pool. A deployment with one region, and every self-hosted deployment, is unchanged.

- **Tenant home region.** Every tenant has a home region, recorded in a deployment-level tenant directory owned by the control plane. The directory changes rarely and is cached at the edge. A tenant's actors, actor-owned rows, receipts, events, timers, and outbox live in its home region's database. The default home region is the deployment's primary region.
- **Routing.** `apps/edge` routes a request to the tenant's home region. `getOrCreate` stays a single-database operation there; no per-actor cross-region key reservation exists.
- **Cross-region intents.** An intent to an actor in another region uses the same durable outbox and relay path as a cross-shard Neki intent: asynchronous, deduplicated by stable intent id, delivered at least once.
- **Singletons.** Singletons and cluster-wide cron run in the deployment's primary region.
- **Queries.** Transactional and snapshot queries stay within one region. Queries across regions are fleet queries under [ADR 0006](0006-scale-rules-placement-and-query-tiers.md): explicit and eventually consistent.
- **Moving a tenant.** Changing a tenant's home region is an explicit operator operation (drain, copy, cut over), not automatic. Its design, and restore semantics for multi-region deployments, remain pending.

This amends foundation F1 from "one relational database per deployment" to "one relational database per deployment region". A single-region deployment still has exactly one.

## Alternatives

- **One round trip through speculative execution:** run the handler before resolving the receipt, then insert the receipt with the commit. Rejected: a duplicate command would execute its handler, contradicting the receipt contract's rule that replay skips handler execution.
- **Replace the `FOR UPDATE` fence with a compare-and-set on the state row:** not adopted now. It would save one row lock per turn but changes the fence contract; measure the lock's cost first.
- **Artificial commit delay to form larger batches:** rejected as a default; it adds latency to every lone command. PostgreSQL `commit_delay` stays a per-deployment tuning option.
- **Save state on a timer, as Rivet's `c.state` does:** rejected; it acknowledges writes that a crash can lose.
- **Place each actor near its first caller, as Durable Objects do:** rejected for now. It needs a global per-key reservation (Rivet uses cross-datacenter consensus for this) and splits one tenant's relational data across regions.
- **One global primary with regional read replicas:** rejected; writes from remote users still cross an ocean.

## Consequences and evidence

The [command-turn](../contracts/02-command-turns.md), [transaction](../contracts/03-transactions.md), [storage ownership](../contracts/06-storage-ownership.md), [security](../contracts/10-security.md), [dispatch](../architecture/04-dispatch.md), [topology](../architecture/01-topology.md), [storage layout](../architecture/03-storage-layout.md), [deployment](../vision/07-deployment.md), and conformance documents are updated to match.

The tenant directory, edge routing by home region, cross-region relay, and tenant move need designs before multi-region support is claimed. No public API for choosing a tenant's home region is specified here.

Working targets, all unmeasured: in-region warm write p50 of 3–6 ms on Neki; hot-actor throughput of 2,000–10,000 commands/second with turn batches. They are hypotheses for the [benchmarks](../verification/03-performance.md), not product claims.

## Revisit when

- Benchmarks show the admission round trip dominates latency; revisit the fence mechanism.
- Turn batches break an existing receipt, failure, or ordering test.
- A workload needs per-actor regional placement rather than per-tenant; that requires a global key reservation design.
- Neki gains atomic cross-shard or cross-region transactions.
