# Durable Actors vision

These documents describe what Durable Actors is trying to become. They are intentionally separate from implementation plans and research.

## Reading order

1. [The problem](01-problem.md)
2. [The product model](02-product-model.md)
3. [Relational data](03-relational-data.md)
4. [Durable execution](04-durable-execution.md)
5. [Realtime applications](05-realtime.md)
6. [Developer experience](06-developer-experience.md)
7. [Deployment and ownership](07-deployment.md)
8. [Boundaries](08-boundaries.md)

Each document answers one question:

- What problem are we solving?
- What should an actor mean to an application developer?
- How should relational data and actor authority fit together?
- What must survive failure?
- How should realtime behavior feel?
- What should the APIs feel like?
- Where should the system run and who operates it?
- What must we deliberately refuse to promise?

These are product direction, not proof that the runtime already exists. Implementation contracts and conformance tests must turn each accepted statement into something falsifiable.
