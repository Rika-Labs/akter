---
title: "API naming"
description: "Settled public names for the Akter 0.2 API."
---

# API naming

| 0.2 name              | Meaning                                       |
| --------------------- | --------------------------------------------- |
| `Actor.make`          | Declares state, actions, and optional members |
| `Actor.list`          | Unbounded list field in state                 |
| `X.toLayer`           | Binds one actor's handlers                    |
| `X.client(id)`        | Scoped Effect handle                          |
| `X.find`              | Static id-only scalar-state query             |
| `Akter.serve`         | Serves one `/rpc` group                       |
| `Store.s3`            | Durable bucket store                          |
| `Store.fileSystem`    | Local `akter dev` store                       |
| `akter storage check` | Bucket or directory protocol probe            |

The removed 0.1 client-factory, job-layer, self-handle, SQL adapter, relational member, receipt, outbox, relational-query, and Promise-client spellings are not compatibility aliases.
