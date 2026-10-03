# ADR 0069: Small control-plane feature flags

**Status:** implementation decision (2026-10-03), implements #514 and the requested no-vendor package.
**Responsibility:** package placement, browser boundary and persistence for feature flags.
**Authority:** design decision record.
**Owner role:** control plane.
**Change policy:** supersede through a new ADR.

## Decision

Add private workspace package `packages/flags` as `@akter/flags`. Its root exports declaration/evaluation, an application-registry Effect service, and memory and Postgres stores. `@akter/flags/browser` exports only `src/evaluation.ts`; it cannot import storage or SQL. The framework package remains independent.

Use application-owned Effect Schema declarations with typed defaults and JSON-encoded overrides. Explicit user rules precede organization rules, stable identity-based percentage rollouts, global overrides and defaults. FNV-1a fixes cohort assignment across browser/server evaluation and restarts without a vendor or external crypto dependency.

Store one complete override rule per flag key in the control-plane database, installed by `packages/postgres/migrations/0005_feature_flags.sql`. Reads are uncached and replacements atomic. A scoped API snapshot contains resolved values only, avoiding disclosure of other users' targeting data. Applications retain responsibility for authentication and administrative write authorization; flags are not access-control policy.

## Consequences

This remains small: no polling, rule language, analytics, management UI, audit log or vendor abstraction. Postgres restart, failed replacement, rollback, interruption and deletion evidence lives in `packages/flags/src/postgres.test.ts`; pure evaluation and memory-service evidence are colocated with their modules. Provider certification and API/console endpoint integration are not claimed.
