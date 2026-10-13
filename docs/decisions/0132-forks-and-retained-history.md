# ADR 0132: Forks and retained history

Status: partially implemented, 2026-10-12 (rewrite/0.2). E6 operator evidence and remaining limits are in [E6 pages and history](../verification/e6-pages-history.md).

**Responsibility:** decide how long a store keeps history, how an actor is forked from it, who may fork, and what a fork copies.

**Owner role:** runtime and operations.

## Context

D8 ships forks and history in 0.2.0. D15 makes fork a CLI and operator operation, not a client call: a client-callable fork is an authorization and cost hazard because it replays history, and developers do not know shard offsets. The captain's default retention is 7 days on Akter Cloud Free plans and 30 days on paid plans. Pages are content-addressed and shared by hash ([ADR 0127](0127-snapshots-pages-lists-history-gc.md)), so a fork is a new manifest pointing at the same pages.

## Decision

### 1. Retained history

A store keeps its segments and checkpoints for its retention period (default 7 days; Akter Cloud: 7 days Free, 30 days paid; one value per store in 0.2.0). Trim and GC respect it ([ADR 0126](0126-shard-ownership-on-the-bucket-log.md), [ADR 0127](0127-snapshots-pages-lists-history-gc.md)).

### 2. Positions

An actor's **version** is the count of actions applied to it. A fork position is a version (`--at <version>`) or an instant (`--before <time>`, the newest version admitted before it). Internally a version resolves to a qualified history position `(shard, offset, entry index)`; a bare offset is never a position, because one segment holds many entries.

### 3. Forking

`akter fork <Type> <id> (--at <version> | --before <time>) [--to <id>] [--with-work]`, or the equivalent operator call, requires the `fork` capability for the tenant ([ADR 0137](0137-inspection-audited-operations-telemetry.md)).

1. Find the newest checkpoint at or before the position within retention, load the actor's manifest, and replay the actor's entries up to the position.
2. Write a new actor manifest sharing every unchanged page, and append a `Forked { from, at, to, manifest }` entry, plus an `Audit` entry, in the target actor's shard.
3. The fork gets a new id (`--to`, or one derived from the source and the position), in the same tenant and type. Forking across tenants or types is refused.
4. Pending timers and jobs are not copied unless `--with-work` is given; with it, timers are copied and open jobs start again under new ids from their journaled steps.
5. A fork of a fork works the same way; its history starts at its `Forked` entry.

A position older than retention, or a source actor with no history at the position, is refused.

The local operator command also accepts `--offset` together with `--index`, never a bare segment offset, and can target another directory or bucket prefix. Ids use the actor's key codec; `--json-ids` disambiguates JSON ids from literal strings. A cross-store fork copies verified page bytes, refreshing every referenced hash under the target publication barrier before its `Forked` entry is durable. The local command requires the application's separate `authorizeOperator(token)` Effect; application callers do not become operator grants. Nondefault tenants remain refused until the engine has tenant-qualified actor addresses. Whole-shard forks are not specified or implemented by this actor-fork decision.

## Supersedes and amends

No earlier record is superseded; forks and history are new.

- Amends [ADR 0015](0015-durable-agent-runtime-boundary.md) and [ADR 0034](0034-tenant-scoped-content-addressed-blobs.md) only as concept history: their fork and content wording is replaced by this record.

## Alternatives

- **`X.fork(id, { at })` on the client.** Rejected by D15.
- **Shard offsets as positions.** Rejected: ambiguous inside a batch and meaningless to developers.
- **Copy timers and jobs by default.** Rejected: a fork that sends mail or charges cards on creation surprises the operator.
- **A separate history archive.** Rejected: retained segments are the archive.

## Consequences

- Storage cost includes retained segments; Cloud plans price retention.
- Forks are cheap in storage (shared pages) and cost one replay up to the position.
- Erasure of an actor completes only after retention ages out its history ([ADR 0127](0127-snapshots-pages-lists-history-gc.md)).

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E6        | F20 (fork during writes; fork of a fork); F21 (GC racing a checkpoint and a fork); a fork's state equals an independent replay to the same version; `--with-work` copies exactly the pending timers; refusal outside retention and across tenants |

## Revisit when

- Per-type retention or longer retention is requested.
- A client-facing branching feature is proposed (it would need its own authorization and cost model).
