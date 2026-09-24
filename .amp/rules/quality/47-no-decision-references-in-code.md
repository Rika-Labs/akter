---
enabled: true
paths:
  - packages/**
  - apps/**
  - examples/**
  - tooling/**
  - infra/**
  - .github/src/**
  - .amp/plugins/**
exclude:
  - tooling/oxlint/src/comments/no-decision-references*.ts
on: code-change
severity: error
threshold: 0.9
priority: 0
---

# Code comments never cite decision records

A comment or JSDoc states its reason in place. It must not point the reader to
a decision record for that reason: decision records live under
`docs/decisions` and the research documents, and they link to code, not the
other way round. A citation goes stale when the decision is superseded and
explains nothing without opening another file.

Violations, in any comment, JSDoc block, or test file comment:
`// Commands are direct (ADR 0011): ...`; `/** Placement rows (ADR 0006). */`;
`// per decision 162`; `// see docs/decisions/0010-one-way-effect-native-api.md`;
`// v4 research, pick 4C`; `// as the owner decided in the M1 plan`;
`// ledger entry 41 requires this`; `// ADR-0005 batching`.

Clean: the same comment with the citation removed and its reason kept
(`// Commands are direct: the Cluster message is volatile, so the receipt is
the only admission record`); references to external specifications or issues
that describe a bug or workaround (`// Postgres 18 bug #18934`); string
literals, test names, and fixture data; Markdown documentation.

Flag only a changed comment that cites an ADR, a numbered or named decision,
a research pick, or a ledger entry as its justification. The fix is to delete
the citation and keep or add the reason it stood for.
