---
enabled: true
paths:
  - packages/durable-actors/src/runtime/workflows/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 15
contextFiles:
  - docs/contracts/08-background-work.md
  - docs/architecture/data-model.md
---

# Workflow identity spans deployment, tenant, owner, member, key

A workflow execution is identified by `[deployment, tenant, owner actor, owner
id, workflow member, key]`. Equal keys in different tenants or under different
owners are distinct executions. Resume restores tenant and `onBehalfOf`
attribution from the durable envelope, never from the recovering caller or
process state.

Violations: keying executions by workflow key or name alone; resolving tenant
or `onBehalfOf` from the ambient caller on resume instead of the persisted
envelope; letting two tenants' executions share a dedup space; dropping
deployment scope so a restored backup collides with the live deployment.

Clean: the durable envelope carries the full identity; resume is a faithful
read of it, including persisted System/on-behalf-of attribution.

Flag only a visible identity-narrowing or attribution-substitution defect.
This subsystem is not yet implemented; match only real code, not `.gitkeep`
placeholders, and do not demand the identity fields from unrelated code.
