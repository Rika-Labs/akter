---
enabled: true
paths:
  - packages/durable-actors/src/runtime/**
  - packages/durable-actors/src/serve/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 15
contextFiles:
  - docs/contracts/02-command-turns.md
  - docs/contracts/04-receipts.md
---

# Internal recovery and external admission stay distinct

Trusted internal redelivery of accepted work bypasses external admission —
re-authorization and retry-expiry checks — because the obligation was already
accepted. External deliveries always pass admission, and no external path can
present itself as internal recovery.

Violations: re-running external authorization or expiry checks on a
redelivered accepted envelope so revocation or expiry strands committed work;
accepting a caller-controlled flag or header that marks a request "internal";
letting an expired external identity ride the recovery path; treating the two
paths as interchangeable in dispatch.

Clean: the trusted/internal property is established by the framework's own
envelope path, not by request content; external requests can never forge it.

Flag only a visible misclassification in either direction — external treated
as trusted, or trusted re-subjected to external admission. Retryable-defect
redelivery of the same envelope is the trusted path — do not flag it for
skipping admission.
