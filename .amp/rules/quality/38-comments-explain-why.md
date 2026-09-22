---
enabled: true
paths:
  - packages/**
  - apps/**
  - examples/**
  - tooling/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: warning
threshold: 0.9
priority: 0
---

# Comments explain why, never narrate what

A comment must add information the code does not already state. Narrating an
assignment, function call, loop, return, or deletion without explaining why
is a violation. Decorative section labels, self-praise ("elegant",
"robust"), boilerplate type-assertion justifications, test-location
breadcrumbs, and abandoned commented-out implementations are also violations.

Violations: `// Increment the counter` above `count++`; `// Return the user`
above `return user`; a block of commented-out code kept "just in case";
`// helper function` above a function declaration; `// SAFETY: omitted generic
options use the corresponding default type parameters`; `// DDL rollback and
restart evidence: testing/conformance/crash/main.test.ts`.

Clean: comments explaining non-obvious reasons, constraints, units, security
requirements, or workarounds (`// Sign the original bytes: re-encoding
changes the provider's signature`); license notices; functional tool
directives (compiler directives, lint suppressions); doc comments that declare
units, ordering, or contract guarantees; comment text inside string literals.

Flag only a visible comment whose entire content restates the adjacent code
or a test location, or is dead commented-out implementation. A `SAFETY:` label
does not exempt a comment. Do not flag comments whose reason
may be non-obvious to a reviewer, and do not demand explanatory comments
where none exist.
