# 10 — Ownership transfer

**Status:** accepted product capability; API and protocols below are proposed and unimplemented.

[Specification index](../../README.md) · [Decisions](../../DECISIONS.md) · [Sources](../../SOURCES.md) · [External effects](../09-external-effects/README.md) · [Live SQL](../11-live-sql/README.md)

## Product contract

Transfer changes which actor may mutate a defined aggregate. It is not ordinary SQL reassignment and not necessarily movement of a stable actor identity.

Two distinct operations must remain explicit:

- **Stable actor reparenting:** the same actor changes a domain relationship, such as a board moving between projects within its tenant. Identity and row ownership stay unchanged. Cross-tenant moves or region/routing migration are separate, unresolved capabilities; they are not implied by this example.
- **Row-authority transfer:** selected business rows and related resources move from source actor authority to destination authority. The actor identities remain distinct.

At no point may both source and destination be writable authorities. Reads may be temporarily stale or unavailable, but the protocol must have one durable authority state.

```diagram
requested → prepared → destination-ready → source-released → activated
                │              │                  │             │
                └─ source owns ┴─ source owns     └─ nobody writes
                                                     until destination

Forbidden: source writable ◀──────────────▶ destination writable
```

## Proposed API

All names are reviewable sketches, not compiler-tested claims.

```ts
import { Actor, Context } from "durable-actors"
import { Effect, Schema } from "effect"

const MoveProject = Schema.Struct({
  projectId: Schema.String,
  destinationWorkspaceId: Schema.String,
  expectedVersion: Schema.Int,
})

export const Workspace = Actor.define({
  name: "workspace",
  commands: {
    moveProject: {
      input: MoveProject,
      handler: (request) => Effect.gen(function* () {
        const ctx = yield* Context
        yield* ctx.transfer.request({
          transferId: `project:${request.projectId}:${request.expectedVersion}`,
          destination: { type: "workspace", id: request.destinationWorkspaceId },
          aggregate: { type: "Project", id: request.projectId },
          expectedVersion: request.expectedVersion,
        })
      }),
    },
  },
})
```

`ctx.transfer.request` records intent inside the source command turn with business changes and receipt. The destination inherits the trusted tenant from context; this example cannot request a cross-tenant move. It performs no remote call and grants no destination authority. Completion and status are durable protocol messages.

```ts
const status = yield* client.transfer.status(transferId)
// proposed: Requested | Preparing | Ready | Released | Activated | Failed
```

## What is transferred

A transferable aggregate needs a versioned manifest: root rows, dependent rows, ownership metadata, pending commands, timers, outgoing intents, live-query effects, and blob references. Foreign-key direction, uniqueness constraints, generated IDs, and externally referenced URLs can prevent a generic move.

Blobs require an explicit policy: retain immutable shared object references, server-side copy then verify digest, or move ownership metadata while preserving storage. Related rows may be copied, referenced, or rejected. The protocol must not silently omit attachments, child rows, receipts needed for dedupe, or pending external-effect evidence.

Not every relation follows ownership. Shared catalog rows and audit evidence can remain in place. The manifest and schema version determine the boundary; arbitrary graph traversal is not promised.

## Same-domain coordinator

When both authorities and all transferred rows share one proven transaction domain, a special coordinator may atomically change authority and record both sides' protocol state.

```diagram
┌────────────── one database transaction ──────────────┐
│ lock source + destination + transfer                 │
│ validate manifest/version/auth                       │
│ rewrite authority/routing metadata                   │
│ append release proof + destination activation        │
└────────────────────── COMMIT ────────────────────────┘
```

This is a privileged transfer path, not actor handler SQL. “Same Postgres URL” is insufficient: it must use one pinned transaction identity and compatible locality. Neki single-shard mode only qualifies when planning proves every touched row is on that shard.

## Cross-shard saga

Cross-shard transfer cannot claim atomic visibility. The proposed saga stages an immutable, checksummed copy while source remains authoritative; destination verifies it; source then commits a durable release proof and becomes permanently non-writable for that transfer generation; destination activates from that proof.

```diagram
source owns ──snapshot N──▶ destination staged (not writable)
     │                              │ verify manifest/digest
     ├── changes after N? refresh ──┘
     │
     └── commit RELEASE(generation, digest, destination) ──▶ activate
          source fenced forever for generation               destination owns
```

Release proof includes transfer ID, identities, aggregate/version, manifest digest, source fence generation, destination, and committed release position. It must survive retries, failover, and restore.

If failure occurs **after release**, recovery must roll forward to destination activation. It must never blindly thaw the source, because destination may already have observed or mutated the released aggregate. Reversal after activation is a new transfer, not rollback.

## Visibility and commands during transfer

Before release, source may accept commands only if the copy protocol can detect and refresh changes; alternatively it enters a bounded preparation freeze. After release, source rejects mutation with a non-disclosing moved/unavailable response and routing hint only when authorized.

Queued commands need an explicit policy: drain before snapshot, reject and let callers retry, or forward with stable IDs after activation. They cannot execute independently on both sides.

Shared SQL offers **no global atomic visibility**, especially on Neki. Keep prepared copies in framework-internal staging tables, not live business tables, so public-by-default business SQL does not expose incomplete destination copies. Source/destination live rows and routing metadata can still be observed at different points during activation and cleanup; define transitional visibility explicitly without requiring users to publish separate views. This is not a global snapshot promise.

## Authorization and failure limits

- Authorize source release and destination acceptance independently, binding principal and policy version to the request.
- A tenant move must not let either tenant infer inaccessible actor or row existence.
- Transfer workers use narrow coordinator privileges; ordinary actor SQL cannot mint release proofs or alter owner/fence columns.
- Duplicate protocol messages are normal and deduplicated by transfer ID plus immutable payload hash.
- A changed payload under one transfer ID is a conflict.
- Destination capacity, schema, encryption keys, residency, and blob policy are validated before release.
- Cancellation is safe only before release; afterward status is roll-forward-required.
- Lost notifications are repaired by durable scans.
- Restore must fence transfer epochs and reconcile both domains before enabling either side.
- Cascading SQL updates and raw ownership-column writes are not transfer support.

## Operations

Expose phase age, source and destination generations, manifest version/digest, copied row/blob counts, verification errors, release proof, activation lag, queued command policy, and recovery owner. Alert on transfers stuck before release and more urgently after release.

Administrative repair actions are typed and audited: retry copy, reverify, abort-before-release, and roll-forward-after-release. There is intentionally no “force both writable” action.

## Unresolved specifics

- Which aggregates, related-row shapes, and blob adapters are transferable.
- Stable-actor reparenting effects on shard keys, URLs, ACLs, and command routing.
- Freeze versus change-capture policy and maximum preparation window.
- Same-domain coordinator implementation and lock ordering.
- Cross-shard copy/change source, staging cleanup, and release-proof schema.
- Handling of timers, pending activities, live subscriptions, and long-lived connections.
- Read resolution and retention of old source tombstones/routing hints.
- Schema migration compatibility while a transfer is in flight.

## Falsifiable validation gates

1. Race source and destination commands through every phase; at most one commits as writable authority.
2. Kill coordinators before/after each durable transition; retries converge without dual ownership.
3. In a same-domain test, prove authority, release, and activation commit atomically on one pinned connection.
4. On actual multi-shard Neki, prove the saga never relies on atomic cross-shard commit or snapshot.
5. Fail immediately after durable release; recovery rolls forward and cannot thaw source.
6. Copy an aggregate with child rows, shared rows, blobs, timers, and pending effects; manifest verification catches every omission or mutation.
7. Restore either domain to an earlier backup; epoch fencing prevents two writable generations.
8. Exercise unauthorized source, destination, and observer principals; errors reveal no forbidden existence or routing data.
9. Subscribe through shared SQL during transfer; documented transitional visibility occurs, while staging rows never appear as authoritative.

These gates validate a particular aggregate manifest and topology, not arbitrary ownership-column updates. The general ownership enforcement questions remain in [decisions](../../DECISIONS.md#ownership-errors-versus-implicit-scoping).
