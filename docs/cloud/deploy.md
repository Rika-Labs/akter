---
title: "Deploy to Akter Cloud"
description: "Upload an app, follow the rollout, and understand what happens when a deployment fails."
---

# Deploy to Akter Cloud

`akter deploy` uploads your app directory, builds it on Akter Cloud, and rolls it out to one environment.

```sh
bunx akter deploy --project PROJECT_ID --env production --context ./my-app
```

`--project` can come from `AKTER_PROJECT`. `--env` is `production` (the default), `staging`, or `dev`. `--context` is the app directory and defaults to the current directory. See the [CLI reference](../api/06-cli.md#akter-deploy) for every flag.

## What gets uploaded

The CLI packs the context directory into one compressed archive and uploads it. The archive must contain `src/app.ts`, and it can be at most 64 MiB. The upload follows your `.akterignore` file, or your `.gitignore` when there is no `.akterignore`, and never includes `.git`.

The deployment is built from what you uploaded, not from your working tree later. `--commit` and `--message` only label it in the console. Keep secrets out of the context and put them in [environment variables](./environment-variables.md).

## What happens next

1. The CLI uploads the archive and starts a deployment.
2. The platform builds your app. The CLI prints the build log as it grows.
3. The platform rolls the build out and starts it. The CLI prints each rollout step as it starts and ends.
4. The first deployment to an environment also uses that environment's [store](./storage.md); later deployments reuse it.
5. The CLI prints `Deployment ... is live` and exits.

Your actors' state lives in the store, not in the runner, so a new deployment continues from the state the previous one wrote. See [Deployment](../operations/01-deployment.md) for how a store changes hands between runners.

## If a deployment fails or is slow

The CLI follows a rollout for 900 seconds. Use `--timeout` to change that. The timeout limits only how long the CLI waits. A rollout that is still running continues on the control plane, so check its status in the console before you deploy again.

If a deployment fails, the CLI exits with status 1 and prints the step that failed. When the build failed, it also prints the last 20 lines of the build log. The previous deployment, if there is one, keeps serving.

Changes to environment variables take effect on the next deployment. A new deployment is a new version of your code and configuration; it does not restore an earlier copy of your actors' data. Read [Deployment](../operations/01-deployment.md) and [upgrade notes](../operations/alpha-upgrades.md) before you move an app from 0.1.

Use [runner logs](./logs.md) to see what your app printed after it started.
