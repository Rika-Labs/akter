# Contributing guide

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Start with START_HERE and the package-boundary rules. This is a setup-only repository; do not add fake runtime behavior simply to make examples execute.

## Pull request checklist

Explain the contract changed and link the relevant ADR/gate. Keep mirrored tests next to the corresponding source path under test/. Include source version references for changes to unstable Effect integration. Run format, lint, Effect diagnostics, typecheck, tests, build and scaffold checks. Add negative type tests for public API changes and conformance tests for adapters.

## Architectural changes

A new primitive needs a concrete use case, ownership/lifetime/durability semantics, failure modes, source reuse analysis and a scope decision. New packages need a dependency boundary or deployment reason. Do not create a package for every noun.

## Unsafe operations

No provider credentials, production IDs or local environment files in commits. Do not add scripts that provision paid infrastructure on install/dev. Do not bypass receipt/fence checks or write reserved tables from application examples. No unbounded retries or ignored Promise rejections.

## Review standards

The code should make authority and transaction boundaries easy to inspect. Smaller files are useful when they clarify responsibility, not when they split one invariant across hidden callbacks. Document expected errors, cancellation behavior and replay requirements near public APIs.

## Publication

Only repository owners enable release workflows, choose a license/security contact, claim npm scopes and authorize deployments. None of those actions has been performed by generating this package.
