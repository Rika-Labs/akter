---
enabled: true
paths:
  - packages/durable-actors/src/runtime/effects/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: warning
threshold: 0.9
priority: 10
contextFiles:
  - docs/contracts/08-background-work.md
  - docs/contracts/09-recovery.md
---

# Ambiguous provider outcomes stay ambiguous

When a provider call's outcome is unknown — success followed by a lost
acknowledgment, a timeout after submission — the effect record must preserve
that ambiguity. Unsafe retry is permitted only under proven provider
idempotency or an explicit reconciliation step; cancellation never claims to
undo a completed provider call.

Violations: recording an ambiguous outcome as failed and retrying a
non-idempotent call; hard-deleting or overwriting ambiguity evidence; treating
a lost acknowledgment as proof the provider call did not happen; marking an
effect dead-lettered solely because the result notification was lost.

Clean: unknown stays distinguishable from failure in the stored record;
exhausted retries produce a dead letter plus `onEffectFailed` in a new actor
turn.

Flag only a visible collapse of ambiguity or an unguarded retry. A clear
transport error before submission is a real failure — do not flag treating it
as one. This subsystem is not yet implemented; match only real code.
