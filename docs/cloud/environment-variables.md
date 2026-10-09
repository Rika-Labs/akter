---
title: "Environment variables"
description: "Manage encrypted, write-only configuration for each project environment."
---

Akter Cloud stores customer environment values encrypted. You can list names and update times, but cannot read values back through the console or API. Keep an independent secure copy of secrets you may need again.

Variables belong to a project and environment. Changes take effect on the **next deployment**. The examples use `production` explicitly; without `--env`, the CLI also defaults to `production`. Replace `PROJECT_ID` with your project ID. With Node, substitute `npx akter` for `bunx akter`.

## List, set and unset

```sh
bunx akter env list --project PROJECT_ID --env production
bunx akter env set SERVICE_TOKEN --project PROJECT_ID --env production --file ./service-token.txt
bunx akter env unset SERVICE_TOKEN --project PROJECT_ID --env production
```

`set` reads the file's contents verbatim, including a trailing newline. Create the file securely outside your deployment context. Values are never accepted as command arguments. You can instead pipe input to `set`; an interactive terminal without `--file` is refused so a secret is not echoed while you type it.

Setting an existing name replaces its value. Unsetting a customer variable removes it from future captures; neither action changes a running deployment.

## Import a dotenv file

```sh
bunx akter env import ./cloud.env --project PROJECT_ID --env production
```

The import creates new names and updates existing ones atomically. It does not remove names omitted from the file. Invalid input rejects the entire import. `-`, or no file argument, reads from stdin.

Use one `NAME=value` per line, optionally prefixed with `export`. Blank lines and lines starting with `#` are ignored. Single or double quotes surrounding a value are stripped. There is no shell expansion, escape decoding or multiline-value syntax, and duplicate names are rejected. An inline `#` is part of an unquoted value, not a comment.

## Naming and size rules

- Names begin with a letter or `_`, followed by letters, digits or `_`, with at most 256 characters.
- A value cannot contain a NUL character. The CLI accepts at most 64 KiB of UTF-8 input for one value and 1 MiB for a dotenv import.
- You cannot set or remove platform-managed names such as `DEPLOYMENT_ID` and `FLY_API_TOKEN`, or names beginning with `AKTER_`, `ASSERTION_` or `RUNNER_`. `DATABASE_URL` is a customer variable on every plan.

## Database connection

Every environment on every plan requires **your own `DATABASE_URL`** before deploying. Akter does not provision a database or supply this value. `akter env list` lists its name and update metadata only. Like every secret, the URL cannot be read back.

Use a direct, non-pooled Postgres URL. Transaction-pooler URLs are refused because the runtime requires session semantics. The URL must use `postgres://` or `postgresql://`, include a host, omit fragments and raw whitespace or control characters, and contain exactly one `sslmode` of `require`, `verify-ca` or `verify-full`. See [Connect your Postgres](/cloud/database#connection-requirements) for TLS and migration permissions. Invalid input is refused without echoing the URL.

```sh
bunx akter env set DATABASE_URL --project PROJECT_ID --env production --file ../database-url.txt
```

Store only the URL in that secure file, without quotes or a trailing newline, and keep it outside the deployment directory. Values remain file/stdin input, not positional command arguments.

Unsetting `DATABASE_URL` is allowed on every plan. It leaves a running deployment on its captured connection and never touches your database, but **the next deploy is refused until you set it again**. There is no fallback database or plan-based exception. Changing the URL does not copy data; after setting it, [deploy again](/cloud/deploy) to use the new connection.

To remove the connection from future deployments:

```sh
bunx akter env unset DATABASE_URL --project PROJECT_ID --env production
```
