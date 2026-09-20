# Vite and Effect/Vite — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Docs/playground development and optional application integration.

## Alternatives
VitePress for docs, static hosting, custom dev server. Initial portal uses Vite only.

## Selection rationale
User preference; avoid using an app bundler as the library compiler.

## Maturity
Vite version is pinned; Effect-specific plugin API/availability remains a gate.

## Performance
Measure dev/build DX; not a claim about actor execution speed.

## Developer experience
Simple static portal now; richer docs app later without framework runtime.

## Effect integration
Only integrate a verified @effect/vite API; no invented effect/vite reexport.

## Bun integration
Bun invokes Vite; test supported process host.

## Node compatibility
Build artifacts/browser output separate from Node library compatibility.

## CI behavior
Build static portal and check internal docs paths.

## Local behavior
`bun dev` currently serves docs/setup, not an actor emulator.

## Production behavior
Static portal deploys independently of runner/gateway.

## Maintenance risk
Plugin compatibility/version churn should not block core correctness work.

## Licensing
Check exact tool/plugin licenses through package metadata.

## Pricing
Build/hosting costs, no actor request meter.

## Lock-in
Keep docs Markdown independent from plugin.

## Migration path
Publish docs through another generator if needed; core unchanged.

## Known issues / uncertainties
Effect plugin existence does not imply a production actor runtime or correct hot reload.

## Operational burden
Dev server/proxy configuration and static deployment.

## Security implications
Never expose provider credentials to browser bundles or VITE_* public variables.

## Sources
- [Vite documentation](https://vite.dev/guide/)
- [VitePress](https://vitepress.dev/guide/getting-started)
- [Effect Vite integration](https://github.com/Effect-TS/effect/tree/main/packages/vite)
