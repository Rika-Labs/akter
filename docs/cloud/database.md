---
title: "Your customer database"
description: "How Cloud provisions, preserves and removes a project's environment database."
---

Akter Cloud provisions a logical customer database and a dedicated customer login for each project environment on its Neki customer cell. This is not a dedicated database server per customer. Production customer databases are separate from the control-plane database that stores Cloud identity, deployment and billing records.

## Managed configuration

Provisioning installs the platform-owned usage journal and the managed `DATABASE_URL`, `AKTER_DATABASE_ID` and `AKTER_DATABASE_ENGINE` variables before the database becomes ready. Their values cannot be read back or changed through `akter env`. The Cloud host uses them to connect your app; you do not need to supply database credentials to deploy.

The customer login can create application objects in its own `public` schema. It cannot connect to another environment's database, assume platform roles, or alter the protected metering journal. Your application's tenant authorization still matters: database separation between environments does not replace authorization inside your app.

## Deployments preserve data

Replacement deployments of the same environment reuse its stable database identity. A rollout migrates that database before starting the new runners. Keep migrations compatible with the previous release; a failed rollout or a rollback is not a database restore.

Deleting an environment or project retires its database generation. Recreating the same environment name gets a new generation rather than adopting the old database. Do not use deletion as a reset you can undo.

## Storage and cleanup

Storage usage is sampled from attributable logical row bytes, not physical disk, indexes or bloat. See [pricing and limits](/cloud/pricing-and-limits) for the Free cap, paid allowances and sampling limitations.

Database removal is asynchronous. Cleanup waits for mapped deployments and runners to retire and for their metering obligations to settle before dropping the database and login. A provider failure leaves cleanup pending for retry; the console accepting deletion does not mean the database has already disappeared.

Customer point-in-time recovery (PITR), a second region and a restore workflow are not offered at launch. Do not treat Cloud as having a customer-accessible PITR guarantee.
