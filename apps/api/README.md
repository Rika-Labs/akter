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

This runs `infra/local/compose.yaml`: Postgres 18.6 on `127.0.0.1:55431`, a one-shot `application-database` job that creates the `local_app` database runners migrate into, the API on `http://localhost:3001`, the readable email outbox on `http://localhost:3003`, and the edge on `http://localhost:3002`. Docker must be running. The API is the stack's builder: with `RUNNER_BUILD_CONTEXT` (the repository, mounted read-only at `/source`) and `RUNNER_BUILD_DOCKERFILE` set, every new deployment and redeploy builds the example runner image (`infra/local/runner/Dockerfile`) with the API image's Docker CLI and BuildKit, tags it `akter-build:<deployment id>`, passes the commit's short SHA as `RUNNER_VERSION`, and rolls out the built image id, so nobody records a build by hand. Production refuses `RUNNER_BUILD_CONTEXT`; CI builds hosted images. The API applies Better Auth and control-plane migrations before `/ready` succeeds; the mailbox and the edge start after the API is ready. Source mounts reload the API and mailbox after an edit. Postgres uses a named volume, so accounts and published edge keys survive restarts. The default signing secret, database password and generated edge key are deliberately local-only credentials, never production settings.

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

GitHub and Google OAuth are enabled when `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are configured. Register callbacks at `/auth/callback/github` and `/auth/callback/google`. No live provider sign-in is claimed by local tests.

SSO uses `@better-auth/sso` for SAML and OIDC. Operators provision Enterprise access using the comma-separated `ENTERPRISE_ORGANIZATIONS` organization IDs; no browser can grant itself that capability. Provider mutation routes require a verified session and an owner/admin membership in an enabled organization. Add exact IdP origins to `AUTH_TRUSTED_IDP_ORIGINS`, then register and verify the organization's domain through Better Auth before sign-in. A login rechecks the persisted provider, Enterprise entitlement and exact verified email domain. Implicit linking to existing accounts is disabled. OIDC is proven with a loopback test IdP; SAML and real DNS verification still need provider-specific evidence.

Organization/member/invitation/key mutations use the typed `/api` endpoints, not their raw `/auth/organization/*` or `/auth/api-key/*` equivalents, which are deliberately inaccessible. Team management remains mounted on Better Auth's `/auth/organization/*-team` and team-member endpoints with verified sessions, current owner/admin checks for mutations and request/completion audit entries, and SSO provider mutations are audited the same way; a console team group is not in this contract yet.

API keys are organization-owned, hashed by the Better Auth plugin, and shown in full only at creation. Keys grant `read`, `write` or `admin`, optionally narrowed to a project. An explicit `x-api-key` takes precedence over any session cookie; a wrong key cannot silently fall back to an administrator's session. Each request verifies the key against Postgres and its active control-plane grant, so revocation refuses the next admission immediately. A project-only key cannot enumerate the organization's other projects. Personal account operations require a session.

## Implemented and pending

Implemented: session/me, profile, organizations, members and role changes, invitations, API keys, projects and their three initial environments, environment creation/deletion, user settings, pins, notification settings, and paged organization audit logs. Project/environment changes and API-key revocations commit atomically with their audit entries. Better Auth changes write `requested` and completion entries around Better Auth's separate transaction; an uncompleted request has an unknown outcome, not a fabricated success.

Deployment creation, build results, lifecycle reads, redeploy and rollback are implemented through durable actors. Runtime command sending, actor inspection and actor-job reads reach runners only through the edge with a deployment-bound credential, never the caller's session or key. A command is attributed to the signed-in user (`user:<id>`) or API key (`api-key:<id>`) that sent it; the edge signs that identity as the runner's caller only on the control plane's own credential. Inspection reports `null` for what the runner's inspector does not hold. Runtime inspection/SSE surfaces that require unavailable telemetry, regions and databases, endpoints, environment variables, domains, integrations, usage and Stripe billing retain typed HTTP 501 `NotImplemented` responses. The API does not manufacture metrics or provider data.

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

The local deployment-stack E2E builds two example runner images, migrates isolated databases, starts actual Docker runners and a real edge process, then deploys, rolls forward, rolls back, sleeps and wakes through the public API. It inspects a live actor's state and generation, checks that commands reach the actor as the signed-in user and that a tenant credential cannot claim that user, and runs a second stack whose API builds every deployment itself, through a redeploy of a rollback. It requires Docker and a host Postgres port reachable by containers through `host.docker.internal`; it uses no provider credentials and removes only the exact containers and databases it creates.

`test:stack` also runs the usage-cap E2E, which brings up `infra/local/compose.yaml` under its own Compose project and free ports, deploys the example runner through the API and drives each usage cap over HTTP. It generates its own edge key, and removes its Compose project with its volumes and built images, the containers started from its runner image, and that image.

```sh
TEST_DATABASE_URL=postgres://project:project@127.0.0.1:55433/project \
  bun run --cwd apps/api test:stack
```
