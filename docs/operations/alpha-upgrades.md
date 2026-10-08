---
title: "Alpha upgrade notes"
description: "Upgrade an existing database from alpha.1 to the alpha.3 release candidate without mixing runner versions."
---

# Alpha upgrade notes

## 0.1.0-alpha.1 → 0.1.0-alpha.3

Alpha.3 is a release candidate until the maintainer tags and publishes it; alpha.2 was an unpublished draft. These instructions do not claim that an upgrade of your deployment or a production restore has been rehearsed. The framework adds these migrations after `0029_runner_configuration` in the alpha.1 tag:

| Migration                  | Change                                                                                                                                                                                                             | Operator action                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0030_receipt_timing`      | Adds nullable `started_at_ms` and `committed_at_ms` receipt columns, a default commit timestamp for new rows, and receipt timing in the joined inspection view. Existing receipts retain unknown timing as `null`. | Do not interpret missing historical timing as zero latency or a migration-time commit.                                                           |
| `0031_routable_views`      | Historical migration that adds single-table `_v2` inspection variants. `0033` retires them in the same startup upgrade.                                                                                            | Do not migrate tooling to these names; use the original joined views.                                                                            |
| `0032_authority_placement` | Extends the `actor_placements` constraint to accept `authority` placement.                                                                                                                                         | Stop all old runners before changing tenant placement to authority placement or changing coordination authority.                                 |
| `0033_joined_inspection`   | Drops all 15 `_v2` variants and restores the original 14-entry view catalog. It preserves actor data, joined-view columns, versions and grants.                                                                    | Stop all previous alpha runners; update SQL tools and dependent views first. Retirement refuses external dependencies instead of cascading them. |

Read [migrations](02-migrations.md), [inspection views](inspection-views.md), and the [support matrix](support-matrix.md) before upgrading. Neki support and both `neki` options are removed; only Postgres and PGlite remain. A Neki database requires a separately rehearsed export/restore into ordinary Postgres, not an in-place runtime upgrade.

### No mixed-alpha rolling upgrade

Do not run alpha.3 alongside any earlier alpha against the same database. [Versioning](../api/versioning.md) explicitly excludes alphas from the non-alpha rolling-compatibility guarantee. The [migration contract](02-migrations.md#how-framework-migrations-run) allows an older runtime to start after newer SQL migrations; that is not evidence of compatible routing, payloads, protocols or inspection behavior.

Declaring an existing tenant-placed actor type as authority-placed moves its framework and owned-table rows to new routing keys transactionally at startup. [Authority grouping](../decisions/0112-postgres-and-pglite-only.md) requires the previous runners stopped: a still-running old runner could recreate actors under the old keys. Changing the coordination authority also requires every runner stopped. Even without either change, old inspectors read the `_v2` views retired by `0033`, so this release requires a stopped-runner upgrade.

### Upgrade procedure

1. Take and verify a restorable backup. Record runtime and peer versions, `actor_migrations` rows, owned-table schema, actor declarations and deployment configuration. Pause external ingress and scheduled execution, drain and stop every alpha.1 runner. Use a restored disposable copy for the rehearsal, with the same Postgres server version and permissions as the deployment; do not point a candidate at production first.
2. Install matching `@rikalabs/akter@0.1.0-alpha.3` and, if used, `@rikalabs/akter-cli@0.1.0-alpha.3`. Published Effect and SQL-driver peers accept compatible caret ranges with 4.0.2 as their floor. Drizzle peers use the catalog floor too. Verify your resolved dependency graph has one shared Effect copy, retain the consumer lockfile and rehearse against those versions. Upgrade pinned Effect and SQL drivers together to 4.0.2 or let them resolve to the latest compatible 4.0.x; do not mix an older Effect with newer drivers. Node requires 24+ and Bun requires 1.4.2+. Apply application-owned SQL migrations before actor startup; lazy `Actor.state` and stored event/job migrations remain the application's responsibility.
3. Update SQL tooling to the original joined `durable` view names, reading `placement` directly. Rewrite any external views depending on a `_v2` variant. Start one alpha.3 runner and let `Actors.layer` apply framework migrations before actor registration. There is no `akter migrate` command. On Postgres, pending migrations run in one transaction under an exclusive history lock, with session coordination before history-table creation. PGlite uses the same transactional ledger with exclusive data-directory ownership. Failure, including an external view blocking `0033`, rolls back the pending migrations; repair the cause and retry startup.
4. If using row-level security, apply migrations with the migrating role first, then follow the [view-owner procedure](01-deployment.md#row-level-security) and regrant `SELECT` on any newly created joined views before starting with the tenant role. Existing joined-view ownership and grants are preserved by `0033`. Treat historical receipt timing as unknown, not zero. Do not delete migration-history rows to bypass a failure.
5. Rename operator configuration to `AKTER_OPERATOR_TOKEN` and update inspector URLs to `/_akter/inspector`. For hosted deployment clients, use `src/app.ts` and remove `source.dockerfile`. Update cloud response decoders for the new `{ source, state }` database and compute/storage billing shapes, `QuotaExceeded.cap`, nullable latency values, `since`, payment-method variants and stream gaps; use `--api-url` when testing login against a preview rather than the default production API.
6. Confirm readiness, an existing receipt replay with the original command id, new commands, pending outbox/job recovery and inspection with the deployment's tenant role. Commands cut off by runtime shutdown now answer retryable `ActorUnavailable`; interruption or reply loss does not prove a command never committed. Only after these checks pass, start the remaining alpha.3 runners and resume ingress and scheduled execution. Record the rehearsal results before promotion.

After alpha.3 is published and while it is the current `alpha` release, these commands select that channel:

```sh
bun add @rikalabs/akter@alpha
bun add -d @rikalabs/akter-cli@alpha
```

Or with npm:

```sh
npm install @rikalabs/akter@alpha
npm install -D @rikalabs/akter-cli@alpha
```

Confirm both installed versions are `0.1.0-alpha.3` before starting runners. For a repeatable deployment after the `alpha` tag advances, use the explicit versions in step 2 and the rehearsed lockfile. Tagged pre-1.0 releases also advance `latest` through the release workflow; `next` canaries never do. Check the registry pointers rather than treating a source version bump as publication.

There are no framework down migrations. A failed rehearsal is a stop, not permission to delete migration-history rows. A rollback after incompatible schema or placement changes requires stopping all alpha.3 runners and restoring the verified backup with the alpha.1 runtime and configuration; simply restarting alpha.1 binaries is not a safe rollback procedure.

### Application testing API

`@rikalabs/akter/testing` retains `ActorTest`, cleanup/content sweeps, database fixtures, batch-law checks and fault controls. Framework conformance, foundation fixtures, `ActorTest.cluster`, `ActorTest.simulate` and `ActorTest.simulateCluster` are no longer published; maintainers use the unpublished [`tooling/conformance` workspace](../../tooling/conformance/README.md). Applications using those alpha-only harnesses must migrate to their own process-level tests; no compatibility aliases pull the conformance corpus back into the package.
