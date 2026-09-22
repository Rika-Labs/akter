---
enabled: true
paths:
  - "**/*.test.ts"
  - packages/durable-actors/src/testing/**
exclude: []
on: code-change
severity: warning
threshold: 0.9
priority: 0
---

# Tests assert behavior, not scaffolding

A test must assert observable behavior. `it.todo`, a body that only expects
no throw, `expect(true)`, tautological assertions, or a snapshot of
scaffolding presented as coverage are violations. A placeholder `it(...)`
reserved for behavior that does not exist yet is also a violation — add the
test with the first real behavior.

Violations: `it('works', () => { expect(true).toBe(true) })`; `it.todo(
'handles rollback')`; `it('creates the actor', async () => { await create()
})` with no assertion; `expect(x).toBeDefined()` standing alone as the whole
verification of a behavior.

Clean: assertions on results, committed state, receipts, or error channels;
`it.skipIf(!process.env.TEST_DATABASE_URL)` for a genuinely
environment-gated case with a visible gate; a regression test whose
assertion is narrow but real.

Flag only a visible assertion that cannot fail or a placeholder masquerading
as a test. Do not flag tests asserting only an error/rejection where the
contract requires exactly that failure, and do not demand additional
assertions a test's own claim does not need.
