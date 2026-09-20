# 02 — The product model

## Vision

An actor is a durable application boundary around an identity and its behavior.

An actor has:

- an address;
- a command mailbox;
- authority over defined business rows;
- short serialized command turns;
- durable receipts and events;
- timers and outgoing work;
- optional realtime connections and subscriptions;
- an activation that can be created, stopped, and rebuilt.

The actor is not a private database. It is not an always-running process. It is not an arbitrary JavaScript fiber checkpoint.

## The developer mental model

```text
address → command → transaction → committed facts → delivery / observation
```

An actor may sleep between turns. Its identity, business facts, receipts, events, and future work remain durable.

## The authority model

Actors own mutation, not visibility.

Authorized application code, dashboards, and queries may observe relational state. Actor commands are the normal path for changing actor-owned business facts. A foreign actor cannot silently mutate those facts through ordinary SQL.

## One context

Application code starts with one context and uses capabilities from it:

```ts
const ctx = yield * Context

ctx.database
ctx.blobs
ctx.emit
ctx.timers
ctx.activities
ctx.workflows
ctx.realtime
```

The available authority changes by execution phase. One name does not mean every phase can perform every operation.
