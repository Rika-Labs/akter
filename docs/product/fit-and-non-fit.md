---
title: "Product fit and non-fit"
description: "Where deterministic actors and journaled jobs help, and where another tool fits better."
---

# Product fit and non-fit

Akter fits addressable stateful workloads with short deterministic actions, live durable reads, and external work that can be journaled as jobs: rooms, orders, agents, and devices.

It is a conditional fit for high-frequency collaboration because durable latency includes the store PUT, and for hosted multi-tenancy because isolation requires hosted evidence beyond a local actor test. Page-backed unlimited data, GC, forks, and production-provider throughput depend on their milestone gates.

It is a poor fit for arbitrary SQL joins, cross-shard atomic transactions, durable event-feed replay, hostile-code sandboxing, or external exactly-once I/O without provider idempotency. Use a dedicated database, stream log, or workflow product when those are the primary requirement.
