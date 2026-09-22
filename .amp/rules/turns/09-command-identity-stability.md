---
enabled: true
paths:
  - packages/durable-actors/src/identity/**
  - packages/durable-actors/src/handles/**
  - packages/durable-actors/src/client/**
  - packages/durable-actors/src/runtime/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 20
contextFiles:
  - docs/contracts/04-receipts.md
  - docs/contracts/protocol.md
---

# Command identity is minted once and immutable

The command id is minted by the caller-side handle or client before delivery
and reused verbatim on every retry; `turn()` never mints one. Identity-bound
expiry metadata travels unchanged with the id: transports never silently
refresh it, and expiry never triggers an automatic retry under a fresh id —
a new id is an explicit new operation and resolves nothing about the old one.

Violations: regenerating an id on retry or inside the runtime; parsing a
received identity and re-minting it with a new expiry; auto-retrying a
`CommandExpired`/`InvalidCommandId` rejection under a new id while reporting
it as the same operation.

Clean: retry loops forward the original id and expiry; expiry rejection is
terminal and surfaces the command id.

Flag only a visible re-mint or refresh. Minting at acquisition/client side is
correct — do not flag first minting. Test fixtures that construct identities
explicitly are expected.
