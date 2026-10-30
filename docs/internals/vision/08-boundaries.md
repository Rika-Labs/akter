# Boundaries

Akter owns actor authority, durable command outcomes, pending work, and live access within a store. It does not replace an application's general database, join arbitrary tables, perform cross-shard transactions, or guarantee external I/O exactly once.

Commands are trusted deterministic application code, not a security sandbox. Store credentials are a strong trust boundary: only authorized runners and separately granted operators may reach durable bytes. Application clients never read bucket keys.

`find` is a scatter-gather query over durable scalar indexes, not a global snapshot. Broadcasts are live hints, not retained history. Forks and replay are audited operator tools, not an ordinary application API. No migration from 0.1 is offered.

Design targets and local tests do not establish production-provider behavior, power-loss durability, cross-tenant hosted isolation, or pricing.
