# Durable Actors — Global Distribution Without Durable Objects

Date: 2026-09-18. Sources read today: Cloudflare "Data location" (Durable Objects), PlanetScale
Neki "Overview". RTT figures are typical public numbers, labeled estimates.

## Takeaway: DO was going to distribute compute, not your data — and users feel data distance

In the hybrid, truth lived in Neki. A Neki cluster is regional: routers "spread across three
availability zones", each shard "one Postgres primary and its replicas" in that region. So every
turn, wherever the DO ran, went to one region. The DO's location only decided how far the turn's
six to eight SQL round trips travelled.

```diagram
 Sydney user, DO created near first request (Cloudflare default), Neki in us-east-1

 user ──20 ms──► DO (Sydney) ──200 ms × 7 statements──► Neki (Virginia)     ≈ 1,400 ms / turn

 Same, with locationHint: "enam" on every object

 user ──20 ms──► ──200 ms──► DO (Virginia) ──~3 ms × 7──► Neki (Virginia)  ≈  240 ms / turn
```

The second line is the only workable version, and it is not "global": every object is pinned to
the database's region and the user pays the ocean crossing once per command. Cloudflare also does
not move objects afterwards ("do not currently change locations after they are created"), and a
DO `jurisdiction: "eu"` would not have made the data European — the data was in Neki's region.

What a user feels is the round trip to the actor's *data*. You get that only by placing data in
more than one region and homing each actor to one of them. Cloudflare could not do that for you;
Neki is one region. So the mechanism is the same with or without DO: **cells**.

## The cell model: one runtime, deployed N times, federated by the outbox

A cell is one complete deployment of the runtime you already have: Effect Cluster runners +
Postgres (later Neki). Cells are independent clusters — separate `RunnerStorage`, separate
`MessageStorage`, separate shard assignment. Never stretch one Effect cluster across regions:
lock refreshes, message polling, and every mailbox write would cross the ocean.

```diagram
                       anycast ingress (Cloudflare Worker, or Bun gateway)
                       auth · actor key → cell · WebSocket termination · cache
                 ┌──────────────────┬────────────────────┬───────────────────┐
                 ▼                  ▼                    ▼                   │
        ┌────────────────┐ ┌────────────────┐  ┌────────────────┐            │
        │ cell us-east   │ │ cell eu-central│  │ cell ap-south  │            │
        │ runners (Bun)  │ │ runners (Bun)  │  │ runners (Bun)  │            │
        │ Postgres/Neki  │ │ Postgres/Neki  │  │ Postgres/Neki  │            │
        └───────┬────────┘ └───────┬────────┘  └───────┬────────┘            │
                │   outbox relay   │    outbox relay   │                     │
                └──────────────────┴───────────────────┘                     │
                                                                             │
        control plane (small, replicated, rarely written):                   │
        projects → home cell · cell endpoints · placement rules ─────────────┘
```

Inside a cell, everything in the V1 design holds unchanged: one command = one transaction,
SQL sees the cell's whole relational world in one snapshot, sends to actors in the same cell
commit in the turn. Across cells, a send is an outbox row relayed with at-least-once delivery
and `message_id` dedupe — the identical mechanism the review already requires for cross-shard
sends on Neki. One rule covers both: **a target outside my transaction domain goes through the
outbox.** `ctx.send(...)` does not change.

## Placement: per project by default, per key when you need it

Durable Objects place per object at first use and never move. Cells give you the same choices,
made explicit, plus the one DO could not give (the data actually lives there).

```ts
// A cell is a deployment target, not application code. Same binary everywhere.
Runner.layer({
  cell: "eu-central",
  store: ActorStore.postgres({ url: env.EU_PG }),
})
```

```ts
// Default: an actor lives in its project's home cell.
// Actor keys already carry the project: `${projectId}/${actorType}/${actorId}`.
// project → cell is a control-plane row, cached at the ingress; one tenant's whole
// relational world stays in one database, so cross-actor SQL for that tenant is still one snapshot.
export const Order = Actor.make("Order", {
  protocol: OrderProtocol,
  database: OrderDatabase,
  // placement: Placement.project   ← default
})

// Override: derive the cell from the key. Must be deterministic and stable, because
// like a DO, an actor's home is fixed at creation. Mint ids that encode it.
export const Device = Actor.make("Device", {
  protocol: DeviceProtocol,
  database: DeviceDatabase,
  placement: Placement.byKey(({ id }) => Cell.fromDeviceId(id)), // "ap-…" → "ap-south"
})
```

Data residency is a set of cells, not a flag: an EU project's home cell is `eu-central`, so its
actors, events, mailbox, timers, workflow journal, and blobs are in the EU. That is stronger than
DO's `jurisdiction("eu")` with a US database.

"Nearest on first use" (DO's default) needs a global directory with a consistent create — a
create race between two ingress points must resolve to one winner. That is a later feature:
`Placement.nearestOnCreate` backed by a control-plane `INSERT … ON CONFLICT DO NOTHING RETURNING`.
V1 ships `project` and `byKey`, which need no runtime directory lookup at all.

## Routing: the ingress resolves key → cell, then forwards

The ingress is generated by the framework and holds no business logic. It runs as a Cloudflare
Worker in Rika Cloud (anycast, ~300 PoPs, hibernating WebSockets) or as a Bun process when
self-hosted. Same actor code behind it.

```ts
export default Ingress.make({
  cells: {
    "us-east":    "https://us-east.cells.rika.dev",
    "eu-central": "https://eu-central.cells.rika.dev",
    "ap-south":   "https://ap-south.cells.rika.dev",
  },
  placement: Placement.fromControlPlane(env.CONTROL_PLANE), // project → cell, cached
})
```

A command from Frankfurt to an EU-homed actor: user → nearest PoP (~5–15 ms) → `eu-central`
cell (~10 ms) → turn (~3–8 ms). About 25–35 ms, estimate. Same actor via the hybrid with Neki
in Virginia: ~125–150 ms. Same actor if you only have a US cell: ~110 ms — identical to the
hybrid. The cell is what buys locality; DO never did.

## Reads and realtime: already in the design, now per cell

Reads: the CDN/ETag path from `durable-actors-scenarios.md` §2 serves cached query results at the
edge with `ETag = turn`, revalidating at the home cell. Postgres/Neki replicas can later serve
`query(..., { consistency: "eventual" })` from the cell — not in V1.

Realtime: the edge gateway (DO hibernation in Rika Cloud, plain Bun WebSockets self-hosted)
subscribes to the actor's home cell. Collaborators on three continents all reach the one home;
the hybrid had the same property, since all WebSockets terminated at the one DO.

## Cross-cell messaging is the outbox you already have

```diagram
 Order/o1 (eu-central)                    Inventory/shirt (us-east)
 ┌──────────────────────────┐             ┌──────────────────────────┐
 │ BEGIN                    │             │                          │
 │  UPDATE orders           │             │                          │
 │  INSERT actor_outbox     │ ← same cell │                          │
 │    target: us-east       │             │                          │
 │ COMMIT                   │             │                          │
 └────────────┬─────────────┘             │                          │
              │ relay (per source cell, ordered, at-least-once, ~90 ms)
              ▼                                                      │
                                          │ INSERT cluster_messages  │
                                          │  ON CONFLICT (message_id)│
                                          │  DO NOTHING              │
                                          └──────────────────────────┘
```

Cross-cell `request()` inside a turn is already a type error (review §4), so no turn ever waits
on another region. Sagas cross cells the same way they cross shards.

## What you give up relative to DO — stated honestly

- Granularity: Cloudflare hints cover 11 regions and hundreds of colos; you will run two to five
  cells. Where that matters (per-actor latency for globally spread users), the gap is
  user → nearest cell, typically 10–40 ms more than user → nearest colo for the same continent.
- SQL snapshot scope shrinks from "the whole system" to "one cell". Keep a project inside one cell
  and the promise you actually make — "one tenant's relational world in one database" — survives.
  Cross-tenant, cross-cell analytics is a CDC sink or warehouse, which is analytics, not truth.
- A cell is a larger failure domain than a colo. It is the same failure domain the hybrid had,
  because Neki was one region. Within a cell, Postgres/Neki fails over per shard and runners span
  availability zones.
- Moving an actor between cells is not free. Neither is it on Cloudflare ("dynamic relocation …
  planned for the future"). V1: home fixed at creation. Later: `Actors.rehome(ref, cell)` as a
  workflow — freeze the actor (reject with `Rehoming`), copy its rows by actor key, switch the
  directory, drain its outbox, unfreeze. The actor-key-leads-every-PK rule makes "copy its rows"
  a bounded query.

## What to do in V1

Run one cell. Keep the cell in the routing path anyway: the project → cell table exists with one
row per project, the ingress consults it, `Runner.layer` takes `cell`, and the store already
distinguishes "in my transaction domain" from "outbox". Adding `eu-central` later is a deployment
plus a control-plane row, not a framework change. The two irreversible decisions are the same ones
from the review: the actor key leads every primary key, and it carries the project.
