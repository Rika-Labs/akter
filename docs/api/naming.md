---
title: "API naming"
description: "The public names in the Akter API, what each means, and how to name your own commands, results and broadcasts."
---

# API naming

Akter uses domain-driven names. A **command** is an imperative request an actor may refuse. A **broadcast** is a live value that is never stored. Akter stores no domain events, so it does not use the word "event" for a member.

## Framework names

| Name                       | Meaning                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `Actor.make`               | Declares state, commands, and optional members             |
| `Actor.command`            | A command: a synchronous request that edits a draft        |
| `Actor.view`               | A derived, synchronous read of durable state               |
| `Actor.broadcast`          | A live value published to watching clients, never stored   |
| `Actor.job`                | Effect I/O started by a command and journaled on the shard |
| `Job.retry`, `Job.timeout` | Policies piped onto a job                                  |
| `Actor.list`               | An unbounded list field in state                           |
| `X.toLayer`                | Binds one actor's handlers                                 |
| `X.client(id)`             | A scoped Effect handle                                     |
| `X.find`                   | A static, id-only query over scalar state                  |
| `Akter.serve`              | Serves one `/rpc` group                                    |
| `Store.s3`                 | A durable bucket store                                     |
| `Store.fileSystem`         | A local-directory store, used by `akter dev`               |
| `Story`                    | Tests handlers without the engine                          |
| `Simulation`               | Tests the engine end to end over a seeded bucket           |
| `akter storage check`      | Probes a bucket or directory                               |

## Name your members

- **Commands are imperative verbs:** `add`, `post`, `rename`, `close`. Name a command for what the caller asks for.
- **Job results are past-tense facts.** The internal command a job's `onSuccess` names is `succeeded<Job>` or `completed<Job>`, and the one its `onFailure` names is `failed<Job>`: a `generate` job reports to `succeededGenerate` and `failedGenerate`. A result says what happened and leaves the decision to its handler.
- **Broadcasts are past-tense facts too:** `receivedToken`, `joinedRoom`. A broadcast tells watchers what happened; it does not instruct them.
- **Jobs are imperative verbs:** `generate`, `sendReceipt`, `syncInventory`.
- **Actor names may be dotted** to group a domain: `Billing.Invoice`. A name is part of every instance's address, so renaming an actor moves its data; choose names you can keep.

## Removed spellings

The 0.2 spellings `Actor.action`, `actions`, `Actor.event`, `events`, `ctx.emit` and the `retry` and `timeout` options of `Actor.job` are removed in 0.3. The 0.1 spellings for client factories, job layers, self handles, SQL adapters, relational members, receipts, outboxes, relational queries, and the Promise client are removed too. None is kept as an alias.
