---
title: "Your database"
description: "Akter Cloud creates a Postgres database for each project environment. Team and Enterprise can bring their own."
---

Akter Cloud provides your database. When you create a project environment, the platform creates a Postgres database for it on a shared Postgres server that Akter runs. You do nothing: there is no provider account to open and no connection string to copy. Deploy your app and it runs against that database.

Team and Enterprise can instead connect a Postgres database they own. See [Bring your own Postgres](/cloud/bring-your-database).

## One database per environment

Each environment of each project gets its own database and its own login. `production`, `staging` and `dev` never share data, and neither do two projects. The platform stores the connection as the environment's encrypted `DATABASE_URL`. [`akter env list`](/cloud/environment-variables) shows it with `managed` provenance, and every deployment uses it automatically.

Like every environment value, the managed `DATABASE_URL` cannot be read back through the console, API or CLI. On Free and Pro it is platform-provided and cannot be replaced or unset. On Team and Enterprise, setting your own `DATABASE_URL` switches that environment to [your own database](/cloud/bring-your-database).

## Size and plan limits

Included database size depends on your plan: 0.5 GB on Free, 10 GB on Pro, 50 GB on Team and a custom size on Enterprise. Free's 0.5 GB is a hard cap. Pro and Team are billed $0.50 per GB-month beyond their included size. Team can add a dedicated database. See [pricing and limits](/cloud/pricing-and-limits) for the full table.

## Deployments and data

The platform runs your app's migrations against the environment's database during each deployment, before new runners start serving. Your app's tenant authorization still matters; a database does not replace authorization inside your app.

Rollback does not undo database changes. Keep migrations compatible with the previous release so a rollback can run against the migrated schema. Use a separate environment for data that must stay isolated.

## Deletion removes the managed database

Deleting an environment, project or organization deletes the managed database of every environment it contains, along with Akter's stored variables and platform records. Deletion removes the data and there is no documented undo, so export what you need first. See [account deletion and personal export](/cloud/account-and-data).

A [bring-your-own database](/cloud/bring-your-database) is never deleted, erased or administered by Akter. If you want it removed, do that with its provider.

## Backups

Akter Cloud does not promise backups, point-in-time recovery or a customer restore workflow for a managed database, and a failed rollout or rollback is not a restore. Keep your own export of data you cannot lose. If you need your own backup and recovery tooling, bring your own Postgres database on Team or Enterprise.
