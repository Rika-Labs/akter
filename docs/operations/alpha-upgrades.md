---
title: "0.2 upgrade notes"
description: "Move 0.1 applications to fresh 0.2 stores without converting runtime records."
---

# 0.2 upgrade notes

0.2 starts empty. Keep 0.1 deployments and their backups isolated; redeploy using the 0.2 actor and store model instead of trying to convert their runtime records.

- Replace owned rows and relational queries with schema state, `Actor.list`, and id-only `X.find`.
- Replace Effect command handlers with synchronous actions; move I/O into jobs in the same `toLayer`.
- Replace old client factories with `X.client(id)` and `AkterClient.layer`.
- Replace database configuration with one store bucket per environment, or filesystem storage for local development.
- Replace SQL inspector and repair operations with separately granted audited actor, shard, log, snapshot, fork, and replay operations.

Defaulted fields and Schema transformations are the state-evolution mechanism. No migration CLI, adoption path, Promise facade, or generated Python/React client is carried forward. Read [upgrades](02-migrations.md) before a release handoff.
