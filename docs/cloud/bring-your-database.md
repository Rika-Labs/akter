---
title: "Bring your database"
description: "Connect a customer-owned PlanetScale database, then deploy your app."
---

Each Cloud environment needs your own Postgres database or Neki database. PlanetScale is recommended; you pay your database provider separately from [Akter Cloud](/cloud/pricing-and-limits).

## Connect a PlanetScale Postgres database

1. Create a Postgres database in your PlanetScale organization. See the [PlanetScale database quickstart](https://planetscale.com/docs/postgres/tutorials/planetscale-postgres-quickstart).
2. Create credentials for an application role with the permissions your app's migrations and runtime need, then copy its direct, TLS-enabled connection URL. PlanetScale's [connection guide](https://planetscale.com/docs/postgres/connecting/quickstart) explains creating roles and connection strings.
3. Save the URL in a secure local file outside your deployment directory, for example `database-url.txt`. Store only the URL, with no surrounding quotes or trailing newline. Do not commit the file or put the secret in a command argument.
4. From your app directory, set it for your Cloud project environment, replacing `PROJECT_ID` with your project's ID. These examples keep the secret file in the parent directory:

```sh
bunx akter env set DATABASE_URL --project PROJECT_ID --env production --file ../database-url.txt
bunx akter deploy --project PROJECT_ID --env production
```

With Node, use `npx akter` instead of `bunx akter`. The default `AKTER_DATABASE_ENGINE` is `postgres`; no engine variable is needed for a Postgres database.

The URL must use `postgres://` or `postgresql://`, include a host, and contain no fragment, whitespace, control characters or shell syntax, including their percent-encoded forms. Invalid values are rejected without echoing the input. See [environment variables](/cloud/environment-variables) for input and naming rules.

## Connect a Neki database

Create your Neki database with your provider and supply its connection URL through the same write-only file input. Before deploying, select the Neki engine:

```sh
bunx akter env set DATABASE_URL --project PROJECT_ID --env production --file ../database-url.txt
printf %s neki | bunx akter env set AKTER_DATABASE_ENGINE --project PROJECT_ID --env production
bunx akter deploy --project PROJECT_ID --env production
```

`neki` selects the framework's live-topology Neki mode, not a fixed shard map. To switch back to the default engine, unset `AKTER_DATABASE_ENGINE` and deploy again with a Postgres database connection.

The connection cannot be read back from the console or API. Environment reads show only whether a connection is configured and which engine is selected. [Database ownership and deletion](/cloud/database) explains what stays with your provider when you remove a Cloud environment or project.
