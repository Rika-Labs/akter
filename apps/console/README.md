# Akter console

`@akter/console` is the hosted product console: a FoldKit client application built with Vite,
`@foldkit/vite-plugin` and `@stylexjs/unplugin`. Data comes from the shared `@akter/cloud-api`
contract; auth uses Better Auth's `/auth` routes. Components, charts and tokens come from `@akter/ui`, compiled from source in
the same StyleX pass.

## Run it

From `apps/console`:

- `bun run dev` serves on `127.0.0.1:${CONSOLE_PORT:-3000}` with live reload.
- `bun run build` writes the static application to `dist/`.
- `bun run preview` serves `dist/` on `${CONSOLE_PORT:-3002}`, falling back to `index.html` for
  client routes. Any static host with the same fallback can serve the build; there is no console
  server.

## API and fixture mode

The console uses `HttpApiClient.make(CloudApi)` with session credentials included. Set
`VITE_API_BASE_URL` to the API mount (default `/api`); the contract's `/api` prefix is applied
exactly once. Better Auth uses the same origin's `/auth` mount. A cross-origin deployment needs
credentialed CORS and cookie configuration on the API server.

For local development, set `API_PROXY_TARGET=http://127.0.0.1:<port>` or `API_PORT=<port>` to
proxy `/api` and `/auth` through Vite (the default target is `http://127.0.0.1:3001`). The
accounts backend's `apps/api/README.md` describes its Postgres/API/email-outbox Compose stack.
The backend is not in this checkout's base yet; when testing it from a separate worktree, set
`API_PROXY_TARGET` to its API port and `API_ORIGIN` and `CONSOLE_ORIGIN` to the console origin.

Set `VITE_CONSOLE_FIXTURES=1` before starting/building, or visit `/?fixtures=1`, to run without a
backend. The query flag persists for the tab; `?fixtures=0` turns it off. Fixture mode bypasses
auth and simulates mutations for browser tests. In real mode, route fixtures are imported lazily
only when an endpoint returns the typed `NotImplemented` error; transport, permission and
conflict errors are rendered rather than silently replaced with sample data. Mutations are
never reported as successful merely because a backend is unimplemented.

Environment-variable reads expose only names and provenance. Values are write-only inputs;
neither secret values nor masked tails are displayed.

The hosted commands page currently shows a snapshot from `runtime.listCommands`. The declared
SSE stream wraps `CommandLogEntry` without converting its `DateTime.Utc` field to a JSON codec,
so the generated client rejects ordinary ISO timestamps. Live streaming remains unavailable
until that contract is corrected; only explicit fixture mode synthesizes a moving tail.

The contract has no send-command endpoint, no rollback destination/semantics, no actor-type
activity series or per-command volumes, and no latency histogram. The console does not invent
those live measurements or actions: unavailable actions are refused, a live rollback is disabled,
and overview latency uses the provided p99 series. Paged inspectors currently load a first page;
workflow and audit truncation is labelled. Display times are UTC.

## Layout

```text
src/
  entry.ts               boots the FoldKit runtime with the workspace and stored theme as flags
  app/
    shell/               Model, Message, update, view, commands, subscriptions, palette, dialogs
    navigation/          typed routes and the sidebar and settings destinations
    <page>/              model.ts (schemas), client.ts (Effect loader), fixtures.ts, view.ts
```

Each page reads its data through its own `client.ts`, an `Effect` that maps the cloud contract to
the page's presentation schema. `app/api/client.ts` owns the shared cookie-bearing client,
organization/project/environment resolution, typed error presentation and explicit fallback.

## Pages

Signed out: `/sign-in`, `/sign-up`, `/verify-email`, `/forgot-password`, `/reset-password`,
`/invitations/:id`, `/onboarding?step=organization|project|deploy`.

The emailed `/accept-invitation?invitationId=…` link also resolves to the invitation page.

Project: `/` (overview), `/projects/:slug` (empty project when undeployed), `/actors`,
`/actors/:type`, `/actors/:type/:key?tab=state|rows|receipts|events|jobs|connections`,
`/commands`, `/jobs`, `/workflows`, `/connections`, `/deployments`, `/deployments/:commit`,
`/regions`.

Settings: `/settings`, `/settings/appearance`, `/settings/profile`, `/settings/notifications`,
`/settings/environment`, `/settings/regions`, `/settings/domains`, `/settings/api-keys`,
`/settings/integrations`, `/settings/organization`, `/settings/members`, `/settings/billing`,
`/settings/usage`, `/settings/audit-log`. Any other path renders the not-found page.

⌘K or Ctrl+K opens the command palette on every page. Below 860px the sidebar becomes a drawer.

## Verification

`bun run typecheck`, `bun run lint` and `bun run test` here; browser flows live in `apps/e2e`
(`bun run --cwd apps/e2e test:e2e`), which builds and previews this app.

FoldKit 0.163 exposes route constructors through a Proxy whose `.make` Effect 4.0 caches with
`defineProperty`, so a second read throws; `navigation/routes.ts` hands `Route.mapTo` plain
`{ make }` wrappers instead.
