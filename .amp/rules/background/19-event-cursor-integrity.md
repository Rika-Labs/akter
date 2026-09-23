---
enabled: true
paths:
  - packages/durable-actors/src/runtime/events/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: warning
threshold: 0.9
priority: 10
contextFiles:
  - docs/contracts/05-messaging.md
  - docs/contracts/07-realtime.md
---

# Event cursors are ordered and gaps are explicit

`ctx.emit` appends an owner-scoped event only when the turn commits, with a
monotonically ordered cursor within the actor stream. Replay resumes after a
valid exclusive cursor or returns an explicit cursor/retention failure — it
never silently skips committed events or claims continuity over a gap.

Violations: emitting before commit so a rolled-back turn leaves an event;
non-monotonic or per-subscriber cursors; replay that silently fast-forwards
past retained-out history; telling a subscriber the feed is continuous when
events may have been pruned.

Clean: `events(Event, { after })` yields committed events with sequence,
timestamp, and command id; retention loss surfaces as an explicit resync or
failure.

Flag only a visible ordering, emission-timing, or silent-gap defect.
`Actor.stream` is live-only by design — do not flag it for lacking replay or
durability.
