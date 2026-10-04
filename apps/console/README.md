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
proxy `/api`, `/auth` and the local Stripe stand-in's `/billing` pages through Vite (the default target is `http://127.0.0.1:3001`). The
accounts backend's `apps/api/README.md` describes its Postgres/API/email-outbox Compose stack.
Set `API_PROXY_TARGET` to its API port and `CONSOLE_ORIGIN` to the console origin. A same-origin
development proxy can also use the console origin as `API_ORIGIN`.

Set `VITE_CONSOLE_FIXTURES=1` before starting/building, or visit `/?fixtures=1`, to run without a
backend. The query flag and its tab storage are honoured only in Vite development mode;
production builds ignore them. `VITE_CONSOLE_FIXTURES=1` is an explicit build-time preview switch.
Sample pages carry a quiet notice and sample-backed controls and record links are read-only. A
live page with one part that fell back to sample data (the overview's latency distribution, an
actor type's activity, the schedules) stays live and carries one quiet notice on that part only;
that part's controls are fixed and it lends nothing to the page's live numbers.
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
pages never start a stream or simulate new turns. The command log is read from receipts, so a
command's time, duration and payload read `—` when unrecorded; untimed commands sort after timed
ones and keep the log's order. Each row shows its shortened command id (full id as the title) and
its caller.

The inspector's Send command dialog accepts JSON and an optional command ID (the contract's
`commandId`, the client idempotency key), shows the actor's result or typed `CommandFailed`
payload, and notes a replayed receipt quietly. Each submission gets one key, chosen when it is
sent: a blank field gets a fresh ID, and a generated ID is reused only while the command and the
payload match what was sent, comparing the parsed JSON with sorted keys the way the control plane
hashes it. So a retry after a lost response or a `503 Unavailable`, even with the payload
reformatted or edited and changed back, runs at most once and answers `replayed`, while changed
input is sent as a new command. An ID the operator typed is always used as typed. Each refusal has its own wording: `409` (the key is bound to other input),
`410 CommandExpired` (the key's retry window closed), `CommandRefused` with the runner's reason,
`503 Unavailable` (send again with the same key) and `502 RunnerDefect`. After a `409`, `410`, an
unusable command ID or `RunnerDefect` the dialog does not offer to resend that submission; clearing the ID or changing the
input makes a new one. The dialog captures the actor's project and environment and closes on every
URL change; navigation can never retarget an old actor address. The inspector shows the actor as
the runner reports it: committed state, generation, receipts (with their `Success` or `Failure`
outcome), events, jobs and the event feed cursor, with no sample notice. What the runner does not
report (turn, owned rows, subscribers, sockets, awake state, runner, region, mailbox, receipt times
and activity) reads as unknown (`—` or an empty state that says it isn't reported), never as zero.
A committed state with an entry that does not decode reads as unreadable rather than as `null`.
Closing Send command after the actor answered reloads a live inspector, so it shows the new state.
A runner-minted receipt id (`v1.<ms>.<ms>.<uuid>`) reads as its uuid's first 8 characters, with the
full id as the cell's title; other ids read unchanged. Receipts show their caller and when the
runner stops answering retries from them, events when their newest one was emitted, and timeline
entries their shortened command id and caller. A caller is the attribution the runner recorded, not
proof of who sent the command, so only its subject's prefix decides the wording and the full
subject stays in the cell's title: a `user:<id>` subject naming the signed-in member reads as their
name (the runtime pages load no member list), other subjects read as written, an `api-key:<id>`
subject reads as `API key …` and its last six characters, and framework deliveries and
unauthenticated callers read `System` and `Anonymous`.
Against an API that cannot inspect actors yet, the inspector still reads the actor's live job
list; an actor that has one keeps the Jobs tab and Send command live while the rest of the page is
sample data. An address the runtime
reports as no actor at all has never received a command, so the inspector offers Send first
command for it; any other missing resource or failure renders as usual.

Deployment detail offers earlier successful deployments in the same environment as rollback
targets and displays `rolledBackFrom` on the newly created deployment. Redeploy starts a new
deployment of the viewed commit, which is built again. Both ask for confirmation, stay disabled
while either is in flight, and show the API's refusal otherwise. On success they open the new
deployment, titled as the API names it (`Rollback to <short sha>: <message>` or `Redeploy <short sha>:
<message>`, always the commit's own message, never an earlier rollback or redeploy title), only if
its page is
still open; after navigating away the console just reports it and refreshes a deployments list or
overview that is open. Signing out or switching project releases the in-flight hold. Rollbacks and redeploys reuse earlier
commits, so the console (overview included) links deployments by id. A deployment URL is read as an
id first; an unknown id is not found, and only a commit-shaped reference (in either case) opens its
newest deployment.
Runner actor counts and CPU the runtime does not measure show `—`, never `0`. The same holds on
every runtime page: a value the runners do not report reads `—`, a whole chart or section reads as
not reported, and a total over values that include an unreported one is itself unknown.

Billing and Usage read the control plane's Stripe-backed records. The plan picker and the plan
comparison come from the API's plan catalog (`/billing/plans`): names, prices, allowances and
overage, with provisional prices labelled as the catalog marks them; the console hardcodes no plan,
and without a catalog it offers none. Only plans the catalog sells through Checkout can be chosen. A
Free organization upgrades through Stripe Checkout in the same tab; a paid one changes plan through
the plan endpoint, which may stay pending until payment succeeds. The billing portal opens in a new
tab and invoice PDFs open in their own. Only `https:` links on Stripe's Checkout, billing, invoice
and pay hosts are opened or linked; the local stand-in's same-origin `/billing` Checkout, portal and
invoice PDF pages are accepted only by the Vite development server, and any other link is refused
with a message (an unlinked PDF still lists its invoice). A spend limit the month's estimate has
already reached waits for an explicit save, because it refuses new commands right away.

The sidebar, the project switcher and invitation previews name the organization's plan from its
tagged `plan`: a known plan by its catalog name (its id, title-cased, while no catalog is loaded),
an organization without a billing account as "no billing", never Free, and a stored plan the
pricing configuration doesn't define as "plan not recognised".

Usage, Overview and Billing show cap state exactly as the API reports it per cap (`refusing`, not
merely `atCap`), with one quiet notice: an organization without a billing account (billing's
`plan` is `unbound`) reads as "Billing isn't set up", never as Free, and its usage is shown without
any plan's allowances, prices or estimates; otherwise the command allowance, a tenant's storage
sample at its cap, the spend limit, then connections, in that order. The command allowance is
quoted in whole commands: the cap's units divided by its `unitsPerCommand` and rounded down, a
read weighing one unit.
Usage also shows the latest storage sample across serving deployments. A `503 Unavailable` whose
`reason` is `unknownPlan` still loads Billing and Usage, which say calmly that the organization's
plan isn't recognised and to contact support, a spend limit refused for it reads as not saved, and
the overview's one notice says new commands are refused, with no Billing link.
Any other `503` from billing or usage is worded as billing being temporarily unreadable, not as a
lost connection. Plan refusals (`QuotaExceeded`, `SpendLimitExceeded`, `ConnectionLimitExceeded`,
`StorageQuotaExceeded`) are read from the cloud API's own typed errors, or from a `CommandRefused`
whose typed `reason` is one, and explained in place with a link to Billing; the console reads only
errors the client decoded, never a payload by its shape. A `402 QuotaUnbound` (the edge has no
organization, billing account or known plan to bill a command to) is worded by its `reason`, is
never resent with the same command ID, and links to Billing only for a missing billing account;
the other reasons say to contact support. In the send dialog every other
`CommandRefused` reason has its own wording; it offers a resend with the same command ID only when
the framework marks the reason retryable, and never for a spent command ID. A `NotFound` is worded from its closed `resource` set.

Actor-type activity and command volumes use `1h`, `24h` or `7d`. The overview latency distribution
requests each actor type's `/latency` histogram at the chosen window and sums counts only when
windows and bucket boundaries match. Its unbounded tail remains explicit and it computes no
combined percentiles; the older overview p50/p99 series stays labelled as 24h. A project-wide
histogram endpoint would avoid the per-type fan-out. Workflow steps are displayed 1-based, and a
finished run whose stored result does not decode has an unknown status (`—`), never Waiting.
Paged inspectors currently load a first page; workflow and audit truncation is labelled. When a
page cursor goes stale (a cursor the server no longer recognises or cannot read), paging starts
again from the first page, and a second stale cursor ends with what was read; it is never reported
as the API being unreachable. Display
times are UTC. The API serves deployments, rollback, redeploy, command sending and actor
inspection from real runners, and the overview, sidebar counts, search (actor types and actor
addresses by prefix, offered in the palette with types first, each linking to its page), actor
types and instances, the command log, jobs, dead letters, workflows and timers from the runners'
durable views. An actor type the deployment does not serve opens the not-found page, without Send
first command; since the runtime reports an unknown type's address as a missing actor, the inspector
reads the type before offering a first command. The overview takes its recent deploys from the
deployments list when it reports none, and says they aren't reported when that list can't be read
either. Type activity, latency histograms, the command stream,
connections, schedules and owned-table listing still answer typed 501s and fall back as described
above. Dead letters can't be retried or discarded yet, so both stay disabled with one quiet reason.

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

`bun run typecheck`, `bun run lint` and `bun run test` here (`vitest.config.ts` compiles StyleX so
view tests render real components); browser flows live in `apps/e2e`
(`bun run --cwd apps/e2e test:e2e`), which builds and previews this app.

FoldKit 0.163 exposes route constructors through a Proxy whose `.make` Effect 4.0 caches with
`defineProperty`, so a second read throws; `navigation/routes.ts` hands `Route.mapTo` plain
`{ make }` wrappers instead.
