# Server-rendered web

`@durable-actors/console` is a Bun HTTP boundary around FoldKit's official
`foldkit/experimental/server` renderer. Rendering explicitly uses
`isHydratable: false`. There is no browser entrypoint, React, hydration, inline
JavaScript, or client-rendered application. Every interaction is an HTML form or
ordinary link. `@durable-actors/ui` owns the compiled StyleX components and light/dark
semantic tokens.

## Build and run

From `apps/console`, run `bun run build`, then `bun run start`. Build compiles
`@durable-actors/ui` first, bundles the server to `dist/main.js`, and copies the CSS to
`dist/styles.css`. **Start requires both generated files**; it does not build.
The production artifact is the entire `apps/console/dist` directory.

- `PORT`: defaults to `3000`.
- `API_ORIGIN`: defaults to `http://localhost:3001`; must be an HTTP(S) origin.
- `APP_ORIGIN`: defaults to `http://localhost:3000`; set the exact public origin
  in production or when using an orb portal. Forwarded host/protocol headers are
  deliberately not trusted.
- `GET /health`: web-process liveness only, not database/API health.

`bun run dev` builds and starts a watched source server. Run the UI package's
`bun run dev` to watch StyleX sources. Re-run the web build after CSS changes to
refresh its copied stylesheet. Root orchestration can build UI before web.

## Own-API contract

- `GET /api/dashboard`: `{ user: { name, email }, organization: { id, name,
slug, role } | null, members: [{ id, name, email, role }], projects: [{ id,
name, status }], billing: { plan, status, renewalDate? } }`. All scalar fields
  are strings. HTTP 401 redirects to sign-in; missing/malformed data renders an
  explicit unavailable state. No fixture values enter production.
- `GET /api/session`: missing or unverified sessions return 401; session lookup
  failures return 503 rather than treating valid credentials as invalid.
- `POST /api/organization`: `{ name, slug }`, creates/activates the first org.
  A duplicate slug returns 409; other creation or activation failures return 503. An activation failure can occur after the organization was created.
- `POST /api/billing/checkout`: `{ plan: "pro" }`; `POST /api/billing/portal`:
  `{}`. Both return `{ url }`. Only HTTPS `polar.sh` and `sandbox.polar.sh`
  origins are accepted. Billing authorization remains the API's responsibility.
- Standard BetterAuth `POST /auth/sign-in/email`, `/sign-up/email`, `/sign-out`,
  `/request-password-reset`, `/reset-password`, `/send-verification-email`.
  Signup requires verification and does not assume a session was created.
- Standard BetterAuth organization routes: `GET /auth/organization/list` and
  `POST /auth/organization/set-active`, `/invite-member`, `/accept-invitation`.
  Only Settings loads the additional organization list. Invite role is `member`.
- Email landing routes: `/reset-password?token=...`,
  `/accept-invitation?invitationId=...`. Verification callbacks go to dashboard.

The schemas in `src/http.ts` decode every consumed JSON boundary. They can be
replaced with matching exports from the parent's `@durable-actors/contracts/http` when
integrated. Settings displays existing organization details read-only; no update
API was agreed.

## Request safety

HTML forms require matching Origin and a constant-time checked CSRF token tied
to a host-only, HttpOnly, SameSite=Lax cookie. Theme cookies are also host-only
and HttpOnly; HTTPS origins add Secure. Theme redirects stay on known local
pages and preserve recovery/invitation query parameters. Passwords are never
reflected after errors.

`/api/*` and `/auth/*` proxy only to the configured API origin, use manual
redirects, allowlist request/response headers, retain status/raw body and
individual Set-Cookie headers, and rewrite API-origin redirects to the public
origin. They do not forward Host or X-Forwarded-\* authority headers. Browser
mutation requests require the exact Origin. Local theme/CSRF cookies are not
forwarded to the API. Requests are bounded to 8 seconds and a 1 MiB input body.

## Verification

Package commands: `bun run typecheck`, `bun run test`. Tests cover SSR/XSS,
invalid API payloads, absent API, auth cookies, proxy header authority,
CSRF/Origin failures, theme/query preservation, signup verification, recovery
failure and Polar redirect allowlisting. `bun run test` compiles UI first.

For isolated visual review only, build UI then run `bun src/preview.ts` as a
managed service on port 3002. This read-only fixture uses production rendering
with labeled test data. All mutations deliberately fail. `?empty=1` renders
no-organization state. It is outside the production import graph. Screenshots
are visual coverage, not evidence of real authentication or provider billing.

Pins: FoldKit `0.163.0`, Effect and platform-browser `4.0.0`, StyleX
`0.19.1`, TypeScript `7.0.2`, Vitest `4.1.11`. The published FoldKit package
declares exact rc116 peers and its `foldkit/http` module still imports
`effect/unstable/http`, which Effect 4.0.0 removed. The console imports only
`foldkit/html` and `foldkit/experimental/server`, which typecheck, test and build
on 4.0.0, but the published peer-version mismatch must remain visible.
