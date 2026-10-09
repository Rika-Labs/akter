---
title: "Your database"
description: "Akter Cloud creates a Postgres database for each project environment. Team and Enterprise can bring their own."
---

Akter Cloud provides your database. When you create a project environment, the platform creates a Postgres database for it on a shared Postgres server that Akter runs. You do nothing: there is no provider account to open and no connection string to copy. Deploy your app and it runs against that database.

Team and Enterprise can instead connect a Postgres database they own. See [Bring your own Postgres](/cloud/bring-your-database).

## One database per environment

Each environment of each project gets its own database and its own login. `production`, `staging` and `dev` never share data, and neither do two projects. A new project's three environments have their databases within seconds. The platform stores the connection as the environment's encrypted `DATABASE_URL`, and every deployment uses it automatically. [`akter env list`](/cloud/environment-variables) shows `DATABASE_URL` and the `AKTER_DATABASE_ID` that identifies the database, each marked `managed`.

Like every environment value, the managed `DATABASE_URL` cannot be read back through the console, API or CLI. You cannot unset it. Free and Pro cannot replace it; on Team and Enterprise, setting your own `DATABASE_URL` switches that environment to [your own database](/cloud/bring-your-database).

## Size and plan limits

Included database size depends on your plan: 0.5 GB on Free, 10 GB on Pro, 50 GB on Team and a custom size on Enterprise. It is pooled per organization across all of its managed environment databases, not per environment. Pro and Team are billed $0.50 per GB-month beyond it.

Free's 0.5 GB is a hard cap. Akter measures each managed database about every 10 minutes. When the organization's pooled total reaches 0.5 GB, all of its managed databases become read-only together shortly after: writes fail and reads still work, until usage drops below the cap or the organization upgrades. See [pricing and limits](/cloud/pricing-and-limits) for the full table.

## Deployments and data

The platform runs your app's migrations against the environment's database during each deployment, before new runners start serving. Your app's tenant authorization still matters; a database does not replace authorization inside your app.

Rollback does not undo database changes. Keep migrations compatible with the previous release so a rollback can run against the migrated schema. Use a separate environment for data that must stay isolated.

## Deletion removes the managed database

Deleting an environment, project or organization deletes the managed database of every environment it contains, along with Akter's stored variables and platform records. The database is dropped after the environment's runners have drained. Deletion removes the data and there is no documented undo, so export what you need first. See [account deletion and personal export](/cloud/account-and-data).

A [bring-your-own database](/cloud/bring-your-database) is never deleted, erased, administered, billed or size-capped by Akter. If you want it removed, do that with its provider.

## Backups

Akter Cloud does not promise backups, point-in-time recovery or a customer restore workflow for a managed database, and a failed rollout or rollback is not a restore. Keep your own export of data you cannot lose. If you need your own backup and recovery tooling, bring your own Postgres database on Team or Enterprise.
