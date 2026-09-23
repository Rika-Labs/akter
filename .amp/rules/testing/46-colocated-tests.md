---
enabled: true
paths:
  - "**/*.test.ts"
  - apps/e2e/**
exclude:
  - research/**
on: code-change
severity: warning
threshold: 0.9
priority: 10
---

# Tests share their source file's name and directory

Unit and integration tests both belong next to the source they exercise:
`src/account/handler.ts` has `src/account/handler.test.ts`. A test must have a
real matching source file, and one source file has at most one test file. Do not
create `test/` or `tests/` trees, `handler.integration.test.ts` beside
`handler.ts`, or a test with an unrelated source basename. Only browser E2E
specs live separately under `apps/e2e/` and use `.e2e.ts`.

The structure checker enforces path and basename placement in CI. This rule
flags visible violations and recommends moving the test, not duplicating it.
