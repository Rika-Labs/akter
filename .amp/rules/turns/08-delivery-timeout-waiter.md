---
enabled: true
paths:
  - packages/durable-actors/src/runtime/**
  - packages/durable-actors/src/client/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: warning
threshold: 0.9
priority: 10
contextFiles:
  - docs/contracts/02-command-turns.md
  - docs/contracts/error-model.md
---

# Delivery timeout stops the waiter, not the work

`Delivery.timeout` bounds admission, receipt reads, and the caller's reply
wait only. A timeout or transport disconnect leaves an admitted turn running
to its own outcome; its receipt stays resolvable by the authorized original
caller within the retry horizon, and the turn may still commit.

Violations: racing the turn fiber or transaction against the delivery deadline;
interrupting or rolling back admitted work when the caller stops waiting;
reporting the command as failed rather than the wait as timed out; cancelling
queued mailbox work on disconnect.

Clean: `Timeout` is surfaced as a caller-side `ActorError` whose admitted turn
continues; a message already handed to the runtime keeps running.

Flag only a visible coupling between the caller's wait and the turn's
lifetime. Timing out before admission is not acceptance and needs no
preservation — do not flag it. Command execution timeouts inside the turn are
a separate mechanism; do not conflate them.
