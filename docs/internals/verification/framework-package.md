# Framework package boundary

The framework is `@rikalabs/akter` in `packages/akter`; it imports no other workspace package. The CLI is `@rikalabs/akter-cli`. The 0.2 framework has four entries:

| Entry     | Boundary                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `.`       | Browser-safe actor contracts, identity, errors and the Effect client contract. No store, cluster or SQL module.                    |
| `server`  | Store adapters, serving, peering, operator grants and telemetry. The filesystem-only bundle must contain no AWS or Smithy modules. |
| `client`  | The transport layer for that same Effect client, speaking the one `/rpc` group over WebSocket JSON or HTTP NDJSON.                 |
| `testing` | The seeded simulator and invariant evidence.                                                                                       |

`bun run check` builds and checks published declarations, lint and the package boundaries. `bun run pack:check` rejects missing exports/bin targets, leaked TypeScript sources, undeclared imports and workspace dependencies in packed artifacts. `bun run pack:smoke` and `SMOKE_RUNTIME=node bun run pack:smoke` exercise clean consumers on Bun and Node. Runtime floors remain Bun 1.4.2+ and Node 24+; local evidence names the versions actually run.

[E7 evidence](e7-find-operators.md) records the current checks. No package size or provider result is inferred from the retired runtime. The [dated 0.1 measurements](history/2026-10-12-framework-package-0.1.md) remain unchanged as history.
