---
enabled: true
paths:
  - packages/durable-actors/src/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 20
contextFiles:
  - docs/contracts/10-security.md
---

# Secrets never persist in durable rows or telemetry

Credentials, tokens, hosted assertions, and sensitive payloads are never
written to durable rows, event payloads, connection state, or unredacted
logs/spans. Only verified caller attribution is persisted — never the external
credential that produced it.

Violations: storing a bearer token, assertion, or API key in a receipt,
envelope, connection-state, or business row; logging raw authorization headers
or credential-bearing error causes; attaching secrets to span attributes;
echoing credentials into `ActorError` messages.

Clean: `Redacted` wrappers stay redacted through persistence and logging; the
edge verifies an assertion then stores only the resolved attribution; startup
failures sanitize causes that may contain credentials.

Flag only a visible persistence or logging of secret material. Fixtures with
obviously fake credentials in tests are expected — do not flag them. Do not
flag hashed fingerprints or key ids stored for rotation bookkeeping.
