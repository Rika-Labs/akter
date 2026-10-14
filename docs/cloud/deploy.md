---
title: "Deploy to Akter Cloud"
description: "Upload a 0.2 application and understand provisioning and release handoff targets."
---

# Deploy to Akter Cloud

Export an `App.make({ actors, layer })` app and pin matching published 0.2 framework and CLI versions. Contracts use schema state and synchronous actions; I/O runs in jobs. Hosted rollout behavior is an E8 target until its own evidence lands.

```sh
bunx akter deploy --project PROJECT_ID --env production --context ./my-app
```

`--project` can come from `AKTER_PROJECT`. `--env` defaults to `production`; `staging` and `dev` are also accepted. The context is the uploaded source, not a reference to your local worktree. `--commit` and `--message` are labels, not authority over what gets built. Keep secrets outside the context.

## 0.2 rollout

The first deployment provisions an environment store and validates it with `akter storage check`. Later deployments reuse that store. There is no customer database connection or framework migration phase. Platform-owned temporary storage credentials are injected into runners, never builders or captured customer variables.

A new release starts in standby. The old release becomes unready, drains to checkpoints and `Released` tails, and reports offsets and `nextDue`. An unclean tail needs its matching retained build; current-build replay requires separate audited operator authority. The host must arrange wake-up for stopped stores.

## Failed or slow rollout

The CLI follows for 900 seconds by default; `--timeout` changes the wait, not the platform's execution lifetime. A timeout does not cancel a rollout. Inspect the existing deployment before retrying. Failed provisioning, refused recovery, and failed builds must remain visible and leave the previous live release intact.

Variable changes apply to the next capture. Rollback selects code/configuration, not an earlier copy of actor data. See [storage](./storage.md), [upgrade notes](../operations/alpha-upgrades.md), and [runner logs](./logs.md). No prices, quotas, or production-provider support are promised by this procedure.
