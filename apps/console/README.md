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
Set `API_PROXY_TARGET` to its API port and `CONSOLE_ORIGIN` to the console origin. A same-origin
development proxy can also use the console origin as `API_ORIGIN`.

Set `VITE_CONSOLE_FIXTURES=1` before starting/building, or visit `/?fixtures=1`, to run without a
backend. The query flag and its tab storage are honoured only in Vite development mode;
production builds ignore them. `VITE_CONSOLE_FIXTURES=1` is an explicit build-time preview switch.
Sample pages carry a quiet notice and sample-backed controls and record links are read-only.
In real mode, route fixtures are imported lazily
only when an endpoint returns the typed `NotImplemented` error; transport, permission and
conflict errors are rendered rather than silently replaced with sample data. Missing organization
or project context never substitutes a sample identity. Mixed settings pages retain source per
slice, so sample endpoints do not disable real API-key controls. Mutations are never simulated
or reported as successful merely because a backend is unimplemented.

Environment-variable reads expose only names and provenance. Values are write-only inputs;
neither secret values nor masked tails are displayed.

The commands page loads a snapshot and then receives UTC-decoded command events over SSE. Pause
closes the stream; reconnect refreshes the snapshot before opening another stream. A stream that
is unavailable or interrupted leaves the snapshot visible with an inline explanation. Sample
pages never start a stream or simulate new turns.

The inspector's Send command dialog accepts JSON and an optional command ID, shows the actor's
result or typed `CommandFailed` payload, and distinguishes a replayed receipt. It starts with a
fresh ID and generates a retained client ID if the field is cleared, so retries after a lost
response reuse the same receipt key. The dialog captures the actor's project and environment
and closes on every URL change; navigation can never retarget an old actor address.

Deployment detail offers earlier successful deployments in the same environment as rollback
targets and displays `rolledBackFrom` on the newly created deployment. Redeploy starts a new
deployment of the viewed commit, which is built again. Both ask for confirmation, open the new
deployment on success and show the API's refusal otherwise. Rollbacks and redeploys reuse earlier
commits, so the console links deployments by id; a commit in the URL opens its newest deployment.
Runner actor counts and CPU the runtime does not measure show `—`, never `0`.

Actor-type activity and command volumes use `1h`, `24h` or `7d`. The overview latency distribution
requests each actor type's `/latency` histogram at the chosen window and sums counts only when
windows and bucket boundaries match. Its unbounded tail remains explicit and it computes no
combined percentiles; the older overview p50/p99 series stays labelled as 24h. A project-wide
histogram endpoint would avoid the per-type fan-out. Workflow steps are displayed 1-based.
Paged inspectors currently load a first page; workflow and audit truncation is labelled. Display
times are UTC. The API serves deployments, rollback, redeploy, command sending and actor jobs
from real runners; the other runtime reads (overview, actor types and instances, inspection,
command log and stream, jobs, workflows, connections) still answer typed 501s and fall back to
sample data.

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

Emailed invitation links use `/invitations/:id`; the earlier compatibility URL is no longer routed.

Project: `/` (overview), `/projects/:slug` (empty project when undeployed), `/actors`,
`/actors/:type`, `/actors/:type/:key?tab=state|rows|receipts|events|jobs|connections`,
`/commands`, `/jobs`, `/workflows`, `/connections`, `/deployments`, `/deployments/:deployment` (an id or a commit),
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
