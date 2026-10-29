---
title: "Product fit and non-fit"
description: "Where Akter's durable actors fit, and where another tool is the better choice."
---

# Product fit and non-fit

Akter fits workloads made of many independent, addressable things that keep state: rooms, orders, agents, and devices. This page helps you decide whether your workload is one of them.

## Good fit

- State belongs to one entity with an id, and one command changes one actor.
- Commands are short and deterministic, and I/O can run as journaled jobs.
- Clients need live reads of durable state.

## Think twice

| Case                         | Why                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| High-frequency collaboration | A reply waits for its segment to be written to the store, so every durable command includes a store write. |
| Hosted multi-tenancy         | `Akter.serve` serves only the `default` tenant.                                                            |

## Poor fit

| Need                                  | Use instead                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Ad hoc queries and joins              | A relational database. `X.find` returns ids only, filtered on top-level scalar fields. |
| Atomic transactions across actors     | A database. A send to another actor is fire-and-forget.                                |
| Replayable event feeds                | A stream log. Broadcasts are live and not stored.                                      |
| Exactly-once effects in other systems | Provider idempotency keys. A job step can reach its provider more than once.           |

Akter's [comparison](../guides/comparison.md) covers related actor and workflow products.
