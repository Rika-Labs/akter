---
title: "API and protocol versioning"
description: "How Akter 0.2 contracts, wire data, builds, and retained history evolve."
---

# API and protocol versioning

Actor state is decoded from `{}` using field decoding defaults. Adding a defaulted or optional field is compatible; reshape a field with a Schema transformation. There is no actor migration hook and no `akter migrate` command.

The `/rpc` group is generated from actor contracts. WebSocket JSON and HTTP NDJSON share tags and schemas. Command ids are retained for ten minutes, and retries use the same id while the client considers a call live.

Every segment records the application bundle, framework version, JavaScript engine and platform build. Replay requires a matching build unless an operator explicitly chooses current-build replay. Retained segments and checkpoints are history, not a second write authority.
