# @durable-actors/cluster

Setup-only workspace package. **No actor runtime behavior is implemented.**

## Responsibility
See [package boundaries](../../docs/PACKAGE_BOUNDARIES.md) and the [implementation backlog](../../docs/IMPLEMENTATION_BACKLOG.md).

Allowed workspace dependencies: @durable-actors/core.

`src` contains service/type contracts only. `test` mirrors source layout. Current tests check import/contract shapes, not distributed behavior. Public publication is intentionally disabled with `private: true`.

Before implementing this package, complete the relevant [validation gates](../../docs/VALIDATION_GATES.md). Do not add placeholder success responses or a fake in-memory implementation that appears durable.
