# Deployment-bound runtime hosts

Status: accepted.

## Context

The control plane reaches a live runner through the edge. The edge refreshes its environment-host directory periodically, so sending a newly activated deployment's credential to the environment host can briefly route that credential to the previous deployment.

## Decision

Runtime requests use the live deployment's own host, `<deployment-id>.<runtime-domain>`, together with that deployment's service credential. The deployment host does not move when an environment activates a different release, so edge host-directory refresh cannot pair a credential with the wrong deployment. The environment host remains the public route for environment-level traffic and is updated on activation.

## Consequences

The API no longer depends on the edge's environment-host refresh interval immediately after activation. The edge still authenticates every request and the runner still verifies the signed assertion; the deployment host is routing identity, not authorization.

## Evidence

The rollout integration test activates two releases and verifies that each deployment host resolves to its own credential while the environment host moves to the active release. The deployment stack runs the follow-up command immediately after activation.
