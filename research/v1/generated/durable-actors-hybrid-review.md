# Durable Actors — Review of the Hybrid Direction (Durable Objects + Effect + Neki)

Date: 2026-09-18. Every external fact below was read today from: PlanetScale Neki docs
(Introducing Neki, Overview, Query planning, Data topology, Reference tables and GSIs,
Neki vs PlanetScale Postgres), Cloudflare docs (Durable Object lifecycle, Pricing, FAQ,
WebSockets, Hyperdrive), effect-ts/effect `main` (`4.0.0-rc.116`,
`packages/effect/src/unstable/cluster/*`), the workerd README, the denoland/celld README,
Supabase's Multigres v0.1 alpha post, and citusdata.com. Estimates are labeled as estimates.

## Verdict

Keep four of the five ideas. Drop one.

| Idea in the brief | Verdict | Reason in one line |
|---|---|---|
| Actor = exclusive mutation authority; database = relational truth | Keep (it is V1 already) | Sound and defensible; not novel, so phrase it precisely |
| Forbid `request()` / blocking `query()` to other actors inside a turn | Keep; make it a hard rule | Removes distributed lock chains; V1 tolerated it, V2 must not |
| Cross-actor sends through a transactional outbox | Keep as implementation, not API | Required on Neki (no atomic cross-shard commit); invisible on one Postgres |
| Neki as horizontally sharded truth | Shape for it now, adopt later | Platform preview since Sep 10 2026, hosted-only, no local; one Postgres *is* one Neki shard |
| Cloudflare Durable Objects as the physical actor host | **Drop** | Breaks the singular-runtime constraint, needs a Bun fleet anyway, slows turns 5–10×, and its uniqueness guarantee does not cover an external database |

Framing check first. The brief credits Durable Objects with three properties Effect Cluster
already gives you and that I verified on `main`: an actor exists without a resident process
(virtual entity), it activates on the first message (the handler-build effect runs once per
spawn under `CurrentActivationScope`), and it is evicted after idle (`EntityReaper`,
`maxIdleTime`, default 1 minute). Timers are `deliver_at` rows in the same database, polled
by the owning runner — one place, where "DO alarm as wake hint + Neki timer" is two. The one
thing DO adds that runners cannot match is hibernating WebSockets at the edge. Take that as
an optional edge adapter (section 2.7), not as the host.

## 1. The constraint decides it: "one runtime, everywhere"

A runtime is four things: where turns run, where jobs/activities/workflows run, where truth
lives, and how tests run. Fill the grid for both candidates.

```diagram
                 Local dev         Self-hosted           Rika Cloud
               ┌─────────────────┬─────────────────────┬──────────────────┐
 DO + Neki     │ turns: workerd  │ turns: ???          │ turns: DO        │
               │ jobs:  Bun      │  workerd has no     │ jobs:  Bun fleet │
               │ truth: Postgres │  multi-node DOs;    │ truth: Neki      │
               │ tests: vitest   │  celld = 3rd runtime│                  │
               │  pool-workers   │ jobs:  Bun          │                  │
               │  + Bun tests    │ truth: Postgres     │                  │
               ├─────────────────┼─────────────────────┼──────────────────┤
 Effect runner │ turns: Bun      │ turns: Bun          │ turns: Bun       │
 + Postgres    │ jobs:  Bun      │ jobs:  Bun          │ jobs:  Bun       │
 (Neki-shaped) │ truth: pglite   │ truth: Postgres     │ truth: Postgres  │
               │ tests: bun test │ same binary         │  → Neki later    │
               │                 │                     │ same binary      │
               └─────────────────┴─────────────────────┴──────────────────┘
```

Row one has three execution runtimes (workerd, DO, Bun) with two of them in every cell.
Row two has one. The rest of this document is the evidence.

## 2. Durable Objects as actor host: six sourced facts

### 2.1 DO uniqueness protects DO storage, not your database

Cloudflare, "Lifecycle of a Durable Object", on shutdown and restart: in-flight requests
"are allowed to finish **if they do not access a Durable Object's storage**. If a request
attempts to access a Durable Object's storage, it will be stopped immediately … to maintain
Durable Objects global uniqueness property."

Your turn writes to Neki, not to DO storage. During a deploy, a runtime update, or a host
move, the old instance may finish its Neki transaction while the new instance has already
begun the next turn:

```diagram
 old DO instance                          new DO instance
 ───────────────                          ───────────────
 BEGIN
 read state (turn = 41)
   ── Cloudflare restarts the object ──►  constructor()
 UPDATE orders ...                        BEGIN
 COMMIT  (turn = 42)                      read state (turn = 41)   ← stale
                                          UPDATE orders ...
                                          COMMIT  (turn = 42)      ← lost update
```

The only defense is the one V1 already has: a fence row (`actors.generation`, `turn`)
checked and bumped inside the same transaction. Once fencing lives in the database, DO's
"single active object" adds nothing for correctness. It adds placement — which Effect
Cluster's shard ownership also gives, with the same lease caveat and the same fence.

### 2.2 A DO cannot hibernate while it holds a database connection

Lifecycle doc: hibernation requires "No active outbound TCP socket (`connect()`)". An
outbound connection "keeps the Durable Object alive for a maximum of 15 minutes" in the
non-hibernateable state, which "continues to incur duration charges". Idle-and-hibernateable
objects hibernate after 10 s; non-hibernateable ones are evicted after 70–140 s.

So the only sane pattern is: open a connection per turn through Hyperdrive, run the
transaction, close it. Hyperdrive makes that tolerable (the pool lives in Cloudflare's
network), but every turn now includes a connect, and any "keep the connection warm for a hot
actor" optimization is billed at 128 MB of wall-clock.

### 2.3 Every SQL statement crosses a provider boundary

```diagram
 Effect runner in AWS (V1)                 DO on Cloudflare (proposal)
 ┌────────┐ ~0.3–1 ms ┌────┐               ┌────┐ ~2–10 ms ┌───────────┐ ~0.3–1 ms ┌──────┐
 │  turn  │──────────►│ PG │               │ DO │─────────►│ Hyperdrive│──────────►│ Neki │
 └────────┘ per stmt  └────┘               └────┘ per stmt └───────────┘           └──────┘
```

A turn is roughly six to eight round trips: `BEGIN` + `SET`, fence `SELECT … FOR UPDATE`,
handler reads, handler writes, receipt/reply `INSERT`, turn `UPDATE`, `COMMIT`. Estimate, not
benchmark: ~3–8 ms per turn colocated versus ~20–80 ms via DO + Hyperdrive with the object
pinned by `locationHint` to the Neki region. That cuts a serialized actor from ~150–300
turns/s to ~12–50, and it discards the point of DO placement (running near the user) because
the data lives in one AWS region regardless. Hyperdrive's query caching is default-on and
must be off for reads inside a turn.

### 2.4 Jobs, activities, and workflows cannot live in a DO, so you run a fleet anyway

DO FAQ: CPU per invocation is 30 s by default, at most 5 minutes via `limits.cpu_ms`; 128 MB
memory; Workers runtime (no native binaries, no shell). Your `Actor.job`, `Actor.activity`,
and `Actor.workflow` cases — render a PDF, drive a browser, shell out, call a model for
minutes, process files — need a Bun or Node fleet. Effect's workflow engine runs on Cluster
entities, i.e. on runners.

So the proposal is not "DO instead of runners". It is "DO **and** runners": two execution
substrates, two test harnesses, two deploy pipelines, two failure models, for one actor.

### 2.5 Effect Cluster has zero DO support and `Sharding` is not splittable

Verified on `main` (`4.0.0-rc.116`, cluster still under `unstable/`): no `Durable`,
`cloudflare`, or `workerd` reference anywhere in `packages/`. `Sharding` owns hash-ring
assignment, lock acquisition (`RunnerStorage.acquire/refresh`), entity managers, the reaper,
and message polling in one service; `getShardId` is a member of that service, so replacing
routing means reimplementing the layer. Hosting entities in DOs means writing a new
`Runners` transport, a new `RunnerStorage`, a new `MessageStorage.Encoded` driver, a DO-side
turn loop, and a wake protocol (sender poke plus a recovery scanner, because a DO alarm
cannot wake an object for a message it never saw) — then keeping all of it in lockstep with
the Bun-side runtime that runs jobs. The brief's §26 already says a tiny `RunnerStorage`
adapter is the wrong level. Agreed; the right level is "don't".

### 2.6 Self-hosting

`workerd` self-hosts Workers but has no multi-machine coordination for DO uniqueness. The
only project offering "self-hosted, distributed Durable Objects" is Deno's `celld`
(Apache-2.0, bucket-lease ownership, pre-1.0 — its README documents upgrades from v0.4.1).
It is a third implementation with its own guarantees document. "Same runtime locally,
self-hosted, and in the cloud" cannot stand on Cloudflare in prod, celld self-hosted, and
workerd locally.

### 2.7 What DO is genuinely better at, and how to take it without hosting actors there

Hibernating WebSockets: clients "remain connected to the Cloudflare network" while the
object is out of memory and no duration is billed (Pricing example 4: 100 objects × 100
sockets ≈ $20/month). A Bun fleet holding a million idle sockets pays memory and needs
sticky routing.

```diagram
  browsers ──WS──► Cloudflare Worker/DO "realtime gateway"
                          │  subscribes to ActorRef.events / .live
                          │  over one server-to-server stream
                          ▼
                    Effect runner (owner of Document/spec)
                          │  turn: Apply → commit
                          ▼
                     Postgres / Neki
```

No actor turn runs on Cloudflare. A self-hosting customer runs the gateway as a Bun process
with ordinary WebSockets; actor code is identical. It is the same optional-edge role as the
CDN/ETag read path in `durable-actors-scenarios.md` §2.

## 3. Neki: the right shape, adopted at the wrong time — and what it changes in your claims

### 3.1 Facts from the PlanetScale docs

- Status: "Neki is now available in platform preview" (blog, Sep 10 2026). Docs: "Beta
  Features … not covered by any service level agreement."
- "You do not have to shard to use Neki. A new database starts as an unsharded cluster."
- Transactions: "Cross-shard work does not share a snapshot or atomic commit; single-shard
  work does." "Distributed and atomic cross-shard transactions are not yet supported."
  Guard: `SET __neki.tx_mode = 'single'` makes Neki reject a transaction that expands to a
  second shard.
- Reads: "An ordinary multi-shard read does not establish one shared Postgres snapshot."
  Guard: `SET __neki.fanout = 'single' | 'multi' | 'scatter'`.
- Shard indexes: `xxhash` (XXH3-64), `modulo` (integer key into N buckets), `range`; the
  key may be a deterministic expression over columns. Tables colocate by binding to the same
  shard group and index. Key ranges map to shard UIDs in a JSON data topology.
- Sequences resolve to a single-shard group with router-side batch reservation, so
  `SERIAL`/identity columns in sharded tables become a cross-shard hop.
- Reference tables: writes fan out and "commit independently". GSIs: lookup rows are written
  "in the same request" but as separate per-shard transactions; `UPDATE`/`DELETE` routed
  through a GSI are rejected.
- Cross-shard joins and aggregates: the router can "complete joins that cannot run on one
  shard", executed as `Route [Scatter]`.
- Hosted on PlanetScale only. No local binary. Dev/CI branches are hosted.

GA timing does not change any of this. GA will not make Neki self-hostable or local, and
the docs say atomic cross-shard transactions are "not yet supported", so design for their
absence.

### 3.2 The homepage claim needs one honest edit

"SQL can see across boundaries. Commands preserve the boundaries." On one Postgres a
cross-actor query is one snapshot — true in the strongest sense. On Neki a scatter query
sees each shard at a different instant. Write:

> Reads are transactionally consistent within a shard and eventually consistent across
> shards; writes are serialized per actor everywhere.

Your seven examples tolerate that (dunning, admin repair, backfills, campaign roll-ups).
Anything that needs a global snapshot — a financial close across actors — needs an explicit
mechanism such as per-shard `turn` watermarks, and the docs should say so rather than let a
reader assume single-node Postgres semantics.

### 3.3 Cross-shard sends become an outbox; the API stays identical

On one Postgres, V1 inserts the outgoing message into `cluster_messages` inside the turn
transaction, so intent and state commit together. On Neki the target's mailbox rows live on
the target's shard and there is no atomic cross-shard commit.

```diagram
 V1 (one Postgres)                      Neki (target on another shard)
 ┌────────────────────────────┐         ┌────────────────────────────┐
 │ BEGIN                      │         │ BEGIN  (tx_mode = single)  │
 │  UPDATE orders             │         │  UPDATE orders             │
 │  INSERT cluster_messages   │         │  INSERT actor_outbox       │ ← same shard
 │    (target's mailbox)      │         │ COMMIT                     │
 │ COMMIT                     │         └─────────────┬──────────────┘
 └────────────────────────────┘                       │ relay per source shard:
                                                      │ ordered, at-least-once
                                                      ▼
                                        ┌────────────────────────────┐
                                        │ INSERT cluster_messages    │ ← target shard
                                        │   ON CONFLICT (message_id) │
                                        │   DO NOTHING               │
                                        │ UPDATE actor_outbox        │ ← source shard,
                                        │   SET relayed_at = now()   │   separate txn
                                        └────────────────────────────┘
```

Effect's `MessageStorage.saveRequest` already reports `Duplicate` for a repeated
`message_id`, so the target dedupes. `ctx.send(...)` and `ref.send(...)` do not change;
only the store does. Same-shard sends may still go direct.

### 3.4 Effect Cluster's stock SQL storage is not shard-shaped; you will write a driver

From `SqlMessageStorage.ts` and `SqlRunnerStorage.ts` on `main`:

- `cluster_messages` has `PRIMARY KEY (id)` and `UNIQUE (message_id)`; neither includes a
  shard column, so Neki cannot enforce them per shard as written.
- `rowid BIGSERIAL` is a sequence: single-shard reservation traffic on every insert.
- `cluster_replies` has no shard column; the client's `repliesFor(request_ids)` poll becomes
  a scatter across every shard.
- `SqlRunnerStorage` takes `pg_try_advisory_lock` on a reserved connection (a single-server
  assumption); `shardLockDisableAdvisory` switches to a `cluster_locks` table.

All of it is pluggable (`MessageStorage.Encoded` via `makeEncoded`, `RunnerStorage.Encoded`),
so this is a driver, not a fork. The alignment that keeps a runner single-shard uses only
public surfaces on both sides:

```diagram
 entity id ─► xxhash(id) % K = db_shard (int)            K = Neki bucket count
           ─► ClusterSchema.ShardGroup(id) = "g" + db_shard
           ─► Effect shard = (group, hashString(id) % shardsPerGroup)

 every row — actor tables, messages, replies, outbox, timers —
   carries db_shard INT
   Neki shard index: { "type": "modulo", "columns": ["db_shard"], "modulus": K }

 runner assigned shard groups {"g7", "g8"}
   ⇒ polls WHERE db_shard IN (7, 8)  ⇒  Route [IN], one or two shards

 cluster_runners / cluster_locks  ⇒  authoritative (unsharded) group
```

`ClusterSchema.ShardGroup` is a public annotation `(entityId) => string`;
`assignedShardGroups` is public `ShardingConfig`; `modulo` is a documented shard-index type.
Feasible — and a few thousand lines including tests — so do it when one Postgres primary is
actually the bottleneck, not before.

### 3.5 Local testability under Neki rules

There is no local Neki, so local and self-hosted truth is Postgres (pglite in tests). Three
layers keep the discipline honest without Neki in the loop:

1. By construction. Everything the framework generates — `db.one/insert/update`, events,
   receipts, timers, outbox — includes the actor key, so it is single-shard. Raw `sql` inside
   a turn is where violations live. Rule: raw SQL inside a turn may read anything and may
   write only rows carrying `ctx.id`. In dev and test the `Database` wrapper rejects an
   `INSERT`/`UPDATE`/`DELETE` inside a turn whose predicate lacks the actor key (a small,
   dev-only SQL parse).
2. In CI. Run the integration suite nightly against a PlanetScale Neki branch with the store
   adapter setting `__neki.tx_mode = 'single'` and `__neki.fanout = 'multi'`, so Neki itself
   rejects violations.
3. If self-hosted sharding ever becomes a requirement: Citus (open source, single-node
   Docker, `create_distributed_table(..., colocate_with)`, reference tables, 2PC across
   shards) runs the same discipline locally. Multigres v0.1 alpha (Jun 2026) is single-shard
   only for now.

### 3.6 Decision: build Neki-shaped, run on one Postgres

The irreversible part is the data model. Fix it now.

```ts
const orders = Database.table("orders", {
  // Leading actor key. This is the future shard key: required, immutable.
  actorId: Actor.Key,
  status: Schema.Literals(["draft", "placed", "paid", "cancelled"]),
  totalCents: Schema.Int,
}).pipe(Database.primaryKey("actorId"))

const orderItems = Database.table("order_items", {
  actorId: Actor.Key,           // owner actor leads the PK
  itemId: Schema.String,
  sku: Schema.String,
  quantity: Schema.Int,
}).pipe(Database.primaryKey("actorId", "itemId"))
```

Rules the framework enforces from day one — each is a Neki requirement and a sound idea on
plain Postgres:

- Every actor-owned table's primary key and unique constraints lead with the actor key.
- No database-enforced foreign keys between different actors' rows. `invoices.customer_id`
  is a plain column; the join still works.
- No `SERIAL`/identity columns in actor tables; ids come from `ctx.ids.next` (snowflake).
- A turn writes only rows carrying its own actor key, plus its own receipt and outbox rows.
- Cross-actor writes exist only as messages.

The store layer hides the rest:

```ts
// local, self-hosted, and early cloud
Runner.layer({ store: ActorStore.postgres({ url }) })

// later, same application code
Runner.layer({ store: ActorStore.neki({ url, buckets: 256 }) })
// per turn: SET __neki.tx_mode = 'single'; outbox relay; db_shard-aligned MessageStorage
```

Rika Cloud can run on Neki *unsharded* when it is GA (online DDL, pooling, failover) and
shard later; the framework itself only ever assumes Postgres semantics plus this discipline.

## 4. The one runtime, drawn once

```diagram
┌──────────────────────────────────────────────────────────────────┐
│  Bun process = Effect Cluster runner   (same binary everywhere)  │
│                                                                  │
│  roles (config): actors | activities | jobs | workflows | crons  │
│                                                                  │
│  Runner.dev   = all roles, one process, pglite / SQLite          │
│  self-hosted  = N processes, Postgres                            │
│  Rika Cloud   = N processes per cell, Postgres → Neki            │
└────────────────┬─────────────────────────────────────────────────┘
                 │ SQL: single-shard per turn (tx_mode = single on Neki)
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  Truth: Postgres (one shard)  ── later ──►  Neki (K shards)       │
│  actor rows · fence · events · mailbox · replies · timers ·       │
│  outbox · workflow journal · jobs        (all keyed by actor key) │
└──────────────────────────────────────────────────────────────────┘
                 ▲
                 │ optional, never authoritative
┌────────────────┴─────────────────────────────────────────────────┐
│  Edge adapters: CDN / ETag read API · Cloudflare DO WS gateway   │
└──────────────────────────────────────────────────────────────────┘
```

Rules this review adds to the V1 surface:

```ts
// inside a turn
yield* other.send(Confirm.make({ orderId: ctx.id }))   // ok: durable intent
yield* other.request(Reserve.make({ ... }))           // type error: not available in a turn
yield* other.query(Get.make())                         // type error: read SQL, or run a saga

const sql = yield* SqlClient.SqlClient
yield* sql`SELECT ... FROM invoices WHERE customer_id = ${ctx.id}`  // ok: read anything
yield* sql`UPDATE invoices SET status = 'void'`                     // dev/test: rejected,
                                                                    // no actor-key predicate
```

The type error is cheap to build: inside a turn `ctx.actors.get(...)` returns a send-only
ref, and the global `Actors` service is not provided in handler context.

## 5. How your seven examples fare

| # | Example | One Postgres (V1) | Neki | DO + Neki |
|---|---|---|---|---|
| 1 | SQL discover → `send` to 128 customers | One snapshot; sends commit in the turn | Scatter read, per-shard snapshots; sends via outbox | Same as Neki, plus one RPC poke per DO |
| 2 | One txn: state + ledger + event + intent + job + timer | Exactly this | Same, provided the ledger row carries the order's key; intent → outbox | Turn ~5–10× slower; fencing still required |
| 3 | Unanticipated admin join | One snapshot | Works as `Route [Scatter]`, per-shard snapshots | Same as Neki |
| 4 | Realtime document + relational history | Runner WebSockets, no hibernation | Same | DO WebSockets are the real win → take only the edge gateway |
| 5 | Workflow querying business data | Yes | Yes, scatter reads | Workflows cannot run in a DO → runners anyway |
| 6 | 100M-actor backfill | Cursor on `actor_id` | Cursor on `(db_shard, actor_id)` to stay bounded | Same as Neki, plus 100M DO wakes billed as requests |
| 7 | Sharded fan-in `CampaignStats/{id}/{n}` | Yes | Yes; the `SUM` is a bounded `Route [IN]` if the 256 shards share the campaign prefix in their key | Same as Neki |

Nothing in the list needs Durable Objects. Two of seven change wording under Neki (snapshot
semantics). All seven already appear in `durable-actors-scenarios.md` for V1.

## 6. What the brief gets right, with honest lineage

"Actor boundary = mutation authority ≠ storage boundary" is correct and it is the
differentiator against Rivet and Durable Objects (isolated per-object stores) and against
Restate and Temporal (state in their own logs, not joinable). It is not new: it is the DDD
aggregate (a consistency boundary inside a shared relational database) plus virtual-actor
addressing (Orleans — Bernstein, Bykov et al., 2014) plus the transactional outbox.
Bernstein's actor-oriented-database line ("Indexing in an Actor-Oriented Database", CIDR 2017;
"Actor-Oriented Database Systems", ICDE 2018) studied exactly "actors plus database
features". Say the true sentence: **relational shared truth, one writer per actor, durable
intents committed in the same transaction.** None of the named competitors offer that
combination, and you can defend every word.

Also right: forbidding in-turn `request()`; the outbox for cross-shard sends; no SQS (Effect
owns messaging semantics); Railway for V1 and AWS + Alchemy later, which are orthogonal to
the framework as long as the deployable unit is "N Bun processes + Postgres".

## 7. The drastic-mistake checklist

1. **DO as actor host** — drastic. Two runtimes, slower turns, no correctness gain, not
   self-hostable, and nothing in your examples needs it.
2. **Building on Neki now** — moderate. Preview, no SLA, hosted-only; making it *the* store
   today demotes local and self-hosted. Building Neki-shaped costs nothing.
3. **Not fixing the actor key in every primary key now** — the only irreversible one.
   Changing it later is a full data migration under load.
4. **Claiming global-snapshot SQL** — a credibility risk the day you shard. Fix the sentence
   now.
5. **Dropping Effect's stock cluster tables onto Neki unchanged** — every poll and every
   reply lookup scatters. Plan the driver; do not build it yet.

## Sources

- https://planetscale.com/blog/introducing-neki
- https://planetscale.com/docs/neki
- https://planetscale.com/docs/neki/overview
- https://planetscale.com/docs/neki/coming-from-postgres
- https://planetscale.com/docs/neki/query-planning
- https://planetscale.com/docs/neki/data-topology
- https://planetscale.com/docs/neki/reference-tables-and-gsis
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- https://developers.cloudflare.com/durable-objects/platform/pricing
- https://developers.cloudflare.com/durable-objects/reference/faq
- https://developers.cloudflare.com/durable-objects/best-practices/websockets
- https://developers.cloudflare.com/hyperdrive/
- https://github.com/effect-ts/effect (packages/effect/src/unstable/cluster: Sharding.ts, SqlMessageStorage.ts, SqlRunnerStorage.ts, ShardingConfig.ts, ClusterSchema.ts, internal/entityManager.ts, internal/entityReaper.ts)
- https://github.com/cloudflare/workerd
- https://github.com/denoland/celld
- https://supabase.com/blog/multigres-v0-1-alpha
- https://www.citusdata.com/
