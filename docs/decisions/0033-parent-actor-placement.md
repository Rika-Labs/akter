# ADR 0033: Parent-actor placement

**Status:** accepted (2026-09-28, Dallen, with every recommended default; proposed 2026-09-28). M4.11 builds it in `0022_parent_placement`.

**Responsibility:** decide how an actor type is placed on its parent actor's shard, how a child's address yields its routing key, and what storage and API change for it.

**Authority:** design decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0006](0006-scale-rules-placement-and-query-tiers.md) gives every actor type a placement key: the tenant, the actor, or "a parent actor's identity: child actors share the parent's shard". [ADR 0010](0010-one-way-effect-native-api.md)'s definition table lists "a parent actor definition" as a `placement` value. [ADR 0017](0017-m1-record-corrections.md) accepted only `"tenant" | "actor"` and left parent placement as target API that "needs its own design before it ships". M4.11 builds it ([M4](../milestones/M4.md)).

What the code does:

- `routingKey({ ref, placement })` in `runtime/storage/codec.ts` hashes `[1, "tenant", tenant]` or `[1, "actor", tenant, actorType, id]` with XXH3-64 (`PLACEMENT_ENCODING = 1`). Every framework row (`actor_generations`, `actor_state`, `actor_receipts`, `actor_events`, `actor_outbox`, `actor_blobs`, workflow rows, and connections) and every owned-table row leads its key with that value. `codec.test.ts` pins golden vectors.
- `actor_placements (actor_type, placement, encoding)` records each type's placement, with `CHECK (placement IN ('tenant', 'actor'))` (`0003_routing_state`). A build that changes either value refuses to start (`pglite.test.ts`: `refuses to start an actor type under a different placement than its stored rows`).
- `group` reads are scoped by `routing_key` and `tenant_id` (`runtime/turn/rows.ts`), so a group is exactly the set of actors that share a routing key.
- Routing must be computed from the address alone. A handle, the relay, the served protocol, and Cluster all turn `(tenant, actor type, id)` into a routing key without reading the database; a lookup would add a round trip to every turn and wake ([ADR 0005](0005-turn-latency-batching-and-regional-placement.md)).
- `turn.mint(Child)` ([ADR 0025](0025-turn-mint.md), accepted; implemented) derives a UUIDv8 from the tenant, parent type and id, command id, ordinal, and child type. The id alone doesn't reveal the parent.

The problem parent placement solves: `actor` placement spreads high-cardinality actors across shards, but then a parent and its children land on different shards. Every intent between them is a cross-shard outbox delivery, and no `group` query can read an order together with its shipments in one snapshot. Examples: an order and its shipments, a document and its comment threads, a project and its tasks, a room and its reply threads.

## Decision

### 1. `placement: { parent: P }`

```ts
export const Order = Actor.make("Order", { key: OrderId, placement: "actor", api: { Split } })

export const Shipment = Actor.make("Shipment", {
  placement: { parent: Order }, // rows live on the owning order's shard
  api: { Track },
  internal: { Open },
  policy: { createdBy: "Open" },
})
```

- `placement` accepts `"tenant"`, `"actor"`, or `{ parent: P }`, where `P` is another actor definition. The object form leaves room for later fields, and it reads as what it is.
- `P` must be placed by `"actor"` or by `{ parent }`. A tenant-placed parent is a type error and fails `Actor.make`, because its children would already share the tenant's shard; they should say `"tenant"`.
- Chains are allowed up to four levels below the root (a task in a list in a project in a workspace). A chain resolves to its root, which must be `"actor"` placed.
- Parent placement is placement only. It grants no authority: the parent doesn't need to exist, deleting it doesn't delete children, and authorization is unchanged ([contract 10](../contracts/10-security.md)).

### 2. A child's id carries its parent's id

A child's routing key must come from its address alone, so the parent's id is part of the child's id:

```text
c1.<byte length of the parent id>.<parent id>.<local id>
```

- `c1` versions the form. The length prefix makes the form unambiguous for any parent id, including one that contains `.` or is itself a child id. Example: shipment `pkg-1` of order `o-17` is `c1.4.o-17.pkg-1`. A label of that shipment is `c1.15.c1.4.o-17.pkg-1.label-1`.
- **Named children.** The child's `key` schema validates the local part. `Shipment.idOf(orderId, local)` builds the full id, and `Shipment.get(id)` takes the full id, so there is still one way to get a handle.
- **Minted children.** `turn.mint(Shipment)` in an `Order` turn returns `c1.<len>.<order id>.<uuidv8>`. The UUIDv8 is ADR 0025's unchanged derivation. The child's `createdBy` check also requires the id's parent part to equal the minting caller's ref, then re-derives the UUIDv8 as today. `Shipment.create()` is a type error: a parent-placed minted child can only be minted by its parent.
- **Parsing.** The framework parses the id wherever it computes a routing key. A malformed id, or one whose parent part fails the parent's key schema, is `InvalidInput` before any turn.

### 3. Routing key and storage

- A child's routing key is its root's routing key under encoding 1. No new encoding value is needed.
- `actor_placements` accepts `placement = 'parent'` and gains `parent_type text`, non-null exactly when the placement is `parent`. As today, a build that changes a type's placement, its encoding, or its parent type refuses to start.
- Nothing else in storage changes. Every row still leads with `routing_key`; a family simply shares one, as a tenant's actors do under tenant placement.

### 4. What sharing a shard buys

- **Single-shard intents.** Intents, timers, effect routes, and workflow calls between a parent and its children are same-shard outbox rows ([ADR 0011](0011-direct-commands-outbox-and-performance.md)).
- **Family group reads.** `group` in a parent or child reads the whole family in one snapshot, for example an order's shipments joined to their tracking rows. It never reads beyond the family.
- **Nothing else.** A parent and a child are still separate actors with separate turns, generation fences, and receipts. Placement does not make a transaction span them.

### 5. Limits

- A family is one shard's worth of throughput and storage. A parent with millions of busy children is a hot shard, as a large tenant is under tenant placement. The application chooses its parent accordingly.
- A child cannot change parents. Moving a child means creating a new actor.
- Ids get longer with depth. The four-level limit, and the existing limits on a tenant (128 bytes) and on actor ids, bound them.

## Alternatives rejected

- **A directory from child to parent.** Every turn, wake, and relay delivery would first read it: a round trip, and a shared table on every hot path.
- **A `parent` field on `ActorRef`.** It changes the address type of every handle, envelope, route, receipt, and subscription row for one placement kind. The composite id carries the same information inside the existing `id` (open question 1).
- **Hashing the child id to find the parent.** Hashes don't invert, and a minted UUIDv8 hides its inputs by design.
- **Letting tenant-placed parents have placed children.** It adds nothing tenant placement doesn't already give.
- **`placement: Order` without the object.** It reads as "placed at Order" and leaves no room for options.

## Consequences

- Parent and children stop paying cross-shard delivery on Neki, and families get consistent group reads.
- Children of one parent are visibly related in ids, inspection views, and logs. Ids aren't secret today either (ADR 0025).
- Served routes and route validation must accept child ids, including the minted form.

## Amendments on acceptance

These landed with the acceptance, as labelled targets until the slice builds them.

**Contracts.**

- [06 storage](../contracts/06-storage-ownership.md): replace "Parent-actor placement is target API" with the `{ parent }` rule, the root routing key, the `parent_type` record, and the startup refusal.
- [01 actor authority](../contracts/01-actor-authority.md): a parent-placed child's id is `c1.<len>.<parent>.<local>`; parent placement is not authority.

**Earlier ADRs.** ADR 0017 (parent placement moves from target API to accepted API), ADR 0010's definition table (`{ parent: P }` instead of a bare definition), ADR 0025 (a parent-placed minted child's id wraps the UUIDv8), and ADR 0027 (the minted-actor route segment also accepts the child form).

**API.** [Server API](../api/01-server-api.md): `placement: { parent }`, `X.idOf(parent, local)`, `X.create()` removed for parent-placed minted children, and `turn.mint`'s return form. [Context](../api/02-context.md): `group` covers the family. [Glossary](../GLOSSARY.md): "Placement key" and "Minted actor".

**Architecture.** [Storage layout](../architecture/03-storage-layout.md): parent placement shares the root's routing key.

**Verification.**

- [Conformance](../verification/01-conformance.md): the **Placement and single-shard paths** check gains the parent kind; add the cases below in `conformance/placement.ts`.
- [Support matrix](../operations/support-matrix.md): "`routing_key` placement" covers parent placement on PGlite and Postgres; Neki stays gated until M5.

## Migration

Needs one framework migration: relax `actor_placements`' check to allow `parent` and add `parent_type`. It is `0022_parent_placement`, reserved for M4.11 when this ADR was accepted, after ADR 0032's `0021_payload_versions`.

## Decided questions

Dallen accepted every recommended default on 2026-09-28.

1. **Where the parent lives in the address.** Decided: inside the id, as `c1.<len>.<parent>.<local>`. Rejected alternative: a `parent` field on `ActorRef`, which touches every address type and wire format.
2. **Spelling.** Decided: `placement: { parent: Order }`. Rejected alternative: `placement: Order`, as ADR 0010 sketched.
3. **Tenant-placed parents.** Decided: refused. Rejected alternative: allow them and treat them as tenant placement.
4. **Depth limit.** Decided: four levels below the root. Rejected alternative: unlimited, with only the id length limit.
5. **Migration number.** Decided: reserve the next free number at acceptance. It is `0022_parent_placement`. Rejected alternative: wait for merge time and apply the milestone renumbering rule.

## Evidence required

In `conformance/placement.ts`, on PGlite and Postgres:

- `stores every framework and owned row of a child under its root's routing key`
- `reads a parent and its children in one group snapshot and nothing beyond the family`
- `refuses a build that changes a type's placement, encoding, or parent type`
- `rejects a tenant-placed parent and chains deeper than four levels at Actor.make`
- `mints a parent-placed child as c1 form whose createdBy proof verifies, and refuses X.create()`
- `rejects a malformed child id or a parent part the parent's key refuses as InvalidInput before any turn`
- `delivers intents between a parent and its child as same-shard outbox rows`
- `serves and routes a child id through the HTTP protocol`

In `codec.test.ts`: golden vectors showing a child's routing key equals its root's. On Postgres: `applies the migration to a database that ran the previous one`. M5 adds the Neki `EXPLAIN (NEKI_PLAN)` single-shard check for families.

Benchmark: `placement`, comparing parent-to-child intent latency and a family `group` read under `{ parent }` and under `"actor"`.

## Revisit when

- A workload needs to move children between parents.
- Families grow past one shard's capacity.
- Neki gains cross-shard transactions, which would make co-location a cost choice rather than a correctness one.
