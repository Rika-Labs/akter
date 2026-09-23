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
  - docs/contracts/06-storage-ownership.md
  - docs/contracts/10-security.md
---

# Every durable row derives ownership from trusted context

Every framework and actor-owned row carries a trusted `tenant_id` (and actor
identity where applicable) supplied by the runtime, not by the caller. Scoped
mutation exists only inside command turns; `ScopedRead` is select-only.

Violations: accepting tenant, actor id, or ownership columns from client input;
a query path that falls back to an unscoped client when scope derivation
fails; application code being required to add ownership predicates manually;
exposing mutation on read-only scopes; relying on RLS as the only isolation
instead of additional protection.

Clean: ownership columns are set on insert and enforced on update/delete/
upsert from the trusted context; unsupported or raw mutation that cannot
preserve ownership is rejected rather than executed unscoped.

Flag only a visible unscoped write path, caller-supplied ownership, or unscoped
fallback. The `Database` tag is the explicit, authorized cross-actor read
escape hatch — its read-only use is not a violation.
