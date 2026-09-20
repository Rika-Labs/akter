# Bun adoption plan

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Decision

Bun is the primary developer runtime, package manager and production target. Node remains a supported runtime through explicit platform adapters and a tested compatibility matrix. This is not 'Bun everywhere regardless of portability.'

## Capability-by-capability plan

| Bun capability | Use now | Boundary / reason |
|---|---|---|
| Package manager / bun.lock | Yes | Pin exact Bun; frozen installs in CI |
| Workspaces / catalogs | Yes | One version source; verify package publish resolution |
| Isolated linker | Yes, after tool compatibility check | Prevent phantom dependencies in package-heavy repo |
| Script runner | Yes | Portable Node standard-library scripts when practical |
| Production runtime | Yes | Through Effect platform-bun adapter |
| Native test runner | Bun runtime-specific smoke/conformance lane | @effect/vitest remains primary semantic suite |
| Bundler | Apps/optional CLI executable experiments | Libraries emit ESM and declarations without bundling Effect |
| Shell `$` | Optional repo tooling | Not in portable library or actor core |
| bun:sqlite | Local adapter/test capability | Not equivalent to remote libSQL durability |
| Bun.SQL | Do not use in kernel initially | Effect SQL provides the shared typed transaction interface |
| HTTP/WebSocket native APIs | Through platform-bun adapter | Same protocol tests must pass on Node |
| Files / subprocess | Prefer Effect FileSystem/process services | Native APIs only at adapter edge |
| Worker threads/Web Workers | Defer until CPU-bound need | Semantics and teardown differ; test both runtimes |
| Watch/hot reload | Docs/tooling now; actor dev runtime later | Reload must not create unfenced dual ownership |
| Environment loading | Explicit configuration | No accidental .env production dependency |
| S3/Redis built-ins | Optional adapter optimization later | Core uses BlobStore/Cache contracts |
| Macros/plugins | Not V1 core | Reduce portability/build-system coupling |
| Single-file executables | Optional CLI distribution | npm ESM remains portable baseline |
| Publishing | Pack validation via chosen tool; OIDC release separate | Do not assume Bun publishing equals trusted npm workflow support |

## Runtime caveats

Node compatibility is continually evolving, not a blanket guarantee. Check fetch/AbortSignal, WHATWG/Node streams, WebSocket close/backpressure, TLS, HTTP proxying, DNS/private networking, crypto, workers, child processes and native addons used by actual dependencies. A library importing successfully is not sufficient.

Keep runtime services injectable through Effect. Application code uses Effect clock/config/fs/http/process primitives. Bun-native resource implementations are free to optimize below those contracts after equivalent behavior is tested.

## Test runner distinction

`bun run test` can execute a Node-based tool according to its shebang. That does not prove the tests ran under Bun. The primary @effect/vitest suite verifies Effect semantics on its supported host. A separate `bun test` lane verifies Bun-specific imports and adapter behavior. Shared conformance cases should be invoked through both platforms once implementations exist.

## Build/distribution

Use TypeScript/native compiler for type checking and declarations. Bun transpilation does not perform that work. Do not bundle Effect into every package; keep an explicit peer/version compatibility policy. Use ESM-only library exports and validate package tarballs under both runtimes. Do not depend on source TypeScript execution as the only Node distribution path.

## Operational acceptance

Run crash, signal, graceful shutdown, network partition, remote SQLite transaction and SSE reconnect tests on Bun first and Node independently. A Bun performance win is a measurement, not justification to skip behavioral compatibility. Pin updates and group them with Effect platform package updates only when peer compatibility requires it.

## Sources and evidence

- [B01: Bun Node compatibility](https://bun.com/docs/runtime/nodejs-compat) — Bun tracks Node compatibility; compatibility is not completeness and requires our own production path tests.
- [B02: Bun isolated installs](https://bun.com/docs/pm/isolated-installs) — Isolated dependency layout helps expose phantom dependencies.
- [B03: Bun workspaces/catalogs](https://bun.com/docs/pm/catalogs) — Shared version catalogs and workspaces; registry packaging must rewrite workspace references correctly.
- [B04: Bun install](https://bun.com/docs/pm/cli/install) — Lockfile and trusted dependency lifecycle policies.
- [B05: Bun testing](https://bun.com/docs/test) — Native runtime test runner; not a substitute for @effect/vitest APIs.
- [B06: Bun bundler](https://bun.com/docs/bundler) — Build targets and executable compilation; does not replace declaration generation/type checking.
- [B07: Bun SQLite](https://bun.com/docs/runtime/sqlite) — Local runtime-specific database, not a remote durable fleet backend.
- [B08: Bun HTTP server](https://bun.com/docs/runtime/http/server) — Server/WebSocket APIs belong in Bun adapter, not portable actor core.
- [B09: Bun package publication](https://bun.com/docs/pm/cli/publish) — Packaging capabilities; trusted publication compatibility must be checked before release.
- [E13: Effect platform Bun](https://github.com/Effect-TS/effect/tree/main/packages/platform-bun) — Runtime implementations; exact exports must be checked against pinned release.
