---
enabled: true
paths:
  - packages/**
  - apps/**
  - examples/**
  - tooling/**
exclude:
  - tooling/oxlint/src/comments/no-inline-comments*.ts
on: code-change
severity: warning
threshold: 0.9
priority: 0
---

# No inline comments; reasons live in JSDoc

Code contains no inline `//` or `/* */` comments. A reason the code cannot
show (a constraint, unit, ordering, security requirement, or workaround) goes
in the JSDoc (`/** */`) of the enclosing declaration: the function, class,
type, constant, or member it explains. If the reason is about one statement,
state it in the declaration's JSDoc and name that statement's role there.

Exceptions, and only these: functional directives (lint suppressions,
`@ts-expect-error`, `@ts-ignore`, triple-slash references, coverage and
bundler hints such as `/* @__PURE__ */`) and license headers at the top of a
file. `durable-actors/no-inline-comments` enforces this mechanically.

Violations: `// Increment the counter` above `count++`; a trailing
`// retry once` after a statement; `/* why */` inside an argument list;
commented-out code; a section label such as `// ---- helpers ----`; a `//`
comment inside a function body that explains a reason a JSDoc on that function
could carry.

Clean: `/** Sign the original bytes: re-encoding changes the provider's
signature. */` above the function; `// @ts-expect-error the fixture is
intentionally invalid`; a license header; comment text inside string literals.

JSDoc must be clean: state the reason in plain sentences, do not narrate what
the code does, do not restate the name or the types, and do not cite decision
records (see `47-no-decision-references-in-code.md`).

Flag any inline comment that is not a directive or license header. When the
comment carries a real reason, the fix is to move that reason into the
enclosing declaration's JSDoc; otherwise delete it.
