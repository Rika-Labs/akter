---
enabled: true
paths:
  - packages/durable-actors/src/runtime/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 20
contextFiles:
  - docs/contracts/04-receipts.md
  - docs/contracts/10-security.md
---

# Caller identity is access control, never a dedup key

Receipts deduplicate on (tenant, actor, actor id, command id) binding the
command name and payload hash. Within the horizon an authorized retry with the
same id and payload replays the stored outcome; the same id with a different
command or payload fails `CommandConflict` — both without rerunning the
handler.

Violations: including caller identity in the deduplication key so one id can
execute once per caller; letting a different caller presenting a known id read
the outcome or trigger a second execution; treating rotated credentials of the
same logical caller as a different caller.

Clean: receipt access is checked as authorization over the stored row —
original logical caller with current access, or receipt-scoped operator —
independent of the dedup key.

Flag only a visible caller-dependent dedup or access bypass. Credential
rotation preserving logical identity is required, not a bug. Do not infer
missing access checks in unseen code.
