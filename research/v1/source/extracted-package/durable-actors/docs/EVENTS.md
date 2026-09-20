# Durable events and replay

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

`Events` records things that committed. It is distinct from a raw table-change stream and distinct from ephemeral broadcast. Domain code may append meaningful events such as OrderPlaced. Automatic projections capture row changes without requiring those domain events.

## Atomicity

Append a domain event and local mutation in the same actor DB transaction. Retain an actor incarnation, event sequence, schema ID/version, causation ID and encoded payload. Publish a live notification only after commit. If notification fails, the retained event still exists and reconnect replay repairs the gap.

Do not assume Effect EventLog has the exact required ordering. The inspected implementation runs the registered handler before committing its journal entry and includes replication/reactivity behavior. Integrate only after a transaction spike; a small SQL journal may be the clearer initial implementation.

## Reader contract

Expose an Effect Stream over a journal cursor. The cursor binds actor namespace/incarnation and position, not an unscoped integer the caller can apply to another actor. A reader requests events after a cursor; retention gaps return an explicit reset/snapshot-needed result. Duplicates across reconnect are possible and clients dedupe by ID.

Persist only the required event granularity. Storing every transient token/delta as a fully indexed DB record can make agents uneconomical later. A future agent may batch deltas and retain completed chunks while live delivery remains finer-grained.

## Retention

Separate event retention from command deduplication retention. Deleting history must not accidentally permit an old paid command to execute again. Export/archive and legal deletion policies require explicit indexes of what content was copied into projections or blobs. Erasing a source actor does not automatically erase all external sinks.

## Fan-out

Use live notifications to reduce polling, but retain a correct journal scan path. Process-local PubSub is not cross-runner distribution. Gateways should multiplex one upstream logical subscription to many clients with bounded buffers, heartbeat/reconnect and slow-consumer handling.

## Sources and evidence

- [E06: Effect EventLog](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/eventlog/EventLog.ts) — Typed handler runs before journal entry commits; not interchangeable with a database CDC broker.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
