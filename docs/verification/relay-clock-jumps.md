# Relay clock-jump lease preservation

## Scope

This correction concerns `ActorTest.advance`, not a production promise of one live attempt per job id. The [background-work contract](../contracts/08-background-work.md) permits overlapping attempts after lease loss and fences their outcomes. Production claims require `due_at_ms <= now` while locking the outbox row. `extendOutboxLeases` has one caller in production source: the testing harness. No still-valid-lease production takeover was established by this investigation.

The harness promises to extend its runner's running attempts by the jump duration before moving the outbox clock. Main at `ef1f12e16` instead copied the running map when constructing the extension effect, before acquiring the relay pass semaphore. A pass holding that semaphore could register a claim afterward. The missed row's database lease then expired relative to the synthetic clock while its executor remained alive on the ordinary clock.

## Deterministic real-database evidence

`extends a claim registered while a clock jump waits for the relay lock` in `tooling/conformance/src/conformance/relay.ts` rejects this wrong implementation: selecting running attempts before acquiring the relay semaphore, whether at effect construction or before waiting for the permit.

The case uses two real runners against a disposable Postgres database. Runner 0 has the only executor initially. An Effect SQL statement transformer pauses its real job-claim statement under the relay semaphore without replacing the query or its result. Deferred gates hold execution and release the claim. The test registers the second runner's executor and starts the extension immediately, so it contends for the held semaphore before runner 0 registers its attempt. The extension advances runner 1's harness clock by one minute after moving runner 0's leases, allowing runner 1 to scan for a takeover without draining the held attempt on runner 0. No sleeps or forced database responses establish the interleaving.

With the main runtime, the case fails with attempt 1 still alive on runner 0 and attempt 2 completed on runner 1, both carrying the same job id read independently from the staged outbox row. With the under-lock snapshot, only attempt 1 exists, its lease remains more than 30 seconds beyond the advanced clock, and releasing it produces one `Called` receipt, the expected actor state and an empty outbox. Existing lease-loss, stale-settle, retry, delivery and ownership-fencing cases remain unchanged.

Run the regression alone:

```sh
TEST_DATABASE_URL=<isolated-database-url> bun --bun node_modules/vitest/vitest.mjs run \
  --config tooling/conformance/vitest.integration.config.ts --project postgres:relay \
  -t 'extends a claim registered'
```

The relay shard contains the existing delivery, retry and lease-fencing cases. The multi-runner and effect-control shards separately cover ownership fencing, cancellation and capped attempts. This evidence is local real-database conformance, not provider-specific certification. Akter Cloud still consumes the published alpha.5 package, so this correction requires a framework release before that consumer receives it.
