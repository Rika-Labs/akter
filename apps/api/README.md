# Akter control-plane API

`@akter/api` is the long-lived Bun process for the Apache-2.0 cloud control plane. Its browser-safe contract is `@akter/cloud-api`: derive an Effect `HttpApiClient` from `CloudApi` and send browser cookies with `credentials: "include"`, or an organization-owned key in `x-api-key`.

## Local stack

The edge refuses to start without `EDGE_SIGNING_KEYS`, a JSON array of Ed25519 private JWKs `{ kid, x, d }`. Generate a local-only key into your shell, never into a committed file, and don't print or paste it into issues or logs:

```sh
export EDGE_SIGNING_KEYS="$(bun -e 'const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]); const { x, d } = await crypto.subtle.exportKey("jwk", k.privateKey); console.log(JSON.stringify([{ kid: `local-${crypto.randomUUID()}`, x, d }]))')"
```

Then, from the repository root and in the same shell:

```sh
bun run dev
```

This runs `infra/local/compose.yaml`: Postgres 18.6 on `127.0.0.1:55431`, a one-shot `application-database` job that creates the `local_app` database runners migrate into, the API on `http://localhost:3001`, the readable email outbox on `http://localhost:3003`, and the edge on `http://localhost:3002`. Docker must be running. The API is the stack's builder: with `RUNNER_BUILD_CONTEXT` (the repository, mounted read-only at `/source`) and `RUNNER_BUILD_DOCKERFILE` set, every new deployment and redeploy builds the example runner image (`infra/local/runner/Dockerfile`) with the API image's Docker CLI and BuildKit, tags it `akter-build:<deployment id>`, passes the commit's short SHA as `RUNNER_VERSION`, and rolls out the built image id, so nobody records a build by hand. A deployment created by `akter deploy` names an uploaded build context instead, which the API stores in `cloud_source_archive` and pipes to `docker build -`. Against this stack, run `akter login --api-url http://localhost:3001` once, then `akter deploy --project <id> --dockerfile <path>` from the application's directory. Production refuses `RUNNER_BUILD_CONTEXT`; CI builds hosted images. The API applies Better Auth and control-plane migrations before `/ready` succeeds; the mailbox and the edge start after the API is ready. Source mounts reload the API and mailbox after an edit. Postgres uses a named volume, so accounts and published edge keys survive restarts. The default signing secret, database password and generated edge key are deliberately local-only credentials, never production settings.

The edge publishes each key's public half at startup and signs only with a key published for `EDGE_PUBLICATION_LEAD`, default `5 minutes`, the runners' default key-set refresh interval. Until then the edge refuses authenticated requests with `ActorUnavailable` ("No signing key is usable"), so a fresh key leaves the stack unable to serve deployments for five minutes. Reuse the same `EDGE_SIGNING_KEYS` value across restarts: its `kid` stays published in the volume and keeps its age, while a new key restarts the wait. A `kid` names one key for good, so never put a different key under a published `kid`; the edge refuses to start. For local development only, you may shorten the lead, for example `EDGE_PUBLICATION_LEAD="0 seconds" bun run dev`. Fresh runners fetch the published key set, but warm runners rate-limit unknown-key refreshes to once per minute and can temporarily refuse a rotated key. Keep the default in production and ensure the lead covers every runner's configured refresh interval.

If those ports are already in use, choose free ones first. On a shared Docker daemon use a unique Compose project and never remove somebody else's containers or volumes:

```sh
CONTROL_PLANE_PG_PORT=55431 API_HTTP_PORT=55432 EDGE_HTTP_PORT=55434 OUTBOX_HTTP_PORT=55433 \
  API_ORIGIN=http://localhost:55432 \
  docker compose -p akter-cp-local -f infra/local/compose.yaml up --build
```

Stop only that project with the same `-p` and file arguments. `down` preserves its database volume; adding `-v` deletes only that project's local data and should be intentional.

The console runs separately with its own Vite command. Compose sets `CONSOLE_ORIGIN` to `http://localhost:5173` unless you override it; set it to the console's exact origin. It is the one credentialed browser origin besides `API_ORIGIN` and the base of every link in invitation, verification and password-reset email. When it is unset, the API serves the console itself behind one origin and those links use `API_ORIGIN`. `bun run dev:apps` preserves the monorepo's former Turbo development path. A same-origin reverse proxy is recommended outside local development.

For a host Bun process instead of a container:

```sh
bun install
CONTROL_PLANE_DATABASE_URL=postgres://project:project@127.0.0.1:55431/project \
  AUTH_SECRET=local-development-only-change-before-production \
  API_ORIGIN=http://localhost:3001 EMAIL_MODE=local \
  bun run --cwd apps/api dev
```

## Authentication

Better Auth is mounted at `/auth`. Email/password sign-up requires verification and a password of at least 12 characters. Read the latest verification or reset link in the local outbox JSON and open it; links are credentials, so the mailbox is loopback-only by default, disabled in production, and must never be deployed publicly. Wrong passwords and unverified accounts receive no session. Password resets revoke existing sessions.

The `akter` CLI signs in through Better Auth's device authorization grant (`/auth/device/code`, `/auth/device/token`) with the client id `akter-cli`. `akter login` prints `<console>/device` and the code; a signed-in person opens that page in the console, which looks the code up with `GET /auth/device?user_code=…` (binding it to the viewer) and approves or denies it with `POST /auth/device/approve` or `/deny` and `{ userCode }`. Codes are Better Auth's default 8 characters; the CLI and console show them `XXXX-XXXX`, and the dash is display only. The approved session starts in the approver's active organization and, like `gh` or `vercel` tokens, acts in every organization its user belongs to, with membership checked on every request. A `/device/code` request naming `user_id` is refused, a signed-in lookup of a code another account claimed is `access_denied`, and `/device` lookups are limited to 20 per 10 minutes per address when rate limiting is on. The token the grant returns is a session token the API accepts as `Authorization: Bearer`, alone: the cookie and API-key schemes refuse any request that carries `Authorization`. `POST /auth/sign-out` with it revokes it. Better Auth's `set-auth-token` response header is not emitted, so browser sessions stay in their HTTP-only cookie.

Source uploads (`POST /api/projects/:id/sources`) check access and the builder before reading the body, refuse a body over 64 MiB with 413 as soon as its length says so or its stream passes it, and are stored without retention or quota. The local builder walks an upload's tar headers before Docker sees it (512 MiB unpacked, 100,000 entries at most), stops a build after 15 minutes, and shares one Docker daemon and build cache across tenants, so it is for local development only; a hosted builder needs per-tenant isolation and archive retention first ([ADR 0085](../../docs/decisions/0085-cli-login-and-source-deploys.md)).

GitHub and Google OAuth are enabled when `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are configured. Register callbacks at `/auth/callback/github` and `/auth/callback/google`. No live provider sign-in is claimed by local tests.

SSO uses `@better-auth/sso` for SAML and OIDC. Operators provision Enterprise access using the comma-separated `ENTERPRISE_ORGANIZATIONS` organization IDs; no browser can grant itself that capability. Provider mutation routes require a verified session and an owner/admin membership in an enabled organization. Add exact IdP origins to `AUTH_TRUSTED_IDP_ORIGINS`, then register and verify the organization's domain through Better Auth before sign-in. A login rechecks the persisted provider, Enterprise entitlement and exact verified email domain. Implicit linking to existing accounts is disabled. OIDC is proven with a loopback test IdP; SAML and real DNS verification still need provider-specific evidence.

Organization/member/invitation/key mutations use the typed `/api` endpoints, not their raw `/auth/organization/*` or `/auth/api-key/*` equivalents, which are deliberately inaccessible. Team management remains mounted on Better Auth's `/auth/organization/*-team` and team-member endpoints with verified sessions, current owner/admin checks for mutations and request/completion audit entries, and SSO provider mutations are audited the same way; a console team group is not in this contract yet.

API keys are organization-owned, hashed by the Better Auth plugin, and shown in full only at creation. Keys grant `read`, `write` or `admin`, optionally narrowed to a project. An explicit `x-api-key` takes precedence over any session cookie; a wrong key cannot silently fall back to an administrator's session. Each request verifies the key against Postgres and its active control-plane grant, so revocation refuses the next admission immediately. A project-only key cannot enumerate the organization's other projects. Personal account operations require a session.

## Implemented and pending

Implemented: session/me, profile, organizations, members and role changes, invitations, API keys, projects and their three initial environments, environment creation/deletion, user settings, pins, notification settings, and paged organization audit logs. Project/environment changes and API-key revocations commit atomically with their audit entries. Better Auth changes write `requested` and completion entries around Better Auth's separate transaction; an uncompleted request has an unknown outcome, not a fabricated success.

Deployment creation, build results, source uploads, lifecycle reads, redeploy and rollback are implemented through durable actors. Runtime command sending and every runtime read (overview, sidebar counts, search, actor types and instances, one actor and its receipts, events, jobs and timeline, the command log, jobs, dead letters, workflows and timers) reach runners only through the edge with a deployment-bound credential, never the caller's session or key, and read the runner's read-only inspector. A command is attributed to the signed-in user (`user:<id>`) or API key (`api-key:<id>`) that sent it; the edge signs that identity as the runner's caller only on the control plane's own credential. Inspection reports `null` for what the runner's inspector does not hold, and receipts carry the caller the runner recorded. Runtime surfaces that require unavailable telemetry (activity, latency, the live stream, connections and schedules), owned-table rows, dead-letter retry and discard, regions and databases, endpoints, environment variables, domains, integrations, usage and Stripe billing retain typed HTTP 501 `NotImplemented` responses. The API does not manufacture metrics or provider data.

## Email

`EMAIL_MODE=local` writes `cloud_email_outbox` rows, readable in tests and at the local mailbox. `EMAIL_MODE=ses` sends through the exact `@distilled.cloud/aws@1.0.0-rc.13` SESv2 client. Set `EMAIL_FROM`, an AWS region and credentials using the Distilled credential chain (ECS task roles in production). SES is typechecked; no actual SES sending is claimed without a verified sender and provider evidence.

Production requires `API_PRODUCTION=true`, SES delivery, a securely provisioned `AUTH_SECRET` that is not the published Compose secret, the Neki control-plane database URL and explicit public https `API_ORIGIN`, `CONSOLE_ORIGIN` (when the console has its own origin) and `AUTH_TRUSTED_IDP_ORIGINS`; startup fails on any other value. `API_PRODUCTION=true` also enables Better Auth's in-memory rate limiter, which counts per process and per client address, so put a shared limiter at the edge and have it set a trustworthy forwarded-address header. `API_HOST` controls binding; Compose binds inside its container and publishes only loopback ports. Request-path logging is disabled so verification/reset query tokens never enter access logs.

## Evidence

Use a new Postgres instance that you own and a free port. Integration tests fail if `TEST_DATABASE_URL` is absent; they do not silently skip. Auth and repository suites create and drop isolated test databases. The HTTP suite uses unique account/organization IDs in the supplied database.

```sh
bun run typecheck
bun run lint
bun run format:check
bun run --cwd packages/cloud-api test
bun run --cwd apps/api test
TEST_DATABASE_URL=postgres://project:project@127.0.0.1:55430/postgres \
  bun run --cwd apps/api test:integration
```

The HTTP suite exercises actual Bun HTTP and Postgres: verification through stored email, wrong passwords, organization/invitation isolation, control-plane persistence, key hashing, scope, expiry, denied writes, audit rollback and immediate revocation. The OIDC suite runs discovery, redirects, PKCE, signed tokens and userinfo through an actual test IdP; forged/replayed state, invalid tokens, cross-domain identities, unverified providers and non-Enterprise sign-ins are refused. Real Neki, AWS, SES, GitHub/Google and SAML support remain unverified.

The local deployment-stack E2E builds two example runner images, migrates isolated databases, starts actual Docker runners and a real edge process, then deploys, rolls forward, rolls back, sleeps and wakes through the public API. It inspects a live actor's state and generation, checks that commands reach the actor as the signed-in user and that a tenant credential cannot claim that user, reads a second actor type's overview, types, instances, receipts with their callers, events, timeline, jobs, dead letters, workflows and timers against the runner database's own rows while another organization is refused, and runs a second stack whose API builds every deployment itself, through a redeploy of a rollback. It requires Docker and a host Postgres port reachable by containers through `host.docker.internal`; it uses no provider credentials and removes only the exact containers and databases it creates.

`test:stack` also runs the usage-cap E2E, which brings up `infra/local/compose.yaml` under its own Compose project and free ports, deploys the example runner through the API and drives each usage cap over HTTP. It generates its own edge key, and removes its Compose project with its volumes and built images, the containers started from its runner image, and that image.

```sh
TEST_DATABASE_URL=postgres://project:project@127.0.0.1:55433/project \
  bun run --cwd apps/api test:stack
```

`bun run --cwd apps/cli test:stack` brings the same Compose stack up under its own project and ports, logs `akter login` in by approving the code it prints, deploys an uploaded copy of the example runner's context carrying a marker file, checks the live image holds the marker, sends a command with the CLI's stored session and logs out. It removes its Compose project, the deployment's containers and the image built for it.
