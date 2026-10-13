---
title: "Get started with Akter Cloud"
description: "Connect the CLI and deploy a 0.2 app into an isolated environment store."
---

# Get started with Akter Cloud

Akter Cloud consumes published framework and CLI packages and runs managed runners. The 0.2 design gives each environment a store bucket; you do not provide `DATABASE_URL`. Hosted rollout, provider validation, prices, and quotas are E8 gates, not established by this framework guide.

## Prepare the application

Build an `App.make` export from actor contracts and their `toLayer` implementations. Use schema state with decoding defaults, synchronous actions, Effect jobs for I/O, and the single Effect client. Follow the [quickstart](../quickstart.md) locally before deploying.

Pin matching framework and CLI rewrite versions; the moving `rewrite` tag identifies candidates but is not a deployment lock. The [release guide](../operations/05-releasing.md#rewrite-canaries) describes that channel.

## Connect the CLI

```sh
bunx akter login
bunx akter whoami
bunx akter deploy --project PROJECT_ID --env production
```

Approve the browser device code only when it matches the login you initiated. `--api-url` selects a preview control plane; remote endpoints require HTTPS. The saved API and session are used by later commands. Keep the credential directory private and out of your source upload.

Configure other secrets through [environment variables](environment-variables.md); platform store credentials are injected separately. Read [storage](storage.md) for data custody and [deploy](deploy.md) for release handoff. `akter logout` removes the saved session but does not delete projects or data.
