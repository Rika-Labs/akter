---
title: "API naming"
description: "The public names in the Akter 0.2 API and what each means."
---

# API naming

These are the settled public names.

| Name                  | Meaning                                       |
| --------------------- | --------------------------------------------- |
| `Actor.make`          | Declares state, actions, and optional members |
| `Actor.list`          | An unbounded list field in state              |
| `X.toLayer`           | Binds one actor's handlers                    |
| `X.client(id)`        | A scoped Effect handle                        |
| `X.find`              | A static, id-only query over scalar state     |
| `Akter.serve`         | Serves one `/rpc` group                       |
| `Store.s3`            | A durable bucket store                        |
| `Store.fileSystem`    | A local-directory store, used by `akter dev`  |
| `akter storage check` | Probes a bucket or directory                  |

The 0.1 spellings for client factories, job layers, self handles, SQL adapters, relational members, receipts, outboxes, relational queries, and the Promise client are removed. They are not kept as aliases.
