# ADR 0068: Public socket runners and acquired-shard readiness

**Status:** implementation decision (2026-10-03), for #489; amends ADR 0021's process model and ADR 0053's `routing` readiness reason.

**Responsibility:** expose multi-runner construction without internal testing wiring.

**Authority:** design decision record.

**Owner role:** runtime and reliability.

**Change policy:** supersede through a new ADR.

## Decision

`Runner.socket` provides runner wiring to `Actors.layer`. The application supplies Effect platform TCP server and client layers; Akter supplies NDJSON RPC, direct messages, SQL runner storage, generation fencing, and receipt/outbox recovery. The framework stays platform-independent and does not enable Cluster's persisted-message store. The Bun adapter uses OS sockets between separate processes.

Advertisement and binding are separate. Advertise a unique direct private address, never a wildcard or shared ingress. The protocol trusts peers and has no built-in authentication or TLS; isolate the network or supply an authenticated encrypted tunnel. Edge assertions do not secure this listener. Amendment (#541): [ADR 0086](0086-runner-mutual-tls.md) adds `Runner.mtls`, a mutual TLS transport that authenticates peers by deployment; the plaintext platform layers remain for isolated networks only.

Defaults are 256 shards, expiring table locks, 35-second expiration, 10-second lock refresh (capped at a third of expiration), one-second assignment refresh, and 15-second entity termination. Table leases retain the singleton database lease check. Lock expiration is not an availability deadline. All commits retain the generation fence.

Configuration amendment (2026-10-10, #602): `Runner.socket` refuses a termination timeout above `shardLockExpiration - min(shardLockRefreshInterval, shardLockExpiration / 3)`, including when the default timeout becomes unsafe after a shorter expiration is configured. The effective refresh cap matches Cluster's lock refresh cadence; equality remains valid. The synchronous refusal is the public `RunnerConfigurationError`, carrying the configured timeout, expiration and effective refresh in milliseconds, before any layer or listener starts. [API documentation](../api/01-server-api.md) and [boundary evidence](../verification/runner-configuration.md) define the configuration surface; no persisted configuration or ownership protocol changes.

Session advisory multi-runner locks are not exposed. In the pinned Effect SQL runner storage, each shard group's advisory lock ids derive from its ordinal in `availableShardGroups`. Every runner's distinct private holder group occupies ordinal two, so their advisory lock ids collide and a second runner cannot acquire its holder shards. The separate-process advisory readiness drill reproduced this. Table locks use the full shard-group identity and reject that wrong behavior without changing upstream code or inventing another ownership mechanism.

Migration `0029_runner_configuration` stores the first public runner's count and expiration in `actor_deployment`. A conditional update establishes one configuration under concurrent startup. Later mismatches, embedded joins, and PGlite are refused before sharding starts. Initial transition from embedded mode and later layout changes require all old processes to stop. Identities, receipts, and outbox protocols do not change.

The layout compare-and-set is tested concurrently, including on a database no runner has migrated. Simultaneous creation of migration bookkeeping on an empty database exposed a Postgres catalog unique-constraint race in the pinned Migrator's `CREATE TABLE IF NOT EXISTS`, before its migration-table lock. Amendment (#487): [ADR 0070](0070-neki-startup-migrations.md) serializes that creation and Cluster's table creation under startup coordination, so concurrent first boot no longer needs a single-runner bootstrap; `testing/conformance/crash/drills/production.test.ts` starts six public runners together on an empty database.

Readiness derives expected assignments from healthy SQL registrations and the weighted hash ring, then checks local acquired shards in every assigned group, including the private holder group. Incomplete acquisition reports `routing`; other reasons retain their meanings. Readiness neither waits for singleton activation nor establishes commit authority. Internal fault-injecting clusters keep their harness readiness.

Same-code rolling restart starts a replacement, waits for readiness, removes the old process from ingress, drains it, and closes its layer to release shards. Arbitrary mixed-code deployment still needs workflow and payload compatibility; the drill does not certify it.

## Evidence and limits

- `runtime/runner.test.ts` checks defaults, advertisement/binding, invalid configuration, and readiness until actor and holder assignments have been acquired.
- `testing/conformance/crash/drills/production.test.ts` checks incompatible startup and PGlite refusal, then runs three Bun processes on one Postgres with 256 shards and table leases: singleton SIGKILL, survivor background work, pending cron identity, clean drain, replacements, and acknowledged commands against receipts and state. Its cron crash case kills a relay after receiver commit but before tick rewrite and proves one receipt and event after replay.
- `crash/drills/runner.test.ts` uses the public layer for runner and relay SIGKILL under load, tracking individual acknowledgments independently of completed operation pairs.
- `crash/drills/failover.test.ts` uses the same public runner fixture for synchronous primary promotion and commit-unknown receipt resolution. Asynchronous promotion cannot preserve every acknowledged command.

Evidence is Bun, loopback on one host, and real Postgres. It does not certify multi-host networks, mTLS, proxies, Railway, Neki, poolers, or every feature's multi-process behavior. Those cells remain gated. Advisory ownership across primary promotion is outside the lease-mode failover drill.
