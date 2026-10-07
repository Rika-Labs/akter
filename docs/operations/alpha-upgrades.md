---
title: "Alpha upgrade notes"
description: "Upgrade an existing database from alpha.1 to the alpha.2 release candidate without mixing runner versions."
---

# Alpha upgrade notes

## 0.1.0-alpha.1 → 0.1.0-alpha.2

Alpha.2 is a release candidate until the maintainer tags and publishes it. These instructions do not claim that an upgrade of your deployment or a production restore has been rehearsed. The framework adds these migrations after `0029_runner_configuration` in the alpha.1 tag:

| Migration                  | Change                                                                                                                                                                                                             | Operator action                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0030_receipt_timing`      | Adds nullable `started_at_ms` and `committed_at_ms` receipt columns, a default commit timestamp for new rows, and receipt timing in the joined inspection view. Existing receipts retain unknown timing as `null`. | Do not interpret missing historical timing as zero latency or a migration-time commit.                                                                   |
| `0031_routable_views`      | Adds single-table `durable.*_v2` inspection views and `durable.placements_v2`. Existing joined views remain on an ordinary Postgres database; the Neki path removes those joined views.                            | Update direct SQL tooling to join placement explicitly by `actor_type`. Reapply inspection-view ownership and grants when row-level security is enabled. |
| `0032_authority_placement` | Extends the `actor_placements` constraint to accept `authority` placement.                                                                                                                                         | Stop all old runners before changing tenant placement to authority placement or changing coordination authority.                                         |

Read [migrations](02-migrations.md), [inspection views](inspection-views.md), and the [support matrix](support-matrix.md) before upgrading. Neki remains outside the launch support claim.

### No mixed-alpha rolling upgrade

Do not run alpha.1 and alpha.2 runners side by side against the same database. [Versioning](../api/versioning.md) explicitly excludes alphas from the non-alpha rolling-compatibility guarantee. The [migration contract](02-migrations.md#how-framework-migrations-run) allows an older runtime to start after newer SQL migrations; that is not evidence of compatible routing, payloads, protocols or inspection behavior.

In particular, declaring an existing tenant-placed actor type as authority-placed moves its framework and owned-table rows to new routing keys at startup. [Authority placement](../decisions/0097-authority-placed-control-plane-actors.md#moving-an-existing-deployments-rows) requires the previous runners stopped: a still-running old runner could recreate actors under the old keys. The move is transactional on an ordinary Postgres database and is refused once a split shard map exists; perform it before routing tables. Changing the coordination authority also requires every runner stopped. Even without either change, mixed-alpha operation has not been verified as safe, so this release uses a stopped-runner upgrade.

### Upgrade procedure

1. Take and verify a restorable backup. Record runtime and peer versions, `actor_migrations` rows, owned-table schema, actor declarations and deployment configuration. Pause external ingress and scheduled execution, drain and stop every alpha.1 runner. Use a restored disposable copy for the rehearsal, with the same Postgres server version and permissions as the deployment; do not point a candidate at production first.
2. Install matching `@rikalabs/akter@0.1.0-alpha.2` and, if used, `@rikalabs/akter-cli@0.1.0-alpha.2`. Published Effect, SQL-driver and Drizzle peers accept compatible caret ranges with the catalog versions as floors. Verify your resolved dependency graph has one shared Effect copy, retain the consumer lockfile and rehearse against those versions. Node requires 24+ and Bun requires 1.4.2+. Apply application-owned SQL migrations before actor startup; lazy `Actor.state` and stored event/job migrations remain the application's responsibility.
3. Start one alpha.2 runner and let `Actors.layer` apply framework migrations before actor registration. There is no `akter migrate` command. On an ordinary Postgres database, the unapplied migrations run in one transaction under an exclusive migration-history lock; interrupted migrations roll back and can be retried on the next boot. PGlite uses the same migration ledger with exclusive data-directory ownership. Neki uses autocommit DDL, propagation barriers and a step journal instead and remains outside the supported launch backends.
4. If using row-level security, apply migrations with the migrating role first, then follow the [view-owner procedure](01-deployment.md#row-level-security) and regrant `SELECT` on new views before starting with the tenant role. Update SQL tools to use `_v2` views and join `durable.placements_v2` by `actor_type`. Treat historical receipt timing as unknown, not zero. Do not delete migration or Neki step-journal rows to bypass a failure.
5. Rename operator configuration to `AKTER_OPERATOR_TOKEN` and update inspector URLs to `/_akter/inspector`. For hosted deployment clients, use `src/app.ts` and remove `source.dockerfile`. Update cloud response decoders for nullable latency values, `since`, payment-method variants and stream gaps; use `--api-url` when testing login against a preview rather than the default production API.
6. Confirm readiness, an existing receipt replay with the original command id, new commands, pending outbox/job recovery and inspection with the deployment's tenant role. Commands cut off by runtime shutdown now answer retryable `ActorUnavailable`; interruption or reply loss does not prove a command never committed. Only after these checks pass, start the remaining alpha.2 runners and resume ingress and scheduled execution. Record the rehearsal results before promotion.

After alpha.2 is published and while it is the current `alpha` release, select that tag explicitly rather than relying on `latest`:

```sh
bun add @rikalabs/akter@alpha
bun add -d @rikalabs/akter-cli@alpha
```

Or with npm:

```sh
npm install @rikalabs/akter@alpha
npm install -D @rikalabs/akter-cli@alpha
```

Confirm both installed versions are `0.1.0-alpha.2` before starting runners. For a repeatable deployment after the `alpha` tag advances, use the explicit versions in step 2 and the rehearsed lockfile. Moving `latest` is a separate maintainer operation; it is not automatic when publishing to `alpha`.

There are no framework down migrations. A failed rehearsal is a stop, not permission to delete migration-history rows. A rollback after incompatible schema or placement changes requires stopping all alpha.2 runners and restoring the verified backup with the alpha.1 runtime and configuration; simply restarting alpha.1 binaries is not a safe rollback procedure.
