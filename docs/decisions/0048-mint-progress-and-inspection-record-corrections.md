# ADR 0048: Record corrections for `turn.mint`, executor progress, and inspection views

**Status:** accepted (2026-09-28, Dallen). It amends [ADR 0025](0025-turn-mint.md), [ADR 0030](0030-executor-progress-frames.md), and [ADR 0028](0028-sql-inspection-views.md), which stay unedited apart from a status link to this record.

**Responsibility:** make the accepted text of ADRs 0025, 0028, and 0030 match the shipped code where the two differed at acceptance, and record the one code change made instead.

**Authority:** decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR.

## Context

ADRs 0025, 0028, and 0030 were accepted on 2026-09-28 after most of their code had shipped (M2.15, CR.4, and the executor side of M2.18). The acceptance review ([#141](https://github.com/Rika-Labs/akter/pull/141)) compared each text with the code and listed where they differ. Dallen decided each difference: the code is right and the record changes, except for the final progress frame under the runner-wide cap, where the code changes to match the ADR.

## Decision

### 1. `turn.mint` (amends ADR 0025)

1. **Creation needs the relay and the committed intent row, not only the proof.** ADR 0025 §4 says the child "recomputes its own id from the caller" and needs nothing more. The runtime also requires that:
   - the mint proof arrives only through the relay delivering the parent's outbox row. A System caller carrying `mint` through `Actor.as`, a client, or any other external entry point fails `Unauthorized` (code `access_denied`) before its turn runs;
   - before `created` is set, the child's creating transaction finds that intent's committed row in the parent's outbox, with the same tenant, sender, intent id as the command id, target, command, and payload. The row stays until its delivery commits and retention never prunes it, whereas the parent's receipt can be pruned before a long-delayed intent is due.

   A proof alone is not enough because a correct proof can be computed by anyone who knows the parent, command id, and ordinal; the row shows the parent's turn committed that intent.

2. **A creating intent cannot be keyed.** A creating intent staged with `Intent.key` kills the turn with `Minted actor <type>/<id> has a keyed creating intent` and stages nothing, because a later keyed intent or cancel could replace or remove it before delivery and leave the minted id uncreated.
3. **A delayed creating intent carries `source: "timer"`.** ADR 0025 §4 names `source: "actor"`. A creating intent staged with `Intent.after` or `Intent.at` carries `System({ source: "timer", ref: parent, onBehalfOf, mint })`, like every delayed intent, and the proof check accepts `"actor"` and `"timer"`. Cron, workflow, and effect callers never carry a valid proof.
4. **The runtime check runs at the `turn.mint` call, not in `Actor.make`.** ADR 0025 §1 says `Actor.make` checks the child again at runtime. A parent declares no list of the actors it mints, so its `Actor.make` has nothing to check, and a child's `Actor.make` cannot know it will be minted. `turn.mint(Child)` on a keyed, singleton, or non-`createdBy` actor is a type error; if types are bypassed, the call dies with `turn.mint needs an unkeyed actor that declares policy.createdBy`. A `mints: [Child]` declaration on the parent was rejected as public API churn for no added safety.
5. **`turn.mint` returns the child's branded id**, the same branded string type `X.create()` returns, not a plain `string`.
6. **Every unkeyed actor accepts UUIDv8 ids**, not only those that declare `policy.createdBy`, so a deployment that later removes the policy keeps its minted children reachable. Only unkeyed actors with `policy.createdBy` check the mint proof.

### 2. Executor progress (amends ADR 0030)

1. **Closing an attempt's progress may delay its settle by up to 100 ms.** ADR 0030 §3.3 says the pool sends the pending frame "without waiting for delivery" and that "the settle is not delayed by progress". The pool closes the slot before the settle statement and waits at most 100 ms for the sink to accept the final frame, so that frame leaves before the settle's `ProgressClosed`; after the bound it lets the send finish on its own and settles. `ProgressClosed` likewise waits at most 100 ms for that final frame. A slow or hung sink therefore delays a settle by at most 100 ms and never fails it.
2. **An attempt's last frame is always sent, borrowing against the runner-wide cap.** This is the one code change. The pool used to send the pending frame at close only when a runner token was free and drop it otherwise, contrary to ADR 0030 §3.3 and §4. Now the close sends it at once and takes a token even when the bucket is empty; the bucket goes negative, and later sends wait until it refills. The runner still averages 2,000 messages per second; the burst above it is at most one frame per attempt closing at that moment, which the executor pool's concurrency bounds.
3. **`seq` counts accepted frames, not calls.** ADR 0030 §3's message sketch says `seq` "counts progress calls". It counts the calls whose frame passed the effect-match, encoding, and 4 KiB checks and reached the slot. A frame dropped by those checks leaves no `seq` gap; it is logged with its warning. A gap still marks a frame lost after it was accepted: coalesced in the slot, dropped between pool and owner, or dropped at a holder.

### 3. Inspection views wording (amends ADR 0028)

ADR 0028 §2 lists `scheduled_at_ms` as an example of a column "a later migration adds". `0011_relay` adds it, before `0013_inspection_views`. The rule is unchanged: the views leave `scheduled_at_ms` out, so it is private runtime detail until a view version exposes it, like every base-table column no view selects.

## Consequences

- The accepted records now describe the shipped `turn.mint`, inspection views, and executor progress pool.
- A client that shows progress may receive each attempt's final frame even while the runner is at its message cap; runners briefly exceed the cap by at most one frame per closing attempt.

## Evidence

- `turn.mint`: the cases in [`conformance/mint.ts`](../../tooling/conformance/src/conformance/mint.ts) listed in the conformance ledger: `refuses a minted child's creating command without its parent's mint proof`, `refuses a proven creating call while its parent's turn has not committed`, `rejects a mint capability that escaped its turn, a keyed creating intent, and an actor that cannot be minted`, and `reaches a minted id on an unkeyed actor that no longer declares policy.createdBy`.
- Progress: [`runtime/jobs/progress.test.ts`](../../packages/akter/src/runtime/jobs/progress.test.ts) `caps a runner's progress messages per second across attempts and still sends each last frame` (four closing attempts on an empty two-per-second bucket each send their last frame, and the next send waits out the debt), and `closes a slot and its effect within the bound while a send ignores interruption`.

## Revisit when

- Applications need a list of the actors a parent may mint, for inspection or startup checks.
- M2.18's delivery measurements show the final-frame burst or the 100 ms close bound matter.

## Amendment: child-local creating-intent proof (#485, 2026-10-03)

This replaces the child-transaction outbox lookup in decision §1.1. The parent's committed creating intent remains the authority, but the relay carries its delivery proof to the child instead of having the child read the parent's shard. Parent placement and UUIDv8 derivation are unchanged.

### Decision

The relay's claim returns a committed `actor_outbox` row before delivery. It copies that row's target, caller, intent id (the child's command id), command, and payload into the internal `Request`, and adds `intent: { tenant, actor, id }` from the row's sender columns. It does not derive this sender from the caller's asserted `ref`. The entire request travels through the runtime's trusted runner RPC, so the provenance survives serialization and runner handoff.

External admission rejects `intent` metadata before reading or replaying a receipt, just as it rejects a presented mint proof or subscription envelope. `Actor.as` and the served protocol cannot manufacture an admitted delivery. The child requires the relay provenance, checks that its tenant and sender match the minting System caller's `ref`, and re-derives the child's id from the caller's mint proof. A missing or mismatched provenance or invalid mint proof fails `Unauthorized` without a receipt. The check performs no SQL and reads neither the parent's outbox nor its placement registry.

The sender metadata is not a bearer token or a cryptographic signature. The trusted runtime ingress is the same boundary used for committed intents and subscription deliveries; an attacker with arbitrary access to internal runner RPC or the database is outside this boundary. The authority is the durable row the relay claimed, not an in-memory minted-id registry, lease, or TypeScript brand. Adding a duplicate copy or MAC of the request would not strengthen that existing trusted channel, and would add key distribution or redundant encoding.

The outbox row still survives until the child's outcome commits. A crash before its deletion leads to redelivery and receipt replay, including when the sender and child have different routing keys. A delayed creating intent does not depend on the parent's receipt retention. No schema migration or public API change is needed; old outbox rows acquire provenance when claimed. Runners must be upgraded together: an old relay sends no provenance and a new child refuses it, while an old child still performs the cross-shard read.

### Evidence and limits

`conformance/mint.ts` places the child by actor and its parent by tenant, selects routing keys in opposite halves of the signed 64-bit range, refuses a valid mint proof without relay provenance and forged external provenance, checks mismatched sender fields, commits one child, interrupts before outbox deletion, and verifies both redelivery and replay after the row is deleted leave one receipt and unchanged state. Existing rollback and delayed-creation cases remain required.

`conformance/single-shard.ts` records from the actual relay claim through the child's committed outcome, excluding relay scans and source-side deletion. It requires every keyed statement to carry the child's key, rejects any parameter carrying the parent's key, and refuses outbox or placement-registry reads. `runtime/turn/relay.test.ts` checks the request fields against a real PGlite outbox claim, including a caller without a sender ref.

These checks prove child-local statements and cross-routing-key behavior on PGlite and Postgres. Neki's actual shard map, trusted runner transport, and single-transaction settings remain gated by #66; different keys alone do not prove different physical shards.
