---
title: "Deploy"
description: "Move from local filesystem storage to one durable bucket per environment."
---

# Deploy

The app contract and handlers from the [quickstart](../quickstart.md) do not change between local development and a bucket-backed runner. Replace `Store.fileSystem("./.data")` with `Store.s3({ bucket, endpoint?, region?, prefix? })`, give the runner scoped credentials, and use a real authentication provider.

Run `akter storage check --bucket BUCKET --endpoint https://S3-ENDPOINT` against the intended provider. Credentials come from environment or the SDK chain, not command arguments. Check the [provider matrix](https://github.com/Rika-Labs/akter/blob/main/docs/verification/store-providers.md); a passing MinIO run does not validate another provider.

The [self-host recipe](../operations/self-host.md) builds a Bun or Node runner on MinIO. Multiple runners require direct mTLS peer reachability and the store-scoped peering identity. Readiness, drain, matching-build recovery, and stopped-store wake-up are host responsibilities, not optional rollout details.

For hosted deployment, [Akter Cloud](../cloud/get-started.md) provisions one store bucket per environment. It does not require `DATABASE_URL`. Pricing, quotas, and provider rollout claims require E8 evidence and approval.

Upgrading from 0.1 requires a fresh 0.2 store; subsequent 0.2 redeployments reuse that store. There is no migration or adoption tool. [Upgrade notes](../operations/alpha-upgrades.md) explain the contract and release changes.
