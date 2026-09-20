# Invariants

**Responsibility:** connect contracts to named tests.  
**Authority:** verification.  
**Owner role:** verification/reliability.

1. Only one actor generation can commit.
2. A foreign mutation cannot partially succeed.
3. A committed event has committed source state.
4. A rolled-back command emits no durable event.
5. One retained command identity creates one logical transition.
6. Work intent commits before post-commit delivery.
7. Unknown external outcomes are not silently treated as failure.
8. A subscription never silently skips a committed event.
9. Restore never creates dual writable authority.
10. Process memory is never the only source of business truth.

Every invariant must have a unit, integration, crash, and—where relevant—multi-process test.
