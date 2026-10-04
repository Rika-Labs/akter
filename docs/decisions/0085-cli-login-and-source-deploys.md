# CLI login and source deploys

Status: implementation decision (2026-10-04), issue [#502](https://github.com/Rika-Labs/akter/issues/502).

## Context

`durable login` and `durable deploy` are the first hosted commands in `apps/cli`. Both use `effect/cli` like every other command. The control plane already had the pieces a deploy needs from [ADR 0075](0075-deployment-and-runner-orchestration.md): the `DeploymentLifecycle` actor, the runner provider, and an `ImageBuilds` service. On a control plane configured with a builder (the local Compose stack), `ImageBuilds` turns a Docker build context into an image the runner provider starts. That builder could only build its own mounted context (`RUNNER_BUILD_CONTEXT`), so it couldn't build anything a CLI user had on their machine.

Better Auth is the identity authority ([ADR 0074](0074-open-source-control-plane.md)). The API accepted a browser session cookie or an organization API key, and neither suits a person at a terminal. A cookie needs a browser. An API key belongs to an organization rather than a person, so it can't sign in as the person who runs the CLI.

## Decision

**Login uses Better Auth's device authorization grant.** The API mounts Better Auth's `deviceAuthorization` plugin. It accepts one client id, `akter-cli`, issues codes that expire after 10 minutes, and has clients poll every 5 seconds. The verification page is `<console origin>/device`. `durable login` requests a code, prints the verification URL and user code, and polls `/auth/device/token`. It treats `authorization_pending` as wait, adds five seconds to its interval on each `slow_down`, and ends on `access_denied` (exit 1), `expired_token` (exit 1), or any other refusal (exit 1). The token the grant returns is an ordinary Better Auth session token, so it has a session's expiry, refresh and revocation. `durable logout` signs it out.

**The API accepts that session as a bearer token.** `Authentication` in `@akter/cloud-api` gains a `bearer` security scheme. The handler resolves the session from the bearer token alone, so a cookie sent with the same request can't take its place. As with a cookie, an explicit `x-api-key` header causes a refusal. To support this, the API mounts Better Auth's `bearer` plugin with only its request hook. The plugin's response hook would copy every new session token, including browser sign-ins, into a `set-auth-token` header that scripts can read, so browser sessions would no longer be confined to their HTTP-only cookie. That hook is left out.

**The CLI stores the session in the operating system's configuration directory**, readable only by the user. The directory is `AKTER_CONFIG_DIR` when set. Otherwise it is `~/Library/Application Support/akter` on macOS, `%APPDATA%\akter` on Windows, or `$XDG_CONFIG_HOME/akter` (default `~/.config/akter`) elsewhere. The file is `credentials.json` and holds the API URL, the token and the email address. It's written `0600` inside a `0700` directory. The CLI writes a temporary file beside it and renames it over the old one, so a file that other users could once read is replaced, not rewritten in place. A credentials file that the group or others can read or write is refused, the way `ssh` refuses such a private key.

**Deploy sends the source context to the control plane's builder, not a locally built image.** The existing builder already builds a Docker context into an image the runner provider can start. An uploaded context needed one change: the builder pipes the archive to `docker build -`, where `--file` names a path inside the archive. Nothing has to be pushed to a registry. The flow has four parts:

- `POST /api/projects/:projectId/sources` takes a gzip-compressed tar of up to 64 MiB. It stores the archive once per project, under the SHA-256 of its bytes, in the control-plane database (`cloud_source_archive`), and answers `{ digest, sizeBytes }`. Sending the same bytes again answers the same digest.
- `CreateDeployment` gains an optional `source: { digest, dockerfile }`. The handler records which archive the new deployment is built from (`cloud_deployment_source`) before it creates the deployment, because the build job can start as soon as the deployment exists. A digest the project doesn't hold is `NotFound` with resource `source`.
- The lifecycle's `build` job builds the attached archive. A deployment with no attached archive builds the builder's configured context, as before. A redeploy copies its source deployment's attachment, so it rebuilds the same upload. A rollback reuses the earlier image and builds nothing.
- On a control plane without a builder (every hosted one today), the upload endpoint and a create with `source` both answer `NotImplemented` (501). Nothing is stored, and no deployment is left waiting for a build that will never come.

`durable deploy` packs the context the way `docker build` would send it. It reads `<Dockerfile>.dockerignore` when that file exists, as BuildKit does, and `.dockerignore` otherwise. Patterns are matched with Docker's rules: segment-bound `*` and `?`, `**` across segments, a rule that matches a parent directory applies to everything inside it, the last matching rule wins, and a directory that no exception could reach isn't walked. The Dockerfile is always sent, symbolic links are followed, and file modes aren't kept. The deployment is labeled with `--commit`, otherwise the context's git `HEAD`. When the working tree has uncommitted changes, the message is marked, because the upload holds those changes and the commit doesn't. Outside a repository, the label is the first 40 hex digits of the archive digest. The command then follows the deployment once a second and prints each rollout step as it starts and ends. It exits 0 when the deployment is `live`. It exits 1 when the deployment is `failed`, naming the failed step and why, and printing the build's last 20 lines when the build failed. It also exits 1 when `--timeout` (default 900 seconds) runs out, while the rollout continues.

**Exit statuses** follow [the CLI's convention](../api/06-cli.md): missing, exposed or unreadable credentials and an unreachable control plane are usage errors (exit 2). An expired or revoked session, a refusal from the control plane, a denied or expired login, and a failed or unfinished rollout are refusals (exit 1).

## Alternatives

- **A locally built image recorded with `RecordBuild`.** The CLI would run `docker build` and send the image id. A local `sha256:` id only means something to a runner provider that shares the CLI's Docker daemon. Anything else would need the CLI to push to a registry with credentials it doesn't have. On a control plane that builds, it would also race the build job that every create starts. The CI path ([deploy pipeline](../api/08-deploy-pipeline.md)) stays the way to deploy a prebuilt image.
- **API keys for the CLI.** They are organization-owned and represent the organization, not a person. Commands sent with one would be attributed to `api-key:<id>` instead of the user ([ADR 0082](0082-attributed-console-commands.md)).
- **The operating system keychain.** It would need a native integration on each platform. A file the user alone can read is what `gh`, `gcloud` and `aws` use by default.
- **Object storage for archives.** That needs a provider that the local stack doesn't have. Postgres is enough for contexts of at most 64 MiB on a control plane that builds locally. A hosted builder will need its own storage decision.

## Consequences

- A hosted control plane has no builder, so `durable deploy` against it ends with `NotImplemented` until one exists. CI deploys through `RecordBuild` are unchanged.
- The console has no `/device` page yet. Until it does, a person approves a code by calling Better Auth's `GET /auth/device?user_code=…` and `POST /auth/device/approve` with a signed-in session, which is what the E2E does.
- Archives are kept for as long as the project exists. There's no retention sweep yet.
- The bin is still `durable`. The console copy that says `bunx akter login` and `bunx akter deploy` names a package that hasn't been published.

## Evidence

- `apps/api/src/server.test.ts` runs the device grant over real HTTP and Postgres. It covers wrong client ids, another user approving a claimed code, pending, denied, expired and redeemed codes, bearer sessions on `/api/me` until sign-out, the absence of `set-auth-token` on browser sign-in, and upload and source creation refused on a control plane without a builder.
- `apps/api/src/sources.test.ts` covers content digests, idempotent storage, per-deployment attachment, redeploy copies, and refusal of archives from another project or organization.
- `packages/deployments/src/runners/build.test.ts` builds an uploaded archive instead of the configured context with real Docker, and refuses an archive without its Dockerfile.
- The `apps/cli` unit tests cover credential paths and permissions, the device-grant answers, `.dockerignore` packing, the deploy request sequence, failed builds and failed steps, timeouts, and expired sessions.
- `apps/cli/src/hosted-stack.test.ts` runs against the documented Compose stack. It logs in through the device grant by approving the printed code, deploys an uploaded copy of the example runner's context with a marker file, and checks that the live image holds the marker. It then sends a command with the stored session that reaches the counter as the signed-in user, and logs out, after which the session is refused.

## Revisit when

A hosted builder or a registry-push deploy path ships, the console adds its `/device` page, archive storage needs a retention policy, or the bin is renamed.
