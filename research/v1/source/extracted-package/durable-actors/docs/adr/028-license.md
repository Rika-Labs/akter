# ADR 028: Permissive framework license, owner approval first

Date: 2026-09-17  
Status: Proposed

## Context
A self-hostable developer framework benefits from clear rights; commercial cloud terms and repository ownership are not yet established.

## Decision
Recommend Apache-2.0 for framework code after owner/legal approval. Keep this scaffold private/UNLICENSED until that decision is made.

## Alternatives considered
MIT is simpler; source-available licenses may support monetization but can reduce adoption and complicate compatibility. No legal conclusion is asserted here.

## Consequences and risks
Do not silently license the owner’s future code or claim trademark/scope rights. Separate cloud service terms and subprocessors.

## Validation and revisit trigger
Resolve before public release, with actual ownership/security contacts.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0)
