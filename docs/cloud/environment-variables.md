---
title: "Environment variables"
description: "Set write-only configuration and secrets for a project environment."
---

# Environment variables

Environment variables are how your deployed app reads configuration and secrets. They belong to one environment of one project, so `production` and `staging` can hold different values.

Values are encrypted before they are stored, and they are write-only. Listing returns each variable's name and when it last changed, never a value, a masked value, or a hash. Keep your own copy of any value you will need again.

A change applies to the next deployment. A running deployment keeps the values it started with, so deploy again after you change a variable.

## Manage variables

```sh
bunx akter env list --project PROJECT_ID --env production
bunx akter env set SERVICE_TOKEN --project PROJECT_ID --env production --file ./service-token.txt
bunx akter env unset SERVICE_TOKEN --project PROJECT_ID --env production
bunx akter env import ./cloud.env --project PROJECT_ID --env production
```

`set` reads the value from `--file` or from piped stdin, exactly as written. It never accepts a value as an argument, so a secret stays out of your shell history and process list. Keep these files outside the directory you deploy.

`import` reads a dotenv file, or stdin when you give no file. It creates the names in the file and updates the ones that already exist. It leaves every other variable alone, and it applies the whole file or none of it. The command prints how many variables it created and updated.

The dotenv format is strict. Each line is blank, a `#` comment, or `NAME=value`, optionally starting with `export`. A value can be wrapped in matching single or double quotes. Import rejects a value that spans lines, a name that appears twice, a line it cannot read, and a value that contains a NUL character. It does not expand `$VARIABLE` references.

You need write access to the project to set, unset, or import variables.

## Names and limits

| Limit       | Value                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| Name        | Letters, digits, and underscores, not starting with a digit; at most 256 characters |
| Value       | At most 64 KiB                                                                      |
| Dotenv file | At most 1 MiB                                                                       |

These are input limits for one request. They are not plan allowances.

## Reserved names

Akter Cloud refuses a name that it manages. You cannot set or remove:

- names that start with `AKTER_`, `ASSERTION_`, or `RUNNER_`
- `DEPLOYMENT_ID`
- `FLY_API_TOKEN`

The platform sets the `AKTER_STORAGE_*` variables your runners use to reach their [store](./storage.md). They are not customer variables and never appear in `akter env list`.

`DATABASE_URL` is an ordinary variable with no meaning to the platform. Akter does not need a database. If one of your jobs talks to a database of its own, that connection is yours to configure and operate.
