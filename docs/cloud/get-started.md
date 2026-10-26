---
title: "Get started with Akter Cloud"
description: "Sign in, create a project, and deploy an Akter app from the CLI."
---

# Get started with Akter Cloud

Akter Cloud builds your app, runs it, and gives each environment its own private store. You do not provide a bucket or a `DATABASE_URL`. This page takes you from a local app to a deployment.

## Before you start

You need an app that works locally. Finish the [quickstart](../quickstart.md) first. Your app must default-export an `App.make(...)` value from `src/app.ts`, because that is the file Akter Cloud serves. Install the CLI at the same version as the framework:

```sh
bun add -d @rikalabs/akter-cli
```

With Node, use `npx akter` wherever this page says `bunx akter`.

## Create a project

Sign in to the console and create a project. The project's settings show its project ID. The CLI needs the ID; a project slug does not work in its place. To stop passing `--project` on every command, set `AKTER_PROJECT` to the ID.

## Sign in and deploy

```sh
bunx akter login
bunx akter whoami
bunx akter deploy --project PROJECT_ID --env production
```

`login` prints a URL and a code. Open the URL, confirm that the code matches the one in your terminal, and approve the sign-in. `whoami` shows who you are signed in as and which organizations you belong to. `deploy` uploads the app directory, builds it, and prints each step until the deployment is live.

If `deploy` stops with "Akter Cloud deployments are not open for this organization yet", your organization is not enabled yet. Nothing was created, and you can run the command again once it is.

## Next steps

- Add configuration and secrets with [environment variables](./environment-variables.md).
- Read how deployments work, and what happens when one fails, in [Deploy to Akter Cloud](./deploy.md).
- Read [Environment storage](./storage.md) to learn where your data lives.
- Watch your app's output with [runner logs](./logs.md).
- Compare plans and limits in [Pricing and limits](./pricing-and-limits.md).

`akter logout` removes the saved session. It does not delete projects or data.
