---
title: "Deploy"
description: "Move an Akter app from a local directory to a durable bucket, on your own runners or on Akter Cloud."
---

# Deploy

Your actors and handlers do not change between local development and production. You change three things: the store, the authentication, and where the process runs.

## Use a bucket store

Replace `Store.fileSystem` with `Store.s3`:

```ts
import { Layer } from "effect"
import { Store } from "@rikalabs/akter/server"

const store = Store.s3({
  bucket: "my-akter-store",
  endpoint: "https://s3.example",
  region: "us-east-1",
})
```

`endpoint`, `region`, `prefix`, and `credentials` are optional. Without `credentials`, the AWS SDK credential chain is used. Give each runner credentials for its own store only. Use one bucket per environment.

## Check the bucket

Before you serve from a bucket, run the storage check against it:

```sh
bunx akter storage check --bucket my-akter-store --endpoint https://s3.example --region us-east-1
```

The check tests the bucket behaviors the store depends on and writes only under `check/<run>/`. It exits `0` when every probe passes. Credentials come from `AKTER_STORAGE_*` or `AWS_*` variables, never from arguments. See [`akter storage check`](../api/06-cli.md#akter-storage-check).

<Note>
A passing check is evidence for that provider, region, and endpoint only. A passing MinIO or filesystem run does not validate another provider. The [provider evidence page](https://github.com/Rika-Labs/akter/blob/main/docs/verification/store-providers.md) lists the runs on record.
</Note>

## Authenticate real users

The quickstart's fixed user is only for local development. In production, use `Auth.jwt` or `Auth.make` to authenticate a real credential, and serve behind TLS. See [Server API](../api/01-server-api.md#serve).

## Run the server

The [self-host recipe](../operations/self-host.md) builds a Bun or Node image and runs one runner against MinIO, any S3-compatible bucket, or a directory.

You can run several runners against one store. They need directly reachable addresses and mutual TLS, and each store gets its own peering identity. Your platform must also keep the readiness check, the drain on shutdown, and the build needed to recover an unclean tail; see [Deployment](../operations/01-deployment.md).

## Use Akter Cloud

[Akter Cloud](../cloud/get-started.md) builds and runs your app and gives each environment its own store. You do not provide a bucket or a `DATABASE_URL`.

## Upgrade from 0.1

0.2 starts with an empty store. There is no migration or adoption tool, so redeploy to a fresh 0.2 store. Later 0.2 redeployments reuse it. See the [upgrade notes](../operations/alpha-upgrades.md).
