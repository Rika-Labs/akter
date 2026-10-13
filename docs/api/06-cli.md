---
title: "The akter CLI"
sidebarTitle: "CLI"
description: "Cloud client commands, storage checks, local development, and audited 0.2 operations."
---

# The `akter` CLI

Install `@rikalabs/akter-cli` at the same pinned 0.2 rewrite version as the framework, then use `bunx akter` or `npx akter`. Bun 1.4.2+ and Node 24+ are the runtime floors. Every command uses Effect's `effect/cli`; `akter --help` and `<command> --help` are the executable flag reference.

## Current command groups

This checkout implements cloud `login`, `logout`, `whoami`, `deploy`, `env`, `keys`, `logs`, `storage check`, filesystem-backed `dev`, and the audited operator forms below. There is no `migrate`, `adopt`, fleet, SQL inspector, receipt, or dead-letter repair command in 0.2.

## Operator commands

| Form                                                | Separate capability | Result                                                          |
| --------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| `akter inspect actor <Type> <id>`                   | `inspect`           | Durable actor state, lists, and pending work; outcome tags only |
| `akter inspect shard <n>`                           | `inspect`           | Durable head, checkpoints, and owner                            |
| `akter log tail <shard> [--from offset] [--follow]` | `log.read`          | Retained segment entries, optionally followed                   |
| `akter log export <shard> [--from offset]`          | `log.read`          | Retained entries as NDJSON                                      |
| `akter snapshot <shard>`                            | `snapshot.read`     | Checkpoint, manifest, and page data                             |
| `akter fork <Type> <id> --at <version>`             | `fork`              | Target only: E6 retained-history branch, not yet merged         |
| `akter replay <shard> [--current]`                  | `replay`            | Replay a refused shard; `--current` is explicit opt-in          |

Stored success/failure values require `outcomes.read` independently of `inspect`; `export`, `delete`, and `audit.read` also have distinct grants in the operator target. Operator requests use separate `POST /operator`, never `/rpc`. The server composes `Akter.serve({ app, auth, operatorAuth?, prometheus? })`; `OperatorAuth.tokens([{ token: Redacted.make(...), grant: { operator, capabilities } }])` maps bearer tokens to grants. The CLI defaults to `http://127.0.0.1:8080`, tenant `default`, and `AKTER_OPERATOR_TOKEN`; `--url`, `--tenant`, `--reason`, and `--token-env` override those values. Application credentials and `System` callers never become operator grants. Capabilities scope tenant, actor type/id, and optionally command id.

Reads write a create-once audit record before answering. Mutations include `Audit` in the same segment as their effect; a crash leaves both or neither. Scope denials are audited. No operation may return data when its required audit cannot be written. [ADR 0137](../decisions/0137-inspection-audited-operations-telemetry.md) defines this target; [runbooks](../operations/runbooks.md) describe safe recovery.

## Local development

`akter dev --entry src/app.ts --dir .akter/store --port 8080` loads a default-exported `App.make(...)` over loopback HTTP. Those entry, directory, and port values are the defaults. `--devtools` enables the telemetry connection and `--devtools-url ws://localhost:34437` selects its default URL. The operator endpoint is disabled unless `AKTER_OPERATOR_TOKEN` is provided. Its local grant allows inspect, log, snapshot, outcomes, audit, and replay for tenant `default`, not fork/delete/export. DevTools is a telemetry connection, not an unaudited inspector.

Local `dev` uses `Auth.none`, so application calls are anonymous and still pass through actor access. An actor's default access rejects them; opt into anonymous access deliberately for local testing or use the authenticated server example in the quickstart.

## Telemetry

Import `Telemetry` from `@rikalabs/akter/server` and compose `Telemetry.layer({ otlp: { baseUrl, headers? }, devtools: { url? } })` for traces and metrics. `Telemetry.prometheus()` returns a Prometheus exposition body; `Akter.serve({ prometheus: true, ... })` serves it at `/metrics`. Akter has no OTLP logs exporter; payloads and credentials must not be sent to telemetry.

## `akter storage check`

```sh
bunx akter storage check --directory ./.data
bunx akter storage check --bucket BUCKET --endpoint https://S3-ENDPOINT --region REGION --json
```

Choose a directory or bucket, not both. Flags are `--bucket`, `--endpoint`, `--region`, `--prefix`, `--directory`, `--writers`, `--rounds`, `--writes`, `--settle-ms`, and `--json`. Defaults are 16 race writers, 10 rounds, 10 writes, and 2,000 ms settle time. The settle time must exceed the provider timestamp resolution.

Credentials are read from `AKTER_STORAGE_ACCESS_KEY_ID`, `AKTER_STORAGE_SECRET_ACCESS_KEY`, and `AKTER_STORAGE_SESSION_TOKEN`, falling back to the corresponding `AWS_*` variables or the SDK credential chain. Target configuration uses `AKTER_STORAGE_BUCKET`, `AKTER_STORAGE_ENDPOINT`, `AKTER_STORAGE_REGION`, and `AKTER_STORAGE_PREFIX`; AWS endpoint and region variables are also accepted. Do not put credentials in an endpoint URL or command argument.

The seven probes cover conditional-create races, CAS races, create/delete listing visibility, ordered paginated listing, per-key write rate, and overwrite last-modified refresh. It opens no store, creates no `meta/store` or audit record, and writes only under its temporary `check/<run>/` prefix. It removes probe objects; filesystem CAS tombstones and empty directories may remain to prevent stale ETags reviving deleted objects.

Text output prints each verdict and measured values. JSON includes CLI version, timestamp, sanitized target, overall verdict, and probe details. Exit 0 means all passed, 1 means a probe failed, and 2 means usage or reachability prevented the check. Passing is evidence for the named provider and configuration only; save the report in the [provider matrix](../verification/store-providers.md) before making a support claim.

## Cloud commands

```sh
bunx akter login
bunx akter whoami
bunx akter deploy --project PROJECT_ID --env production
bunx akter logs --project PROJECT_ID --env production --follow
bunx akter logout
```

`login --api-url` selects the control plane, defaulting to `AKTER_API_URL` then `https://api.akter.dev`. Remote APIs require HTTPS; loopback may use HTTP. Login prints a browser device page and code, then stores the approved session securely. Subsequent commands use that saved API, not a newly changed environment URL. `AKTER_CONFIG_DIR` overrides the platform configuration directory.

`deploy` uploads the current context, or `--context`, and follows the deployment. `--project` can come from `AKTER_PROJECT`; `--env` defaults to `production`, with `staging` and `dev` also accepted. `--timeout` bounds the CLI wait, not platform execution. Pin framework and CLI versions together. The 0.2 hosted target provisions an environment bucket; no `DATABASE_URL` is required.

## `akter env`

```sh
bunx akter env list --project PROJECT_ID --env production
bunx akter env set SERVICE_TOKEN --project PROJECT_ID --env production --file /secure/token.txt
bunx akter env unset SERVICE_TOKEN --project PROJECT_ID --env production
bunx akter env import /secure/cloud.env --project PROJECT_ID --env production
```

Values are file/stdin-only and cannot be read back. Changes apply on the next deployment. Platform storage credentials are reserved and never customer variables. See [environment variables](../cloud/environment-variables.md).

## `akter keys`

`keys` manages environment application keys and endpoint discovery. Those keys call the app, not the control plane or operator API. See [environment API keys](09-environment-api-keys.md) for wire models, one-time secret exposure, and scope.

## Exit statuses

| Status | Meaning                                                                                     |
| ------ | ------------------------------------------------------------------------------------------- |
| 0      | Success or help/version output                                                              |
| 1      | An executed operation was refused, a deployment failed/timed out, or a storage probe failed |
| 2      | Usage, missing credentials, module loading, or reachability prevented execution             |

Cloud pricing, quotas, and 0.2 hosting rollout support remain E8 responsibilities; CLI help or published schemas do not establish them.
