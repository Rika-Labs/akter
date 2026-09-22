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

# Standalone exported names identify the operation

A standalone exported function or constant must identify its specific
operation — the conversion, calculation, parser, or formatter it performs —
not merely that work happens. A generic action name such as `handle`,
`process`, `run`, `do`, or `transform` on a specific operation is a
violation: the caller should not need to read the body or parameter names to
discover the purpose, and a descriptive filename does not repair an
uninformative function name.

Violations: `export function handle(text)` that strips HTML; `export const
process = ...` that parses a wire envelope; a renamed generic export whose
name no longer describes what it does.

Clean: `stripHtmlTags`, `parseEnvelope`, domain-scoped methods on an actor or
service object, framework-required entrypoints (`default` plugin export,
`main`), local callbacks, and established mathematical or protocol names
(`sha256`, `min`).

Flag only a visible standalone export whose name hides its operation. Do not
infer the operation from the filename when the visible signature and body
make it clear; abstain when the changed lines show only a name you cannot
characterize.
