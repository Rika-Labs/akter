# ADR 025: Railway pilot deployment with explicit runner identity

Date: 2026-09-17  
Status: Conditional

## Context
The user prefers Railway. Cluster transport needs unique runner addresses, which a generic service load balancer may not provide.

## Decision
Pilot gateway/runner/relay roles with explicitly addressable runners; verify private network, drain and direct DB behavior before replica scale-out.

## Alternatives considered
Kubernetes/Nomad provide other routing/control options but add operational scope. A single load-balanced runner identity is rejected.

## Consequences and risks
Topology validation precedes autoscaling claims. Config files remain non-deploying templates until runtime entries exist.

## Validation and revisit trigger
G06; change deployment topology/provider if per-runner routing cannot satisfy the contract.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Railway monorepos](https://docs.railway.com/guides/monorepo)
- [Railway private networking](https://docs.railway.com/guides/private-networking)
- [Railway configuration](https://docs.railway.com/reference/config-as-code)
