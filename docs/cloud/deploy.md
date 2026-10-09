---
title: "Deploy to Akter Cloud"
description: "Upload an Akter app and follow its managed build and rollout."
---

First [sign in with the CLI](/cloud/get-started) and [connect your Postgres](/cloud/database). Every environment on every plan needs its own customer-supplied `DATABASE_URL` before deployment; Akter Cloud provides hosted compute, not a database. The examples use `bunx akter`; with Node, use `npx akter` instead.

## Prepare your app

The uploaded directory must contain `src/app.ts`, default-exporting `App.make({ actors, layer })` from `@rikalabs/akter/runtime`. See the [quickstart](/quickstart) for defining actors and their layers. The Cloud host supplies the actor runtime and connects it to the environment's [database](/cloud/database); do not start a separate server from the entrypoint. You do not need a Dockerfile: the platform generates the build definition.

For the quickstart's `Counter` and `CounterLive`, the hosted entrypoint is:

```ts title="src/app.ts"
import { App } from "@rikalabs/akter/runtime"
import { Counter } from "./counter/contract.ts"
import { CounterLive } from "./counter/layer.ts"

export default App.make({ actors: [Counter], layer: CounterLive })
```

Include your package manifest, dependency lockfile and application source. Keep secrets outside the upload and configure them with [`akter env`](/cloud/environment-variables).

The CLI uses `.akterignore` if it exists, otherwise `.gitignore`. They are not combined. `.git` is always excluded; other files, including `.env` and `node_modules`, are not automatically excluded. For example, create this `.akterignore` before deploying:

```text
node_modules/
.env
.env.*
.git
```

An ignored `src/app.ts` makes deployment fail. The compressed source archive must be no larger than 64 MiB.

## Deploy

Replace `PROJECT_ID` with your project's ID. Save your direct Postgres URL in a secure file outside the upload directory, without quotes or a trailing newline. From your app directory, set it for the selected environment before the first deploy:

```sh
bunx akter env set DATABASE_URL --project PROJECT_ID --env production --file ../database-url.txt
bunx akter deploy --project PROJECT_ID --env production
```

Once `DATABASE_URL` is set, subsequent deploys capture it without setting it again. Migrations and runners use that connection. See [Connect your Postgres](/cloud/database#connection-requirements) for URL, TLS and migration permissions.

At deploy, Akter probes the database from Fly `iad` in Northern Virginia, near AWS `us-east-1`. A **p50 above 5 ms warns but still deploys**; latency is not a rejection threshold. Transaction-pooler URLs are refused because the runtime requires session semantics. A missing or unreachable database also prevents deployment. The probe [budgets runner capacity](/cloud/database#deploy-time-checks) from available Postgres connections, so a larger compute allowance cannot bypass your database's connection ceiling.

You may unset `DATABASE_URL`, but the next deploy is refused until it is set again. Akter does not provision a replacement database or delete the one you supplied.

The current directory is the upload context. To upload another directory:

```sh
bunx akter deploy --project PROJECT_ID --env production --context ./my-app
```

`--project` can be supplied through `AKTER_PROJECT`. `--env` defaults to `production`; accepted names are `production`, `staging` and `dev`. The selected environment must exist. These are your project's environments, not the infrastructure stage of a Cloud preview.

The CLI prints the upload size and deployment ID, then follows `build`, `migrate`, `start-runners` and `drain-previous`. A successful run ends with `Deployment … is live in …`. A failed deployment does not replace the live deployment.

The deployment label uses the context's Git HEAD and commit subject, marking an upload with uncommitted changes as dirty. `--commit` and `--message` override those labels; the uploaded files, not the label, are what gets built.

## If a rollout fails or takes too long

The CLI follows the rollout for 900 seconds by default. `--timeout` changes how long it waits, not how long the platform runs the deployment. A timeout exits with status 1 and leaves the rollout running; inspect that deployment in the console before retrying.

On a build failure, the CLI prints the last build-log lines and the recorded failure. A failed migration ends with `Deployment … failed at migrate: Image migration failed. The previous deployment, if any, is still serving.` The deployment's `migrate` step records only that the migration failed. Check the deployment in the console, correct the source or configuration, then deploy again. A rejected or expired login also exits with status 1; usage errors and an unreachable API exit with status 2. See the [CLI reference](/api/06-cli) for the complete command surface.

Each deployment captures its environment variables. Changing a variable affects the next deployment, not the running one. Rollback uses the selected deployment's captured values; it does not undo database changes, so keep schema changes compatible with both releases.
