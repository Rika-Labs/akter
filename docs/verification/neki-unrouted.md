# Explicit unrouted Neki verification

**Responsibility:** distinguish local runtime evidence from Neki provider evidence for [ADR 0110](../decisions/0110-explicit-unrouted-neki.md).

**Authority:** evidence. **Owner role:** runtime and platform verification. **Change policy:** new guarantees require independently checked boundary evidence.

## Real PostgreSQL boundary

`packages/akter/src/runtime/database/neki/access.test.ts` creates a disposable database and a non-superuser runtime role. Real topology functions exist, schema USAGE is granted, and EXECUTE is revoked from PUBLIC. Every runtime pool uses that role, not a mocked SQL client. Local propagation functions count barriers and reject a barrier inside a writing transaction; they do not establish provider propagation behavior.

The plausible wrong implementations these tests must reject are:

- **Default denial, independently for topology and revision:** silently replacing a denied directory with a static map, wrapping the denial in a defect, or checking only the document privilege. Tests require `NekiTopologyAccessDenied` with no defect and no actor schema created.
- **Explicit unrouted boot and turns:** skipping only directory construction but calling topology from migration `routedTables`; disabling Neki semantics along with routing; answering commands without committed state and receipts; or committing the state write of a refused turn. The test builds `Actors.layer`, migrates, runs `+13`, a refused write of `-900`, and `-4`, checks committed state `9` and three receipts, checks one untargeted range and absent directory/turn groups, and reads both `single` settings inside actual turns. Propagation barriers must run outside writing transactions.
- **Explicit-mode replica rejection:** treating the object option as false and enabling PostgreSQL replica/commit-version semantics.
- **Readable default directory:** skipping topology for every Neki database, or never refreshing its revision. With real EXECUTE grants the default mode must read revision `7`, then refresh to an independently changed `19`.

The file is in the Postgres integration project. Existing session, topology, schema, migration and routed-session suites remain evidence for unchanged safeguards and live-topology behavior. Run with `TEST_DATABASE_URL` pointing at a disposable-capable real PostgreSQL server:

```sh
bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/runtime/database/neki/access.test.ts
```

## Preview Neki cell: 2026-10-07

Two disposable customer databases and roles were created through the hosted provisioner on a preview Neki cell, using only a preview credential. The customer's catalog checks returned schema USAGE `true`, topology EXECUTE `false`, revision EXECUTE `false`. The initial document call failed `42501`, `permission denied for function get_data_topology`.

The cell owner and preview admin each attempted schema USAGE and both functions' EXECUTE grants. All failed `42501`, `DDL on schema __neki is not allowed through the router`, naming the target. After a successful `wait_for_ddl(ddl_versions())` barrier, customer topology and revision calls still failed `42501`. There is no successful customer document read and no evidence broader metadata access is tenant-filtered.

The admin document contained authoritative and routing-key-indexed actor-data groups on the same shard. Its cluster default was authoritative; its sole database binding was `postgres.public`, also authoritative. Neither disposable database had a binding. The real framework `shardMapOf` returned `[{ first: -128, last: 127 }]` without a shard target. The shard UID and database map show cluster-level admin metadata, not customer visibility.

Both databases and logins were dropped through the provisioner. Fresh `pg_database` and `pg_roles` queries returned no matching objects. Production was untouched. The original hosted failure was confirmed in preview runner logs: `permission denied for function get_data_topology`.

The sanitized execution log was retained privately, not a committed fixture. This probe proves grant refusal and unrouted map selection, not a fixed hosted deployment reaching live. That deployment remains pending the framework change. [ADR 0093](../decisions/0093-neki-routing-topology.md) and [ADR 0094](../decisions/0094-neki-shard-targeted-sessions.md) contain earlier provider-specific routed-statement refusals; they are not a universal routing-mistake detection proof.
