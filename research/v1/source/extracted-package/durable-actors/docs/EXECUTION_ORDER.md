# Execution order: use the research before implementing

Status: execution plan, not an implemented runtime. Agents remain out of scope until the actor contract is proven.

## 1. Establish the development baseline

Read `../START_HERE.md`, `../DECISIONS_SUMMARY.md`, `../VALIDATION.md`, `MONOREPO.md`, and `BUN_NODE_COMPATIBILITY.md`.
Resolve every blocked dependency/toolchain check before starting domain code. A version recorded from source is not proof that its npm tarball is accessible or that the entire dependency graph is compatible.

Install with the pinned Bun version. Generate and commit a real lockfile if the supplied validation could not resolve one. Re-run the same frozen install in CI. Keep TypeScript, Effect tsgo, Oxlint and its native companion coupled. Run the deliberate diagnostic sentinel: a known floating Effect must fail with the intended rule. A green process with no diagnostics is not evidence the plugin ran.

## 2. Prove the storage boundary

Before polishing `Actor.make`, create a small experimental test against the exact Turso/libSQL endpoint and both supported JavaScript runtimes. Test transactions, rollback, triggers, JSON codecs, schema changes, connection loss, and writer takeover. This experiment is future work, not included implementation.

The first acceptance test is a receipt-protected counter mutation with a forced process termination after its actor-local commit and before the Postgres response record. Re-delivery must return the committed reply and must not apply the mutation twice.

A separate stale-owner test must attempt writes after a higher actor-database fence has committed. It must reject them. Checking a Postgres lease once before a remote SQLite write is not an adequate test or design.

## 3. Prove discovery, not just delivery

An outbox that nobody knows to poll is not durable progress. Record which actor databases require recovery before relying on their pending rows. Kill the runner between its local commit and its wake-up notification. Demonstrate that a new runner discovers and dispatches the work without scanning the full database fleet.

Do the same for delayed messages and workflow submission. Every boundary needs a stable operation identifier and retention rules. No in-memory fiber or live subscription substitutes for this discovery mechanism.

## 4. Lock the public contract

Use `API_DESIGN.md` and `specs/actor-api.ts.txt` as design proposals. Compile representative programs and negative type tests. Keep the descriptor separate from its implementation Layer. Use Effect RPC schemas rather than inventing a second RPC type hierarchy unless there is a demonstrated semantic gap.

Avoid shipping a full ORM to support `Database.projected()`. The first supported projection registration can identify a real SQL table, primary key, codecs and source revision. A declarative table facade is a separate surface with separate migration and validation responsibilities.

## 5. Ship one vertical slice

One entity type, one actor-private database, two mutating commands, one authoritative query, durable acceptance, one delayed command, one replayable event stream. Run it through HTTP and CLI on two runners. Exercise duplicate delivery, a rolling restart, and database failure.

Only then add the narrowly defined one-source projection into a customer-owned Postgres database. Bootstrap and incremental apply must share a documented consistency boundary. Test delete, actor reincarnation, stale update, source key move and a projection-version rebuild.

## 6. Pilot managed hosting

Host only trusted pilot applications in isolated deployments. Measure active runner overhead, database creation rate, written rows per useful command, journal/outbox retention, cross-provider traffic and support time. Apply these measured values to `models/unit-economics.json`.

Do not sell public multi-tenant code execution before implementing isolation and resource quotas. Do not state a margin or actor-count SLA from the illustrative model. Commercial provider permission to provision/resell database fleets is a launch prerequisite.

## Stop conditions

- Ownership cannot be fenced at the actor database: stop the clustered production rollout.
- The chosen database engine lacks required transactional change capture: revise the backend or constrain the feature.
- Recovery requires scanning millions of idle databases: redesign recovery discovery.
- The toolchain cannot demonstrate rules are enforced: fix the toolchain, do not silently disable the rules.
- The pilot has negative contribution margin under its real write amplification: change packaging or price before expansion.
