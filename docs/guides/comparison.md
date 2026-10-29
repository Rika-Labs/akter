---
title: "Comparison"
description: "How Akter's durable command model differs from Durable Objects, Rivet, Restate, and Temporal."
---

# Comparison

Choose a tool by the authority and recovery boundary your application needs, not by whether its API looks like actors. This page describes Akter's choices so you can compare them with the product you are evaluating. Check each product's own documentation for its guarantees.

## What Akter chooses

| Choice              | In Akter                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Where state lives   | One bucket per environment. The create-once segment in that bucket is the publication boundary. |
| What a command is   | A short, synchronous, deterministic function. Failure discards everything it staged.            |
| Where I/O runs      | In jobs with journaled steps.                                                                   |
| How clients connect | One Effect client over a single `/rpc` endpoint.                                                |
| Where it runs       | A Bun or Node process with an S3-compatible bucket, or Akter Cloud.                             |

## Cloudflare Durable Objects

Durable Objects tie per-object coordination and storage to Cloudflare's platform. Choose them when that integration is your main requirement. Akter does not provide Cloudflare's global placement.

## Rivet Actors

Both expose addressable stateful instances. In Akter, a reply waits for the durable segment rather than for a periodic save. Compare the persistence and retry policy of the deployment you are evaluating instead of inferring them from the actor vocabulary.

## Restate and Temporal

These are durable execution systems, a good fit when a long-running workflow is the main abstraction. Akter keeps commands short and moves I/O into jobs with journaled steps. It is not a workflow product: it has no compensation and no workflow-run handle.

## Use another tool when

- You need joins or global transactions: use a relational database.
- You need retained subscriber history: use a stream log. Akter broadcasts are live only.
- You need exactly-once effects in another system: use that system's idempotency keys.
