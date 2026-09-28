# ADR 0042: Blob entry quota and entry deletion

**Status:** proposed (2026-09-28).

**Responsibility:** bound how much of a shared database one actor's blobs can occupy, and decide how query reads are bounded.

**Authority:** design decision record.

**Owner role:** security/runtime.

**Change policy:** supersede through a new ADR. Blob changes need the security review [contract 10](../contracts/10-security.md) requires.

## Context

The contract-10 review of `actor_blobs` (#61) left two medium findings open in [#78](https://github.com/Rika-Labs/durable-actors/issues/78): nothing limited one actor's blob entry count or total bytes, so one tenant could fill disk in a database other tenants share; and query reads ran on the pool outside a transaction with no `statement_timeout`.

M1.9 (#104) closed part of it. `policy.maxBlobBytes` (default 64 MiB) caps the bytes of one actor's entries inside the `set` and `append` statements, and [ADR 0038](0038-retention-cleanup-and-receipt-horizon.md) bounds every query by its actor type's `commandTimeout`, cancelling the running read on the server. The entry count stayed uncapped.

The byte quota counts only entry bytes. An entry of zero bytes still stores a row whose key carries the entry name (up to 512 UTF-8 bytes) and the ownership columns, once in the heap and once in the primary-key index: roughly 1.5 KiB per entry at the longest name. So an actor can grow without bound through empty entries, and the byte quota never notices. There is also no way to remove an entry: `set(entry, empty)` keeps its row, so a count cap alone would be a permanent ceiling for any actor that names entries after unbounded things, such as the chat example's one attachment per post.

## Decision

- **`policy.maxBlobEntries`**, a positive integer to 2^31 − 1, default 10,000, caps the entries of all of one actor's blobs together. A `set` or `append` that would create an entry past it is a deterministic defect, like the byte quota; the check is part of the same statement, so a refused write changes nothing even if the handler catches the defect. A write to an existing entry never counts against it, so lowering the policy below an actor's current count leaves every entry writable and refuses only new ones. At the default, the longest names cost about 15 MiB of rows and index, below the 64 MiB byte quota.
- **`BlobWrite.delete(entry)`** removes every chunk of the entry in the turn transaction, so it rolls back with a declared failure and `get` then returns none. Deleting a missing entry does nothing. `BlobRead` stays read-only.
- The count is `count(*) FILTER (WHERE chunk = 0)` over the actor's rows, in the aggregate the byte quota already reads, so it adds no statement and no migration. A refused write runs one more read to name the quota it would pass.
- **Query reads keep ADR 0038's bound:** a query past `commandTimeout` fails `Timeout` and its read is cancelled on the server. A per-query `SET LOCAL statement_timeout` would add a transaction and two round trips to every query, and a pool-wide `statement_timeout` would bound migrations and sweeps by one number unrelated to any actor's policy. Query reads stay on the unmultiplexed off-turn pool, where cancellation works; PGlite cannot cancel a running statement, and the query still fails at the deadline.

## Alternatives

- **Charge a per-entry overhead against `maxBlobBytes`.** One quota instead of two, but the charge would be a guess about Postgres row layout, and a byte limit is a poor signal for "too many names".
- **A count cap without deletion.** Smaller, but an actor that reaches the cap could never create another entry.
- **A counter column on `actor_generations`.** Constant-time checks, at the cost of a migration and a second write on every new entry; the byte quota already reads every row of the actor, so the count is free there.

## Consequences

- `examples/chat` and any actor that creates entries per record now meets a default ceiling of 10,000 entries per actor and can delete entries to stay under it.
- Entry listing is still not offered.
- Evidence: `conformance/retention.ts` `refuses a new blob entry past policy.maxBlobEntries and frees one on delete`, and `conformance/blobs.ts` `rolls back every blob write with a declared failure and keeps its receipt`, which now deletes an entry before its declared failure.
