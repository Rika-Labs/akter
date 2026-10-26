---
title: "API and protocol versioning"
description: "How actor schemas, the wire protocol, builds, and retained history change over time."
---

# API and protocol versioning

## Actor state

State is decoded from stored bytes using the current schema, and a new actor starts from the decoded value of `{}`. Adding a field with a decoding default, or an optional field, is compatible. Reshape a field with a Schema transformation. There is no migration hook and no `akter migrate` command. See [Upgrades and schema changes](../operations/02-migrations.md).

## Wire protocol

The `/rpc` group is generated from actor contracts. WebSocket JSON and HTTP NDJSON share the same tags and schemas. Command ids are retained for ten minutes, and retries use the same id while the client considers a call live.

## Builds and history

Every segment records the application bundle, framework version, JavaScript engine, and platform build. Replay requires a matching build unless an operator explicitly chooses current-build replay. Retained segments and checkpoints are history, not a second source of write authority.
