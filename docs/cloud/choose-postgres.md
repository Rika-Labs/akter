---
title: "Choose a Postgres"
description: "Choose a customer-owned database near Akter Cloud's runners and copy its direct connection URL."
---

Akter Cloud requires your own Postgres on **every plan**. Open an account with your database provider, choose a database size and backup policy, and pay that provider separately. Akter supplies hosted compute, not a database.

## Choose the region first

Cloud runners start in **Fly `iad`, Northern Virginia**. Prefer **AWS `us-east-1`** for your Postgres database, rather than a region close to your laptop. Akter probes from the runner region at deploy: **p50 above 5 ms warns but does not block deployment**. Your database's latency and capacity still limit the app, even when Akter adds runners.

## Provider options

| Provider                                                                                                                  | Region to select                             | Connection to copy                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Neon](https://neon.com/docs/get-started-with-neon/connect-neon)                                                          | AWS US East (N. Virginia), `aws-us-east-1`   | Turn **Connection pooling** off in **Connect**. Use the direct URL with no `-pooler` in its host.                                                                                                     |
| [Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres)                                              | East US (North Virginia), `us-east-1`        | Select **Direct connection** in **Connect**, not the transaction pooler. Direct connections use IPv6 unless you buy the provider's IPv4 add-on; make sure the endpoint is reachable from the runners. |
| [PlanetScale Postgres](https://planetscale.com/docs/postgres/connecting/quickstart)                                       | AWS us-east-1 (Northern Virginia), `us-east` | Create an app role and copy the direct Postgres URL on port **5432**, not PgBouncer on **6432**. Choose Postgres, not Vitess or Neki.                                                                 |
| [Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ConnectToPostgreSQLInstance.html) | US East (N. Virginia), `us-east-1`           | Use the writable DB instance endpoint on port **5432**, with network access from the runners. See the TLS caveat below before choosing it.                                                            |

<Warning>
RDS uses an [AWS RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html). Cloud's current TLS rule requires a publicly trusted certificate and does not load a custom `sslrootcert` from the URL. RDS is not a usable option until its CA is trusted by Cloud; do not disable certificate verification to work around this.
</Warning>

These links explain provider setup, not provider-specific Akter certification. Check the framework's [support matrix](/operations/support-matrix) for verified server versions and evidence boundaries. A successful deploy-time probe establishes connectivity, not backup, recovery or failover support.

## Before you deploy

- Use a **direct, non-pooled URL** to the writable database. Transaction poolers cannot preserve the session semantics the runtime needs and are refused.
- Give your app's role permission to create and alter its tables for migrations. Keep credentials and backups under your control.
- Check available connections as well as database size. Akter budgets 9 connections per runner after subtracting connections already in use and a reserve of 10; [Connect your Postgres](/cloud/database#deploy-time-checks) explains the runner cap.
- Use separate databases and roles for environments whose data must stay isolated. Akter never creates, copies or deletes those databases for you.

Next, [set `DATABASE_URL` and deploy](/cloud/database#set-the-connection-and-deploy).
