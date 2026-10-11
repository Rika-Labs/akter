---
title: "Connect your Postgres"
description: "Every environment on every plan needs your own Postgres database and DATABASE_URL."
---

Akter Cloud hosts compute, not databases. **Every environment on every plan, including Free, requires your own Postgres connection in `DATABASE_URL` before you deploy.** Akter does not provision a database or charge for its storage. You pay your database provider separately from Akter's [compute bill](/cloud/pricing-and-limits).

If you do not have a database yet, start with [Choose a Postgres](/cloud/choose-postgres). Use a separate database and role for each environment that must have isolated data: creating `production`, `staging` or `dev` in Akter does not create or isolate a database for you.

## Connection requirements

Your `DATABASE_URL` must meet these rules:

- Use `postgres://` or `postgresql://` with a host, no fragment, and no raw whitespace or control characters. Percent-encode special characters in the username and password.
- Use a **direct, non-pooled connection** to the writable database. Transaction-pooler URLs are refused: the runtime requires session semantics, including state that must remain on the same Postgres session. Do not use Neon's `-pooler` endpoint, Supabase's transaction pooler or PlanetScale's PgBouncer port.
- Include **exactly one** `sslmode` query parameter, set to `require`, `verify-ca` or `verify-full`. Missing, repeated or other values, including `disable`, `prefer` and `no-verify`, are refused.
- The server certificate must chain to a public certificate authority, or AWS's official RDS CA for a native RDS endpoint, and match the URL's host name. Akter validates the full chain and host name for all three accepted `sslmode` values; use `verify-full`. A custom root certificate in the URL (`sslrootcert`) is not used, and other private CAs remain unsupported.
- The login must be able to create and alter the app's tables. Migrations use the same connection; insufficient permissions fail the deployment at its `migrate` step.

Postgres is the only Cloud database engine. The framework's [support matrix](/operations/support-matrix) defines verified server versions and provider evidence; a successful connection probe is not a durability or recovery certification.

## Amazon RDS and Aurora PostgreSQL

Akter Cloud includes AWS's official RDS global CA bundle for **RDS PostgreSQL and Aurora PostgreSQL in commercial AWS regions**. You do not need to upload a CA certificate or add `sslrootcert` to the URL. Full certificate-chain and host-name verification stay enabled.

- Choose **US East (N. Virginia), `us-east-1`**, beside Akter's launch runners in Fly `iad`. Other regions can add database latency.
- Copy the **writable RDS instance endpoint** or **Aurora writer cluster endpoint** on port **5432**, using its AWS-issued host name ending in `.rds.amazonaws.com`. The additional RDS roots apply only to those native host names, not a custom DNS alias or IP address. GovCloud and China use separate CA bundles and are not covered by this support.
- Include **`sslmode=verify-full`**. Akter also accepts `require` and `verify-ca`, but still checks the full chain and host name for both. Never disable certificate verification to work around a connection error.
- Use the **direct database endpoint**, rather than RDS Proxy or a transaction-pooling gateway. Akter needs session semantics; transaction-pooling mode is not supported. The RDS CA bundle does not establish proxy compatibility.
- Make sure the endpoint is reachable from the runners. A private VPC-only endpoint is not reachable merely because its CA is trusted; configure an appropriate network path and security-group access.

## Set the connection and deploy

1. Create a database and an app role with migration permissions, then copy its direct connection URL.
2. Save only the URL in a secure local file outside your deployment directory, for example `../database-url.txt`. Do not include quotes or a trailing newline, commit the file, or put the secret in a command argument. The URL looks like this, with your own values:

```text
postgresql://APP_ROLE:PASSWORD@HOST:5432/DATABASE?sslmode=verify-full
```

3. From your app directory, replace `PROJECT_ID` with your project's ID and set the variable for the environment you will deploy:

```sh
bunx akter env set DATABASE_URL --project PROJECT_ID --env production --file ../database-url.txt
bunx akter deploy --project PROJECT_ID --env production
```

With Node, use `npx akter` instead of `bunx akter`. Invalid values are refused without echoing the URL. See [environment variables](/cloud/environment-variables) for file/stdin input and naming rules.

## Deploy-time checks

At deploy, Akter probes your database from the **runner region, Fly `iad` in Northern Virginia**, near AWS `us-east-1`. Choose a database in `us-east-1` to keep the network path short. If the measured **p50 latency is above 5 ms**, Akter warns but still deploys; latency alone is not a refusal. A missing or unreachable database, invalid URL or transaction-pooler connection must be corrected before deployment can proceed.

The probe also budgets database connections. The database-derived runner cap is:

```text
runner cap = floor((max_connections - in_use - 10) / 4)
```

`max_connections` is the server's connection limit and `in_use` is the sum of `pg_stat_database.numbackends` across the server, including the probe's measuring connection. Akter budgets 4 sessions per runner: 1 turn, 2 off-turn (including the coordination session) and 1 query. The fixed 10-session reserve retains the original platform sizing allowance: 3 superuser slots, 3 provider-internal slots and 4 maintenance/operator headroom slots. It is conservative, not a measurement of your provider's requirements; those slots are subtracted in addition to measured usage.

### Choose capacity for your expected runner load

A runner is a hosted compute process, not an actor or a fixed requests-per-second tier. The minimum **at one probe** is `in_use + 10 + 4 × total admitted runners`. Measured `in_use` includes existing hosted sessions; their runners also continue to occupy admission claims. Each deploy remeasures before starting replacements, so sizing before the first deploy must account for the sessions those incumbents will add to the next probe.

For pre-first-deploy planning, let **baseline** mean server sessions in use before Akter starts, including the measuring session. Budget **`baseline + 10 + 4 × incumbent runners + 4 × total runners during overlap`**. Assuming other usage stays constant and incumbent pools reach their four-session bound:

| Expected runner load                        | Incumbents / total during overlap | Minimum at this probe | Minimum before first deploy | Example with baseline 7 |
| ------------------------------------------- | --------------------------------- | --------------------- | --------------------------- | ----------------------: |
| Development, no rollout overlap             | 0 / 1                             | `in_use + 14`         | `baseline + 14`             |                      21 |
| One serving runner plus one replacement     | 1 / 2                             | `in_use + 18`         | `baseline + 22`             |                      29 |
| Four serving runners plus one replacement   | 4 / 5                             | `in_use + 30`         | `baseline + 46`             |                      53 |
| Eight serving runners plus two replacements | 8 / 10                            | `in_use + 50`         | `baseline + 82`             |                      89 |

For example, baseline 7 and `max_connections = 25` initially give a cap of 2. Once the first runner uses four sessions, the replacement probe sees 11 in use and returns cap 1; the incumbent's claim occupies it, so the replacement cannot start. Use at least **29** instead: the first probe allows 3, and the replacement probe still allows 2. At 28, that replacement cap falls back to 1. The four- and eight-serving examples budget partial replacement overlap; if a release replaces all regions together, include all its new runners, not just one or two.

These are connection minima, not memory/CPU or throughput recommendations. Measure your application's load to choose its runner count and database resources; application-owned pools need additional connections. A limit of 100 with 17 currently in use allows 18 at that probe, not necessarily at the next one. Leave margin for changing usage rather than sizing exactly at the boundary.

Before your first deploy, open **Database → Plan capacity before deploying** in the console. Run `SHOW max_connections` and `SELECT sum(numbackends) FROM pg_stat_database` on your Postgres server and enter the results to estimate the cap without deploying. The console distinguishes this estimate from the regional probe result. After a probe, **Database** and **Deployments** show the latest environment ceiling, not a count of spare runners. Saving or refreshing the connection does not run a new regional probe.

To raise the ceiling, increase `max_connections` within your database provider's supported limit, upgrade to a larger **database provider plan**, or free competing database connections. Check your provider's memory guidance and restart requirements before changing the parameter. Upgrading your Akter plan does not increase your database's connection limit. Deploy again to remeasure; a cap of zero prevents migrations and runner starts.

This is a connection ceiling, not a throughput guarantee. Akter handles runner orchestration, but your Postgres capacity and latency still bound the app's scale.

## Change or remove the connection

The URL is encrypted at rest and write-only. A deployment captures its environment variables, including `DATABASE_URL`; changing the URL affects the next deployment, not one already running. Akter does not copy data to the replacement database. Rollback uses the selected deployment's captured connection and does not undo schema or data changes, so keep migrations compatible with both releases.

You can remove `DATABASE_URL` on every plan:

```sh
bunx akter env unset DATABASE_URL --project PROJECT_ID --env production
```

Removal does not change a running deployment or touch your database. The **next deploy is refused until you set `DATABASE_URL` again**. Akter does not create a fallback database, and changing plans does not remove the requirement.

## What you own

You own database credentials, permissions, capacity, backups, recovery and the provider bill. Keep a secure copy of the URL and configure your provider's backup and restore tooling before relying on production data. Migrations and runtime use the supplied login; keep its permissions as narrow as migrations allow. A database connection does not replace tenant authorization inside your app.

**Akter never deletes your database.** Deleting an environment, project, organization or account removes Akter's stored configuration and platform records, not the database or its data. If you want to delete the database, do that with its provider after exporting or backing up anything you need. See [account deletion and personal export](/cloud/account-and-data).
