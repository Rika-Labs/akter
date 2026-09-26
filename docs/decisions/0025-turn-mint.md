# ADR 0025: `turn.mint` — deterministic child actors minted in a turn

**Status:** proposed (2026-09-26)

## Context

A minted actor has no `key`; the framework issues its id. Today the only way to mint is `X.create()`, which returns a UUIDv7 handle outside a turn ([ADR 0010](0010-one-way-effect-native-api.md), [ADR 0013](0013-m0-reconciliation.md), [contract 01](../contracts/01-actor-authority.md), the glossary's "Minted actor", and the [server API](../api/01-server-api.md)). No row is written until the actor's first turn.

Many applications need a parent actor to create a child actor as part of its own turn:

- an order creates one shipment per package;
- a chat room creates one thread per reply thread (the M2 exit example);
- a workflow run creates one import job per uploaded file;
- a workspace creates its default project.

These cannot use `X.create()`. Request/reply handles are forbidden inside a turn ([contract 01](../contracts/01-actor-authority.md)). Minting outside the turn and passing the id in splits one business decision across two transactions: the parent can commit without a child, and a retried client can create two. A random id minted inside the turn has the same problem, because a retried or replayed turn gets a different id.

Minting must keep receipts' rules. [Contract 04](../contracts/04-receipts.md) says the client mints the command id and `turn()` must not; an actor id minted by a turn is a different thing and must not be confused with a command id.

## Decision

### 1. `turn.mint(Child)`

`turn.mint(Child)` is an `X.Turn` capability, like `perform` and `emit`. It returns the child's id as a string.

```ts
Split: Effect.fn(function* ({ packages }) {
  const turn = yield* Order.Turn
  const ids = []
  for (const pkg of packages) {
    const id = yield* turn.mint(Shipment)
    yield* (yield* Shipment.intents(id)).Open({ order: turn.id, pkg })
    ids.push(id)
  }
  return ids
}),
```

- `Child` must be a minted actor (no `key`) that declares `policy.createdBy`. For any other actor, `turn.mint(Child)` is a type error, and `Actor.make` checks it again at runtime.
- `turn.mint` exists only on `X.Turn`. `X.Turn` is available only inside command handlers, so calling it outside a turn fails to compile. A `mint` captured and run after its turn dies with `Mint capability escaped its turn`, using the same staging check as `perform` and intents.
- `turn.mint` writes no row and runs no SQL. It is a pure function of the turn's identity and a counter.

### 2. Identity derivation

The id is a UUID version 8 built from SHA-256:

```text
fields  = [ "durable-actors/mint/v1", tenant, parentType, parentId, commandId, ordinal, childType ]
encoded = concat(for f in fields: u32be(byteLength(utf8(f))) ++ utf8(f))
digest  = SHA-256(encoded)
bytes   = digest[0..16]
bytes[6] = (bytes[6] & 0x0f) | 0x80   // version 8
bytes[8] = (bytes[8] & 0x3f) | 0x80   // RFC 9562 variant
id      = lowercase hyphenated hex of bytes
```

- `tenant` is the turn's tenant. `parentType` is the parent's actor name. `parentId` is the parent's id, or the empty string for a singleton.
- `commandId` is the command id of the command whose handler is running, exactly as stored in its receipt. For a command delivered from an intent, that is the intent-derived command id.
- `ordinal` is the decimal index of this `turn.mint` call among all `turn.mint` calls in this command's handler, starting at `0`. It counts across child types.
- `childType` is the child's actor name.
- The length prefix makes the encoding unambiguous: no two field lists encode to the same bytes. The leading domain string versions the scheme, so a later scheme cannot collide with it.

Consequences of this derivation:

- A rerun of the same command at the same parent returns the same ids, provided the handler calls `turn.mint` in the same order.
- The same command id at two parents, in two tenants, or for two child types gives different ids.
- Two mints in one handler differ by ordinal.
- In a turn batch ([ADR 0005](0005-turn-latency-batching-and-regional-placement.md)), each command keeps its own command id and ordinal counter, so batching does not change any id.
- Ids from `turn.mint` (version 8) and `X.create()` (version 7) never collide in practice. Both are plain strings to the rest of the framework.

UUIDv5 was rejected because it uses SHA-1 and a namespace UUID; version 8 is the RFC 9562 form for a custom hash, and SHA-256 is available through Web Crypto on every supported runtime.

### 3. Exactly-once creation

The child exists only when a creating intent from the same turn is delivered to it.

- At commit, every minted id must be the target of at least one staged intent to `Child`'s `createdBy` command. Otherwise the turn dies with `Minted actor <Child>/<id> has no creating intent` and rolls back. Minting an id only to return it is not allowed; `X.create()` still serves that case.
- The creating intent is an ordinary intent ([contract 05](../contracts/05-messaging.md)). It is written to `actor_outbox` in the parent's commit, delivered after commit, and deduplicated by the child's receipt.
- If the turn rolls back (declared failure, defect, timeout, lost generation, crash before `COMMIT`), no outbox row exists and no child is ever created (invariant M1). A rerun mints the same ids and stages the intents again.
- If the commit's outcome is unknown and it did commit, the retried command replays the parent's receipt, returning the same ids without rerunning the handler. If it did not commit, the rerun mints the same ids. Either way one child exists per id.
- Once committed, the intent has no retry limit, so the child is eventually created unless its creating turn fails. A creating turn that fails keeps its error receipt and the child stays uncreated, as today ([contract 02](../contracts/02-command-turns.md)).

Exactly-once creation rests on receipts and the same-transaction outbox, not on the hash. Determinism adds two things: a rerun after a crash before commit returns the same ids, which matters to clients reading ids from logs or partial output; and a batched or replayed turn is testable without mocking randomness.

### 4. Only the parent can create the child

The creating intent's caller is `System({ source: "actor", ref: parent, onBehalfOf, mint: { commandId, ordinal } })`.

- `ref` is the parent. `onBehalfOf` is the parent's caller principal, as for every intent. `mint` is new and optional.
- For a child minted by `turn.mint`, the `createdBy` check accepts the creating command only when the caller is a System caller with `mint` set and `derive(tenant, ref.actor, ref.id, mint.commandId, mint.ordinal, Child) = child id`. The child needs no stored parent pointer: it recomputes its own id from the caller.
- Only the framework constructs System callers (that is what makes `internal` commands internal), so a client that learns the id (for example from the parent's output) cannot create the child ahead of the intent. Its `createdBy` command fails `Unauthorized` without a receipt. Any other command on the uncreated child fails `NotCreated`, as today.
- `X.create()` children keep today's check: any authorized caller of the `createdBy` command may create them.

### 5. Storage and migration

No migration. `turn.mint` writes nothing; the creating intent uses the existing `actor_outbox` row, whose caller column already stores the encoded caller, and the `created` marker from `0002_creation` records creation. The optional `mint` field is added to the `System` caller schema; callers without it decode as before.

### 6. What does not change

- `X.create()` keeps minting UUIDv7 outside turns.
- `turn()` still never mints a command id. The creating intent's command id is derived from its intent id, like every intent.
- Workflow bodies ([ADR 0022](0022-workflow-engine-storage-and-version-markers.md)) do not get `mint` in this ADR; a workflow step that needs a child sends a command whose turn mints it.

## Alternatives rejected

- **Random id inside the turn.** A rerun after a crash before commit returns a different id, and nothing links the id to the turn.
- **`X.create()` inside the turn.** Needs a request/reply handle in a turn, which contract 01 forbids, and leaves the child's creation outside the parent's transaction.
- **A `children` table written in the parent's turn.** Adds a migration and an insert per child for something the outbox and receipts already give. It remains an option if Dallen wants to list a parent's children (see open questions).
- **Hash without the parent's identity.** The same client command id sent to two parents would mint the same child.
- **Hash without an ordinal, keyed by a user label.** Moves uniqueness to application code; a label is an optional later extension (open questions).
- **UUIDv5.** SHA-1 and a namespace UUID; version 8 states the custom hash directly.
- **Creating the child synchronously in the parent's transaction.** Breaks per-actor transactions and placement ([ADR 0017](0017-m1-record-corrections.md)); the child may live on another routing key.

## Consequences

- One business decision, "this order has these shipments", commits once.
- A child created by `turn.mint` cannot be created by anyone but its parent's intent.
- Handlers that mint must call `turn.mint` in a deterministic order. A handler that mints in a different order after a crash before commit gets different ids; nothing was committed, so this only changes which ids the client sees.
- Ids are not secret. Access to the child still goes through `authorize`.

## Behaviour changes against existing contracts

| Where                                                                                              | Change                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [contract 01](../contracts/01-actor-authority.md)                                                  | minted ids are UUIDv7 from `X.create()` or UUIDv8 from `turn.mint`; `X.create()` is no longer the only way |
| [contract 04](../contracts/04-receipts.md)                                                         | an actor id minted by `turn.mint` is not a command id; `turn()` still mints no command id                  |
| [contract 05](../contracts/05-messaging.md)                                                        | the creating intent carries `mint` on its System caller                                                    |
| [ADR 0010](0010-one-way-effect-native-api.md), [ADR 0013](0013-m0-reconciliation.md)               | amended here, not edited: `X.create()` is one of two minting paths                                         |
| [server API](../api/01-server-api.md), [context](../api/02-context.md), [glossary](../GLOSSARY.md) | `turn.mint` on `X.Turn`; "Minted actor" covers both paths                                                  |

## Verification required of M2.15

Conformance cases in `conformance/mint.ts`, shared by PGlite and Postgres 18.6. The crash and multi-runner rows also run on real Postgres.

- The same command rerun after a `beforeCommit` crash mints the same ids.
- A commit-unknown outcome replays the receipt with the same ids, and exactly one child is created per id.
- The same command id at two parents, and in two tenants, mints distinct ids.
- Two mints in one turn, and mints for two child types, are distinct.
- A mint inside a turn batch equals the mint of the same command alone.
- A declared failure, defect, or rollback creates no child and leaves no outbox row.
- A minted id without a creating intent kills the turn.
- A client calling the child's `createdBy` command with a known id gets `Unauthorized`; another actor's System intent without a matching `mint` gets `Unauthorized`.
- A captured `mint` dies with `Mint capability escaped its turn`; `turn.mint` outside a turn and on a keyed or singleton actor are type errors (type tests).
- Derivation vectors: fixed inputs produce fixed ids, checked in a unit test and written in the API docs.

## Failure-matrix rows

| Failure                                          | Expected outcome                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Parent crashes before `COMMIT` after minting     | No outbox row, no child; the retried command mints the same ids and creates them once.      |
| Parent commit outcome unknown                    | Retry replays the receipt with the same ids; one child per id.                              |
| Relay crashes after claiming the creating intent | Another runner delivers it after the lease; the child's receipt makes creation happen once. |
| Child's creating turn fails                      | Error receipt kept, child uncreated, redelivery replays the error; parent state unchanged.  |
| Client races the creating intent with the id     | Client gets `Unauthorized`; the intent creates the child.                                   |

## Benchmark plan (`mint`)

Added in M2.15 under `tooling/benchmarks`:

- Environment: Bun 1.4.2, real Postgres 18.6 in Docker on the benchmark host, one runner.
- Workloads: a turn that mints and sends to 0, 1, 10, and 100 children; the same children created with `X.create()` followed by one command each, as a comparison.
- Measures: p50/p95/p99 parent-turn latency, time until every child is created, statements and round trips per parent turn, and derivation cost per id in a micro-benchmark.
- Five repeats after warm-up; report coefficient of variation and rerun if it exceeds 10 %.
- Expected: no statement beyond the intents already staged. The Statements baseline must not change for existing scenarios.

## Open questions for Dallen (proposed defaults)

1. **Require `createdBy` on the child?** Default: yes; without it the parent-only creation check has nothing to guard.
2. **Require a creating intent for every minted id?** Default: yes, the turn dies otherwise.
3. **Optional label, `turn.mint(Child, { label })`, replacing the ordinal?** Default: not now; ordinals are enough and labels can be added under a new domain string.
4. **Record parent–child links (a `children` table or index)?** Default: no; inspection can read the parent's outbox and receipts.
5. **`turn.mint` in workflow bodies?** Default: no; workflows mint through a command turn.
6. **Id version 8 with SHA-256 and the domain string `durable-actors/mint/v1`?** Default: yes.
