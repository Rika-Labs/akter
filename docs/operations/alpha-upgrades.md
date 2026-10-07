---
title: "Alpha upgrade notes"
description: "Prepare an existing database for the planned alpha.1 to alpha.2 upgrade."
---

# Alpha upgrade notes

## 0.1.0-alpha.1 → 0.1.0-alpha.2 (planned)

This is an upgrade preparation stub, not a release announcement or a claim that an alpha.1-to-alpha.2 production upgrade has been rehearsed. Alpha.2 is not published yet. The framework in this checkout adds these migrations after the `0029_runner_configuration` migration in the alpha.1 tag:

| Migration                  | Change                                                                                                                                                                                                             | Operator action                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0030_receipt_timing`      | Adds nullable `started_at_ms` and `committed_at_ms` receipt columns, a default commit timestamp for new rows, and receipt timing in the joined inspection view. Existing receipts retain unknown timing as `null`. | Do not interpret missing historical timing as zero latency or a migration-time commit.                                                                   |
| `0031_routable_views`      | Adds single-table `durable.*_v2` inspection views and `durable.placements_v2`. Existing joined views remain on an ordinary Postgres database; the Neki path removes those joined views.                            | Update direct SQL tooling to join placement explicitly by `actor_type`. Reapply inspection-view ownership and grants when row-level security is enabled. |
| `0032_authority_placement` | Extends the `actor_placements` constraint to accept `authority` placement.                                                                                                                                         | Do not change an existing actor type's stored placement or coordination authority as part of a rolling deploy.                                           |

Read [migrations](02-migrations.md), [inspection views](inspection-views.md), and the [support matrix](support-matrix.md) before upgrading. Neki remains outside the launch support claim.

1. Take and verify a restorable backup. Record the runtime version, `actor_migrations` rows, owned-table schema, and deployment configuration.
2. Drain and stop all old runners for the initial alpha upgrade rehearsal. Start the candidate against a restored disposable copy first, using the same Postgres server version and permissions as the deployment.
3. Let `Actors.layer` apply the framework migrations; apply your application migrations separately. With row-level security enabled, follow the [view-owner procedure](01-deployment.md#row-level-security) for new views before enabling traffic.
4. Confirm readiness, an existing receipt replay, new commands, pending outbox/job recovery, and inspection with the production tenant role. Keep ingress paused until those checks pass.

There are no framework down migrations. A failed rehearsal is a stop, not permission to delete migration-history rows. A rollback after incompatible schema or placement changes requires the verified backup and the old runtime/configuration. Complete and record the actual upgrade rehearsal before promoting alpha.2; rolling mixed-alpha compatibility is not established by this stub.
