# E8e: changeable store retention

Date: 2026-10-13. Scope: framework store policy, not Cloud billing or provider certification. Owning decisions: [0127](../decisions/0127-snapshots-pages-lists-history-gc.md), [0132](../decisions/0132-forks-and-retained-history.md), [0137](../decisions/0137-inspection-audited-operations-telemetry.md); owning contracts: [06](../contracts/06-storage.md) and [09](../contracts/09-recovery.md).

## Public operation and storage key

`Store.setRetention(duration, { grant, reason })` and `Store.retention` are exported by `@rikalabs/akter/server`. The provided service exposes the same setter and an effective-retention read Effect. The operator requires `{ action: "retention.set", tenant: "*" }` without actor/command restrictions. Duration is one through 365 days inclusive; `RetentionRefused` distinguishes scope/range, and a CAS loser receives `RetentionConflict`.

The object key is `meta/retention`, JSON `{ retentionMillis, revision, audit }`. Initial creation uses `If-None-Match: *`; subsequent replacements use the read ETag with `If-Match`. The setter never uses a plain overwrite or rebases a retry onto the winner. The value and current audit commit together; the previous audit is archived before replacement. An absent record falls back to initial `meta/store`, while a corrupt record fails closed. Reopening options seed only new stores.

`akter retention "30 days" --url <runner> --reason "paid plan"` uses the existing independent operator credential and `POST /operator`. No application caller or Cloud-login credential becomes an operator grant. The wire request is `{ operation: "retention", target: { store: true }, tenant: "*", reason, retentionMillis }`; its response is `{ retentionMillis, revision }`.

## Wrong implementations rejected

| Evidence                                                                                  | Wrong implementation rejected                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared retention conformance on memory, filesystem and MinIO, four held two-writer rounds | Plain PUT/last-writer-wins; both writers winning; retry refreshing the original condition; missing typed conflict                                             |
| Same suite: reopen, scope, inclusive bounds, audit persistence                            | Reopen option mutating existing policy; tenant/actor/command-scoped grants changing a store; accepting out-of-range durations; overwriting the previous audit |
| Same suite: lost write response, archive outage, corrupt record                           | Counting one update twice; changing policy before mandatory audit persistence; corrupt policy silently adopting the initial value                             |
| `store/retention.test.ts`, Simulation seeds 910–917                                       | GC/trim/fork caching open-time retention; widening deleting 20-day history; narrowing losing its checkpoint anchor or complete chain; expired fork/log access |
| Same file: paused two-shard GC with a concurrent narrowing                                | A single collection pass mixing old/new values across shards; failing to apply the new value on the next pass                                                 |
| `apps/cli/src/commands/operator.test.ts`, real HTTP                                       | A help/parser-only CLI implementation; application/missing/tenant-only authority; missing success/denial audit                                                |

The seeded scenario creates independent 90-item state and edits asymmetric items at days 10 and 18, then widens at day 20. After narrowing, the surviving day-10 anchor reconstructs the day-18 version with both edits and count 92. The larger window retains the old checkpoint/page/segment; the smaller one removes the older checkpoint and trims only through the day-10 anchor. Public log reads exclude the expired `fill` command. Recovery reads remain separate so anchor bytes are not lost to authorization filtering.

## Semantics and limits

A collection pass captures policy after taking its marking epoch; all deletion subepochs keep that value. A change during a running pass affects the next pass, including widening. Segment trim remains a separate shard operation and captures policy once per request. Widening cannot restore already-trimmed segments or already-deleted pages. An older checkpoint exposed as an anchor/newest recovery image is not permission to fork an expired position.

MinIO exercises the actual conditional S3 record protocol; simulator and filesystem clocks establish multi-day retention transitions. Neither is evidence for Cloudflare R2 or Tigris. Provider-specific races and per-key write-rate evidence remain in the provider/nightly gates.

## Verification commands

All commands below passed on Dallen's Mac (macOS arm64), Bun 1.4.2 and Node 26.7.0, on 2026-10-13. Heavy commands ran through `~/.capy/work/akter-launch/heavy.sh`:

```sh
bun run check:static
bun run typecheck
bun run lint
bun run --cwd packages/akter test
node node_modules/vitest/vitest.mjs run packages/akter/src --exclude packages/akter/src/store/s3.test.ts --exclude packages/akter/src/runtime/cluster-process.test.ts
docker compose -p akter-e8e -f packages/akter/compose.yaml up -d --wait
TEST_S3_URL=http://project:project-minio@127.0.0.1:9000/akter-store bun run --cwd packages/akter test:integration
SMOKE_RUNTIME=bun bun run pack:smoke
SMOKE_RUNTIME=node bun run pack:smoke
docker compose -p akter-e8e -f packages/akter/compose.yaml down -v
```

The MinIO image is the Chainguard digest pinned in `packages/akter/compose.yaml`. Full `packages/akter` runs include the seeded matrices on both runtimes, not only the new seeds.

| Check                               | Observed result                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `check:static`                      | Four static tasks and 44 GitHub-tooling tests passed                                                               |
| `typecheck`                         | Seven workspace tasks passed                                                                                       |
| `lint`                              | Eight tasks passed; zero warnings/errors                                                                           |
| Framework tests, Bun and Node       | 37 files / 292 tests passed on each runtime, including the full 1,000-seed and moving 200-seed matrices            |
| MinIO integration, Bun and Node     | Two files / 57 tests passed on each runtime, including real retention CAS races                                    |
| CLI operator and command-tree tests | Two files / five tests passed over real HTTP                                                                       |
| `pack:smoke`, Bun and Node          | Clean consumers installed, typechecked, served HTTP/WebSocket RPC, and ran all package entries and CLI help checks |
| E8e container cleanup               | `down -v` removed the E8e container, network and volume; no E8e container remained                                 |
