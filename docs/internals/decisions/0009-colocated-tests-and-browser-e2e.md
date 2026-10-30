# ADR 0009: Colocated tests and a separate browser project

**Status:** accepted (2026-09-22)
**Supersedes:** ADR 0001's temporary `test/` exemptions and the browser location in the repository structure design

## Context

The initial template split package tests across `src/`, `test/`, and the
console's browser fixture directories. Their package scripts and Vitest globs
could miss a moved test. A test should have an obvious owner even when it uses
a real database; the required environment is independent of its location.

## Decision

- Unit and integration tests use one `x.test.ts` file beside the matching
  `src/x.ts`. The structure checker rejects misplaced tests and basenames
  without a matching source; runners select database-backed suites explicitly.
- Browser E2E tests are the only exception: `apps/e2e/*.e2e.ts` is a separate
  Playwright workspace. It starts the console's read-only fixture to check
  rendering, navigation, and form boundaries, not live auth or billing.
- Keep tests runnable separately (`test`, `test:integration`, `test:e2e`) so
  Postgres and browser prerequisites remain explicit. The tree checker blocks
  visible placement violations in CI.

## Alternatives

A mirrored `test/` tree duplicates the source hierarchy and makes test
ownership less obvious. Browser specs inside the console package couple its
application test task to a browser install; a separate app keeps that runtime
prerequisite explicit.

## Consequences

The former `test/` exemptions are removed. New suites must sit beside their
source, regardless of whether they are unit or integration tests. Browser
coverage against the fixture does not prove the live API/auth flow; the API's
disposable-Postgres HTTP integration suite remains separate evidence.

## Evidence and revisit conditions

The structure checker has fixtures for wrong basenames and directories;
`bun run check`, `bun run test:integration` with a disposable database, and
`bun run test:e2e` exercise all three runners. Revisit the browser fixture
when a real authenticated E2E environment can be provisioned without sharing
production credentials or writing to a shared database.
