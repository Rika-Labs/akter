# 07 — Deployment and ownership

## Vision

Durable Actors should run where the customer needs it, using the same programming model and correctness contracts.

Supported deployment shapes should include:

- local development;
- tests against disposable databases;
- self-hosted Postgres;
- our managed cloud;
- managed private deployments;
- customer-controlled infrastructure.

Self-hosting must not require our hosted control plane. The basic system must be operable with standard database, container, backup, and observability tools.

## One runtime model

Local, self-hosted, and managed deployments may differ in topology and operations, but not in the meaning of commands, ownership, receipts, events, recovery, or client protocols.

## Operational honesty

The system must expose:

- actor health and generations;
- queue age and depth;
- receipt and event retention;
- work and external-effect outcomes;
- database saturation;
- live-query lag and resyncs;
- transfer state;
- gateway connections;
- restore and reconciliation status.

If a customer cannot understand what happened after a failure, the system is not finished.
