# 04 — Durable execution

## Vision

The system should turn unreliable processes into reliable application behavior without pretending failures do not exist.

One actor turn commits, atomically where supported:

- business rows;
- the command receipt;
- durable events;
- timers;
- messages;
- activity and job intents.

After commit, delivery may be retried. Before commit, the transaction may disappear. After an external provider call, the outcome may be unknown.

## Required developer guarantees

- duplicate commands resolve to one retained logical operation;
- an old actor generation cannot write after losing authority;
- durable work survives process restart;
- retries preserve logical identity;
- unknown external outcomes remain visible;
- workflows replay recorded step results instead of repeating effects;
- recovery is inspectable rather than hidden behind a generic retry counter.

## The honest exactly-once promise

Durable Actors can provide exactly-once **local state transitions** under its retention and transaction contracts. Exactly-once external outcomes depend on the provider supporting idempotency, transactional handoff, or reliable reconciliation.
