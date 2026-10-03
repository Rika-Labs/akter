# Akter console

`@akter/console` is the hosted product console: a FoldKit client application built with Vite,
`@foldkit/vite-plugin` and `@stylexjs/unplugin`. It renders every page from typed fixtures until
the hosted API exists. Components, charts and tokens come from `@akter/ui`, compiled from source in
the same StyleX pass.

## Run it

From `apps/console`:

- `bun run dev` serves on `127.0.0.1:${CONSOLE_PORT:-3000}` with live reload.
- `bun run build` writes the static application to `dist/`.
- `bun run preview` serves `dist/` on `${CONSOLE_PORT:-3002}`, falling back to `index.html` for
  client routes. Any static host with the same fallback can serve the build; there is no console
  server.

## Layout

```text
src/
  entry.ts               boots the FoldKit runtime with the workspace and stored theme as flags
  app/
    shell/               Model, Message, update, view, commands, subscriptions, palette, dialogs
    navigation/          typed routes and the sidebar and settings destinations
    <page>/              model.ts (schemas), client.ts (Effect loader), fixtures.ts, view.ts
```

Each page reads its data through its own `client.ts`, an `Effect` that resolves the page's schema.
Today those return fixtures; the hosted API's client replaces each body without changing its type,
and a page can keep its fixture as the fallback while an endpoint is unimplemented.

## Pages

Signed out: `/sign-in`, `/sign-up`, `/verify-email`, `/forgot-password`, `/reset-password`,
`/invitations/:id`, `/onboarding?step=organization|project|deploy`.

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
