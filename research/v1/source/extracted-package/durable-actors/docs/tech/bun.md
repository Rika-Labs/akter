# Bun — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Primary developer runtime, package manager and production target.

## Alternatives
Node-only; pnpm plus Bun runtime; Bun-only without compatibility. Select Bun-first with explicit Node adapter.

## Selection rationale
Matches the requested workflow while concentrating host-specific choices at adapters.

## Maturity
Assess the exact pinned release; broad Node compatibility is not complete equivalence.

## Performance
Benchmark real SQL/stream/workflow paths; do not use HTTP hello-world throughput as runtime justification.

## Developer experience
Fast install/scripts and one developer executable; keep commands explicit about which runtime executes a test.

## Effect integration
Use platform-bun implementations and ordinary Effect code in core.

## Bun integration
Use workspaces/lock/catalogs; native sqlite/server only in adapters; no Bun globals in portable modules.

## Node compatibility
Run emitted ESM, protocol and adapter conformance under Node 24 independently.

## CI behavior
Frozen lock and explicit trusted lifecycle scripts; separate Bun-native tests from Node-hosted Vitest.

## Local behavior
Fast docs/tooling and future local actor mode; local sqlite is not remote durability proof.

## Production behavior
Bun runner is primary after signal/TLS/stream/database failure tests pass.

## Maintenance risk
Runtime compatibility/native-addon changes need pinned upgrade lanes.

## Licensing
Record exact distributed package license metadata; third-party native components have their own notices.

## Pricing
No per-command runtime license model assumed; compute savings must be measured.

## Lock-in
Bun APIs in core would increase lock-in; current boundary avoids that.

## Migration path
Swap platform adapter and run the same conformance suite; tooling can still use Bun.

## Known issues / uncertainties
Node streams, cancellation, workers, native addons and module resolution need actual path tests.

## Operational burden
Maintain a two-runtime support matrix and reproducible images.

## Security implications
Package scripts and native addons are supply-chain surfaces; a Bun VM is not customer-code isolation.

## Sources
- [Bun Node compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Bun isolated installs](https://bun.com/docs/pm/isolated-installs)
- [Bun workspaces/catalogs](https://bun.com/docs/pm/catalogs)
- [Bun install](https://bun.com/docs/pm/cli/install)
- [Bun testing](https://bun.com/docs/test)
- [Bun bundler](https://bun.com/docs/bundler)
- [Effect platform Bun](https://github.com/Effect-TS/effect/tree/main/packages/platform-bun)
