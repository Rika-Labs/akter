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
"robust"), and abandoned commented-out implementations are also violations.

Violations: `// Increment the counter` above `count++`; `// Return the user`
above `return user`; a block of commented-out code kept "just in case";
`// helper function` above a function declaration.

Clean: comments explaining non-obvious reasons, constraints, units, security
requirements, or workarounds (`// Sign the original bytes: re-encoding
changes the provider's signature`); license notices; functional tool
directives (`// SAFETY:`, lint suppressions); doc comments that declare
units, ordering, or contract guarantees; comment text inside string literals.

Flag only a visible comment whose entire content restates the adjacent code
or is dead commented-out implementation. Do not flag comments whose reason
may be non-obvious to a reviewer, and do not demand explanatory comments
where none exist.
