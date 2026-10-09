---
title: "Bring your own Postgres"
description: "Team and Enterprise can connect a Postgres database they own instead of the one Akter Cloud creates."
---

Bring-your-own Postgres is optional and available on **Team and Enterprise** only. Every other environment already has a [managed database](/cloud/database) that Akter Cloud creates and deletes for you, so you do not need this page unless you want to own the database. On Free and Pro, setting `DATABASE_URL` is refused with `Refused: A custom DATABASE_URL requires the Team or Enterprise plan; this environment uses its managed Postgres database`.

You pay your database provider separately for a database you bring. Akter never bills or caps its size, and it does not count toward your plan's pooled database allowance. Akter Cloud still bills your plan and [compute](/cloud/pricing-and-limits).

## Requirements

Your `DATABASE_URL` must meet all of these rules:

- It uses `postgres://` or `postgresql://` and includes a host.
- It has no fragment, and no raw whitespace or control characters. Percent-encode special characters in the username and password.
- It contains **exactly one** `sslmode` query parameter, set to `require`, `verify-ca` or `verify-full`. A missing, repeated or any other value, including `disable`, `prefer` and `no-verify`, is refused.
- The server certificate chains to a public certificate authority, and its host name matches the URL. Akter checks both for all three accepted `sslmode` values, so they behave the same; `verify-full` is the recommended value. A custom root certificate in the URL (`sslrootcert`) is not used. Providers such as PlanetScale and Neon work. Amazon RDS, Google Cloud SQL and self-signed or private-CA endpoints are not supported yet.
- The login can create and alter tables. Migrations run with the same URL, so a role without those permissions fails the deployment at its `migrate` step.

Postgres is the only engine Akter Cloud supports. Neki is not offered on Cloud.

## Connect your database

1. Create a Postgres database with a provider whose certificate chains to a public CA. For PlanetScale, see its [database quickstart](https://planetscale.com/docs/postgres/tutorials/planetscale-postgres-quickstart).
2. Create a role for your app that can create and alter tables, then copy its direct connection URL, adding `sslmode=verify-full` if it is not already present. PlanetScale's [connection guide](https://planetscale.com/docs/postgres/connecting/quickstart) explains creating roles and connection strings.
3. Save the URL in a secure local file outside your deployment directory, for example `database-url.txt`. Store only the URL, with no surrounding quotes or trailing newline. Do not commit the file or put the secret in a command argument. It looks like this, with your own values:

```text
postgresql://APP_ROLE:PASSWORD@HOST:5432/DATABASE?sslmode=verify-full
```

4. From your app directory, set it for your project environment, replacing `PROJECT_ID` with your project's ID. These examples keep the secret file in the parent directory, and `bunx akter` becomes `npx akter` with Node:

```sh
bunx akter env set DATABASE_URL --project PROJECT_ID --env production --file ../database-url.txt
bunx akter deploy --project PROJECT_ID --env production
```

Invalid values are rejected without echoing the input. See [environment variables](/cloud/environment-variables) for input and naming rules.

<Warning>
Setting your own `DATABASE_URL` does not copy data. Akter retires the environment's managed database when you switch, so export anything you need from it first.
</Warning>

## Switch back or change plan

Unsetting your own `DATABASE_URL` returns the environment to a fresh, empty managed database. No data is copied from your database, which Akter leaves untouched. A release deployed before you switched between the managed database and your own does not start again after the switch, so you cannot roll back across it; deploy again instead.

If your organization downgrades below Team, environments already using their own database keep running. New deployments of those environments are refused until the organization upgrades or you unset `DATABASE_URL`.

## What you own

You own the database's credentials, capacity, backups, recovery and provider bill. Your app's migrations and runtime use the login you supply, so keep its permissions as narrow as migrations allow. A database connection does not replace tenant authorization inside your app.

The URL is encrypted at rest and write-only, so keep your own secure copy of the credentials. A deployment captures the environment's variables, including `DATABASE_URL`. Changing it affects the next deployment, not a running one, and rollback uses the selected deployment's captured connection. Rollback does not undo database changes.

Akter never deletes a bring-your-own database. Deleting an environment, project or organization removes Akter's stored variables and platform records only. Remove the database itself with your provider, after exporting or backing up anything you need.
