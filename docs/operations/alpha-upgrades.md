---
title: "0.2 upgrade notes"
description: "Move a 0.1 application to a fresh 0.2 store."
---

# 0.2 upgrade notes

0.2 starts with an empty store. Keep your 0.1 deployments and backups separate, and redeploy with the 0.2 actor and store model. Do not try to convert 0.1 runtime records.

## What changes

| In 0.1                              | In 0.2                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Owned rows and relational queries   | Schema state, `Actor.list`, and id-only `X.find`                                          |
| Effect command handlers             | Synchronous commands, with I/O in jobs declared in the same `toLayer`                     |
| Client factories                    | `X.client(id)` and `AkterClient.layer`                                                    |
| Database configuration              | One store bucket per environment, or a directory for local development                    |
| SQL inspector and repair operations | Separately granted, audited operators for actors, shards, log, snapshot, fork, and replay |

State evolves through decoding defaults and Schema transformations. See [Upgrades and schema changes](./02-migrations.md) before you hand off a release.

There is no migration CLI and no adoption path. The Promise facade and the generated Python and React clients are not part of 0.2.
