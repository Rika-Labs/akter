---
title: "The akter CLI"
sidebarTitle: "CLI"
description: "Reference for every akter command: local development, Akter Cloud, storage checks, and operator tools."
---

# The `akter` CLI

The `akter` command runs an app locally, deploys it to Akter Cloud, checks a bucket, and inspects durable state. Install `@rikalabs/akter-cli` at the same version as `@rikalabs/akter`, then run it with `bunx akter` or `npx akter`. It needs Bun 1.4.2 or later, or Node 24 or later.

`akter --help` and `akter <command> --help` list every flag. This page explains what the commands do and what they print.

| Group       | Commands                                                     |
| ----------- | ------------------------------------------------------------ |
| Local       | `dev`                                                        |
| Akter Cloud | `login`, `logout`, `whoami`, `deploy`, `env`, `keys`, `logs` |
| Storage     | `storage check`                                              |
| Operators   | `inspect`, `log`, `snapshot`, `fork`, `replay`, `retention`  |

## Local development

```sh
bunx akter dev --entry src/app.ts --dir .akter/store --port 8080
```

`dev` imports the entry module, which must default-export an `App.make(...)` app, and serves it on `127.0.0.1` with a filesystem store. The values above are the defaults.

| Flag             | Default                | Meaning                           |
| ---------------- | ---------------------- | --------------------------------- |
| `--entry`        | `src/app.ts`           | The app module                    |
| `--dir`          | `.akter/store`         | The store directory               |
| `--port`         | `8080`                 | The port to listen on             |
| `--devtools`     | off                    | Send telemetry to Effect DevTools |
| `--devtools-url` | `ws://localhost:34437` | Where DevTools listens            |

`dev` serves with `Auth.none`, so every caller is anonymous and still goes through the actor's access rules. An actor's default access rejects anonymous callers, so grant anonymous access deliberately while you test locally.

`dev` also serves `/metrics`. It enables the operator endpoint only when `AKTER_OPERATOR_TOKEN` is set. That token's grant covers `inspect`, `log.read`, `snapshot.read`, `outcomes.read`, `audit.read`, and `replay` for tenant `default`. It does not cover `fork`, `export`, `delete`, or `retention.set`.

## Akter Cloud commands

Every cloud command except `login` uses the session that `login` stored. Pass `--project` (or set `AKTER_PROJECT`) to commands that act on a project. `--env` is `production`, `staging`, or `dev`, and defaults to `production`.

The project ID is shown in the console under the project's settings. A slug does not work in its place.

### `akter login`

```sh
bunx akter login
```

`login` prints a verification URL and a code. Open the URL in a browser, check that the code matches, and approve the sign-in. The CLI waits for the approval, then stores the session.

`--api-url` selects the control plane. It defaults to `AKTER_API_URL`, then `https://api.akter.dev`. A control plane must use HTTPS, except on a loopback host such as `localhost`, where plain HTTP is allowed so a session token never crosses a network unencrypted.

The session lives in `credentials.json` inside the configuration directory, which is `AKTER_CONFIG_DIR` when set, otherwise `$XDG_CONFIG_HOME/akter` (default `~/.config/akter`). The file is created with owner-only permissions, and the CLI refuses to use it if other users can read it. Later commands send the token only to the control plane saved at login.

### `akter whoami`

Prints the signed-in email and control plane, then one line per organization with its slug, your role, and its ID.

### `akter logout`

Signs the session out at the control plane and deletes the stored credentials. The credentials are deleted even when the control plane cannot be reached, and the CLI says so; the session then ends when it expires. Logging out does not delete projects or data.

### `akter deploy`

```sh
bunx akter deploy --project PROJECT_ID --env production
```

`deploy` packs the app directory, uploads it, starts a deployment, and follows it until it is live.

| Flag        | Default                  | Meaning                                         |
| ----------- | ------------------------ | ----------------------------------------------- |
| `--project` | `AKTER_PROJECT`          | The project to deploy to                        |
| `--env`     | `production`             | The environment                                 |
| `--context` | current directory        | The app directory; it must contain `src/app.ts` |
| `--commit`  | the context's git `HEAD` | The commit SHA to label the deployment with     |
| `--message` | the commit's subject     | The deployment's message                        |
| `--timeout` | `900`                    | Seconds to follow the rollout                   |

The upload honors `.akterignore` if it exists, otherwise `.gitignore`, and always leaves out `.git`. A file your ignore file excludes is not uploaded, including `src/app.ts` if you exclude it by mistake. The compressed upload can be at most 64 MiB. `--commit` and `--message` only label the deployment; the platform builds what you uploaded.

`--timeout` limits how long the CLI waits, not how long the platform works. When it passes, the command exits with status 1 and the rollout continues on the control plane. The command prints the build log and each rollout step as they happen. If a deployment fails, it exits with status 1 and reports the step that failed. The previous deployment, if any, keeps serving. See [Deploy to Akter Cloud](../cloud/deploy.md).

### `akter env`

```sh
bunx akter env list --project PROJECT_ID --env production
bunx akter env set SERVICE_TOKEN --project PROJECT_ID --env production --file ./service-token.txt
printf '%s' "$SERVICE_TOKEN" | bunx akter env set SERVICE_TOKEN --project PROJECT_ID --env production
bunx akter env unset SERVICE_TOKEN --project PROJECT_ID --env production
bunx akter env import ./cloud.env --project PROJECT_ID --env production
```

- `list` prints variable names and update times. Values cannot be read back.
- `set` reads the value from `--file` or from piped stdin. It refuses to read from a terminal and never takes the value as an argument, so a secret stays out of your shell history. A value can be at most 64 KiB.
- `unset` removes a variable.
- `import` reads a dotenv file, or stdin when you give no file or `-`. The file can be at most 1 MiB. It creates or updates the names in the file, leaves other names alone, and either applies everything or nothing. It prints how many variables it created and updated.

Changes apply on the next deployment. See [Environment variables](../cloud/environment-variables.md) for names, limits, and reserved variables.

### `akter keys`

```sh
bunx akter keys create "web client" --project PROJECT_ID --env production --tenant default
bunx akter keys list --project PROJECT_ID --env production
bunx akter keys revoke KEY_ID --project PROJECT_ID --env production
```

`keys` manages the keys that your deployed app accepts as bearer tokens. They are not control-plane credentials.

- `create` prints the key's secret on stdout, once, and a confirmation on stderr. Save the secret then; it cannot be read again. `--tenant` names the application tenant and defaults to `default`.
- `list` prints each key's ID, name, tenant, creation time, and `active` or its revocation time. Revoked keys stay in the list. It never prints a secret.
- `revoke` revokes a key by ID.

See [Environment API keys](./09-environment-api-keys.md) for the HTTP routes.

### `akter logs`

```sh
bunx akter logs --project PROJECT_ID --env production --follow
```

`logs` reads recent output from your app's runners. See [Runner logs](../cloud/logs.md) for the flags, limits, and output format.

## `akter storage check`

```sh
bunx akter storage check --directory ./.data
bunx akter storage check --bucket BUCKET --endpoint https://S3-ENDPOINT --region REGION --json
```

`storage check` runs the storage probes against one bucket or one directory and prints each verdict with its measured numbers. Use it before you serve from a bucket. Name a bucket with `--bucket` or `AKTER_STORAGE_BUCKET`, or a directory with `--directory`, not both.

| Flag          | Default | Meaning                                                                  |
| ------------- | ------- | ------------------------------------------------------------------------ |
| `--bucket`    |         | The bucket to check                                                      |
| `--endpoint`  |         | The S3 endpoint, for a provider other than AWS                           |
| `--region`    |         | The bucket's region                                                      |
| `--prefix`    |         | A key prefix inside the bucket                                           |
| `--directory` |         | Check a directory instead of a bucket                                    |
| `--writers`   | `16`    | Concurrent writers in each race round                                    |
| `--rounds`    | `10`    | Rounds of each race and of the listing probe                             |
| `--writes`    | `10`    | Back-to-back writes to one key in the write-rate probe                   |
| `--settle-ms` | `2000`  | Milliseconds between the two identical writes of the last-modified probe |
| `--json`      | off     | Print one JSON document                                                  |

Credentials come only from the environment, never from flags or the endpoint URL. The CLI reads `AKTER_STORAGE_ACCESS_KEY_ID`, `AKTER_STORAGE_SECRET_ACCESS_KEY`, and `AKTER_STORAGE_SESSION_TOKEN`, then falls back to the matching `AWS_*` variables. Set the access key ID and the secret together, or neither, to use the AWS credential chain. The target settings are `AKTER_STORAGE_BUCKET`, `AKTER_STORAGE_ENDPOINT` (or `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`), `AKTER_STORAGE_REGION` (or `AWS_REGION`, `AWS_DEFAULT_REGION`), and `AKTER_STORAGE_PREFIX`. The CLI removes secrets from any provider message before printing it.

The seven probes are:

1. Conditional create race: concurrent writes with `If-None-Match` produce exactly one winner.
2. Compare-and-swap race: concurrent writes with `If-Match` produce at most one winner.
3. List after write: a created key is listed and a deleted key is not.
4. Ordered listing: keys list in byte order and page correctly with a limit and a start-after key.
5. Overwrite refreshes last-modified: rewriting identical bytes moves the timestamp forward.
6. Per-key write rate: back-to-back writes to one key succeed or are throttled, and never fail another way.
7. Batch delete: one multi-key delete removes every key.

The check writes under `check/<run>/` and removes what it wrote. It does not open a store or write any store or audit record. On a filesystem target, small deletion markers or empty directories can remain.

Text output ends with `Passed: all 7 probes.` or the names of the probes that failed. With `--json`, the output holds the CLI version, a timestamp, the target (without credentials), the overall verdict, and each probe's details.

A passing check is evidence about that provider, region, and endpoint only. See the [provider matrix](https://github.com/Rika-Labs/akter/blob/main/docs/verification/store-providers.md) for the runs on record.

## Operator commands

Operator commands read and change durable state through a separate credential, not an application credential.

| Form                                                | Capability      | Result                                                   |
| --------------------------------------------------- | --------------- | -------------------------------------------------------- |
| `akter inspect actor <Type> <id>`                   | `inspect`       | An actor's durable state, lists, and pending work        |
| `akter inspect shard <n>`                           | `inspect`       | A shard's durable head, checkpoints, and owner           |
| `akter log tail <shard> [--from offset] [--follow]` | `log.read`      | Retained segment entries, optionally followed            |
| `akter log export <shard> [--from offset]`          | `log.read`      | Retained entries as NDJSON                               |
| `akter snapshot <shard>`                            | `snapshot.read` | A shard's checkpoint, manifest, and page data            |
| `akter replay <shard> [--current]`                  | `replay`        | Replays a shard; `--current` opts into the current build |
| `akter retention <duration>`                        | `retention.set` | Sets store-wide history retention                        |
| `akter fork <Type> <id> ...`                        | `fork`          | Copies an actor's retained history to a new actor        |

Reading stored success and failure values also needs `outcomes.read`. `export`, `delete`, and `audit.read` are separate grants as well.

Except for `fork`, these commands send a `POST` to the server's `/operator` endpoint, which is separate from `/rpc`. The server turns it on when you pass `operatorAuth` to `Akter.serve`; see [Server API](./01-server-api.md#serve) and [Observability](../operations/03-observability.md).

| Flag          | Default                 | Meaning                                                |
| ------------- | ----------------------- | ------------------------------------------------------ |
| `--url`       | `http://127.0.0.1:8080` | The server                                             |
| `--tenant`    | `default`               | The tenant to act in                                   |
| `--reason`    | `operator inspection`   | The reason recorded with the request                   |
| `--token-env` | `AKTER_OPERATOR_TOKEN`  | The environment variable that holds the operator token |

The URL must use HTTPS, or HTTP on `localhost`, `127.0.0.1`, or `[::1]`, and must not carry credentials or a query string. If the token variable is empty, the command stops before it sends anything. A refused or unreachable request exits with status 1. For an actor whose ID is not a string, use `inspect actor --id-json` and pass the ID as JSON.

`akter retention` changes how long the whole store keeps history. Pass a duration such as `"30 days"`:

```sh
akter retention "30 days" --url https://runner.example --reason "paid plan"
```

The duration must be from 1 through 365 days. The command has no `--tenant` flag; the token's grant needs `retention.set` for every tenant. Widening retention does not restore history that was already trimmed. See [History retention](../operations/retention.md).

`fork` does not call a server. It loads your app module, authorizes with the token in `--token-env`, and works directly on a directory (`--directory`) or a bucket (`--bucket`, `--prefix`, `--endpoint`). Choose where to fork from with `--at`, `--before`, or `--offset` together with `--index`. See [Forks](./forks.md) for every flag.

## Exit statuses

| Status | Meaning                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0      | The command succeeded, or it printed help or the version                                                                           |
| 1      | A server refused the request (including an expired session), a deployment failed or timed out, or a storage probe failed           |
| 2      | Bad arguments, missing or exposed credentials, an app module that cannot load, or an unreachable control plane or storage endpoint |
