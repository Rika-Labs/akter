---
title: "Environment variables"
description: "Manage write-only customer configuration separately from platform-owned store credentials."
---

# Environment variables

Customer values are encrypted and write-only: listing returns names and update metadata, not values. Keep a secure independent copy. Variables belong to a project/environment and changes apply on the next deployment, not a running release.

```sh
bunx akter env list --project PROJECT_ID --env production
bunx akter env set SERVICE_TOKEN --project PROJECT_ID --env production --file /secure/service-token.txt
bunx akter env unset SERVICE_TOKEN --project PROJECT_ID --env production
bunx akter env import /secure/cloud.env --project PROJECT_ID --env production
```

`set` reads file contents verbatim or stdin; it never accepts a secret as a positional value. Dotenv import updates supplied names atomically and does not remove omitted names. It does not expand shell expressions or decode multiline values; duplicate names reject the import. Keep source files outside the deployment context.

Names use letters, digits, and underscores with a letter or underscore first. The current public CLI input limits are 256 characters per name, 64 KiB per value, and 1 MiB per dotenv import; these are input bounds, not hosted plan quotas. NUL is refused.

## Reserved platform configuration

Names beginning with `AKTER_`, `ASSERTION_`, or `RUNNER_`, plus platform identity/provider names, are reserved. The 0.2 platform injects the store id, endpoint, bucket, temporary credentials, and refresh configuration. These values are not captured customer secrets and are not listed or editable.

`DATABASE_URL` is not required by Akter 0.2. If an application's own job uses an unrelated database, that is application configuration and not framework authority or a hosted storage substitute. See [environment storage](./storage.md).
