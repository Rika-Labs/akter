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

Setting an existing name replaces its value. Unsetting a customer-managed variable removes it from future captures; neither action changes a running deployment.

## Import a dotenv file

```sh
bunx akter env import ./cloud.env --project PROJECT_ID --env production
```

The import creates new names and updates existing ones atomically. It does not remove names omitted from the file. Invalid input rejects the entire import. `-`, or no file argument, reads from stdin.

Use one `NAME=value` per line, optionally prefixed with `export`. Blank lines and lines starting with `#` are ignored. Single or double quotes surrounding a value are stripped. There is no shell expansion, escape decoding or multiline-value syntax, and duplicate names are rejected. An inline `#` is part of an unquoted value, not a comment.

## Naming and size rules

- Names begin with a letter or `_`, followed by letters, digits or `_`, with at most 256 characters.
- A value cannot contain a NUL character. The CLI accepts at most 64 KiB of UTF-8 input for one value and 1 MiB for a dotenv import.
- You cannot set or remove platform-managed names: `DATABASE_URL`, `DEPLOYMENT_ID`, `FLY_API_TOKEN`, or names beginning with `AKTER_`, `ASSERTION_` or `RUNNER_`.

The platform provisions database configuration for you. Do not paste a separate database URL into a managed variable. After changing your customer variables, [deploy again](/cloud/deploy).
