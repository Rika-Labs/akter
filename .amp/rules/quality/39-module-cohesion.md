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

# One module carries one domain responsibility

A source module must not implement unrelated domain responsibilities in the
same file. Independent operations from different domains belong in different
modules, even when each function has a good name.

Violations: one file implementing shipping-cost math and markdown formatting;
a module that adds a credential-parsing helper next to unrelated billing
logic where neither serves the other; a new implementation block dropped
into a file whose other contents belong to a different domain.

Clean: related operations serving one capability in one file; a composition
or entrypoint module that wires several capabilities without implementing
them; barrel-free re-export surfaces; a file that implements one domain and
merely references others.

Flag only a visible split of unrelated implementations inside one changed
file. Do not flag wiring, routing, or test-harness composition, and do not
flag a cohesive file merely because it is long.
