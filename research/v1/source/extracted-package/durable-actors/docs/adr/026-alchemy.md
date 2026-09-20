# ADR 026: Alchemy for selected external infrastructure

Date: 2026-09-17  
Status: Conditional

## Context
Infrastructure should be code-reviewed but the exact Alchemy edition/API and provider support must match the chosen version.

## Decision
Use Alchemy after verifying provider APIs. Railway owns app deployment initially; give every external resource one state owner.

## Alternatives considered
Invented Alchemy.Stack/provider calls are rejected. Using two IaC tools for the same resource creates drift.

## Consequences and risks
The scaffold contains an intentionally non-provisioning entry and resource plan, not fake deployable infrastructure.

## Validation and revisit trigger
Approve after a dry-run in a disposable environment with state/secret handling and teardown tested.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Alchemy](https://alchemy.run/)
- [Railway configuration](https://docs.railway.com/reference/config-as-code)
