---
title: "Your database"
description: "Connect each Cloud environment to a database you own and control."
---

Akter Cloud runs your app against **your own Postgres database or Neki database**. PlanetScale is the recommended provider. Each project environment needs a connection configured before you can deploy; Akter does not create a database for it. Follow [Bring your database](/cloud/bring-your-database) to get started.

## Ownership and configuration

Set `DATABASE_URL` with [`akter env`](/cloud/environment-variables). The default engine is `postgres`; set `AKTER_DATABASE_ENGINE` to `neki` when connecting to a Neki database.

The connection URL is encrypted at rest and write-only. Environment reads expose only `database: { configured, engine }` about the connection, never its URL, host, username, password or database name. Keep your own secure copy of the credentials.

You own the database credentials, capacity, backups, recovery and provider bill. The login you supply must have the permissions your app needs for its migrations and runtime. Your app's tenant authorization still matters; a database connection does not replace authorization inside your app.

## Deployments and data

A deployment captures the environment's database connection with its other variables. Migration and serving use that same encrypted snapshot. Deployment creation, redeploy and rollback all require a configured `DATABASE_URL`. Changing it affects the next deployment, not a running one, and does not move data to the new database. Rollback uses the selected deployment's captured connection and does not undo database changes.

Use separate databases for environments whose data must stay isolated. Keep migrations compatible with the previous release, and use your database provider's backup and recovery tools rather than treating a failed rollout or rollback as a restore.

## Deletion leaves your database alone

Deleting an environment or project removes Akter's stored variables and platform records. Deleting an organization retires its runners and removes its Cloud records. None of these operations deletes, erases or administers your external database.

If you want to remove that database, do so separately with its provider after exporting or backing up anything you need. Akter Cloud does not provide database backups or a customer database restore workflow.
