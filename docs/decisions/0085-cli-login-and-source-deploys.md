# CLI login and source deploys

Status: implementation decision (2026-10-04), issue [#502](https://github.com/Rika-Labs/akter/issues/502).

## Context

`akter login` and `akter deploy` are the first hosted commands in `apps/cli`. Both use `effect/cli` like every other command. The control plane already had the pieces a deploy needs from [ADR 0075](0075-deployment-and-runner-orchestration.md): the `DeploymentLifecycle` actor, the runner provider, and an `ImageBuilds` service. On a control plane configured with a builder (the local Compose stack), `ImageBuilds` turns a Docker build context into an image the runner provider starts. That builder could only build its own mounted context (`RUNNER_BUILD_CONTEXT`), so it couldn't build anything a CLI user had on their machine.

Better Auth is the identity authority ([ADR 0074](0074-open-source-control-plane.md)). The API accepted a browser session cookie or an organization API key, and neither suits a person at a terminal. A cookie needs a browser. An API key belongs to an organization rather than a person, so it can't sign in as the person who runs the CLI.

## Decision

**The bin is `akter`.** The `apps/cli` bin, called `durable` until now, is renamed `akter` to match the product and the console's copy. Its commands, flags and exit statuses are unchanged. Error messages in `@rikalabs/akter` that tell an operator which command to run now name `akter`. Accepted ADRs and the milestone history keep the old name.

**Login uses Better Auth's device authorization grant.** The API mounts Better Auth's `deviceAuthorization` plugin. It accepts one client id, `akter-cli`, issues codes that expire after 10 minutes, and has clients poll every 5 seconds. The verification page is the console's `/device` page ([#601](https://github.com/Rika-Labs/akter/pull/601)), at `<console origin>/device`. `akter login` requests a code and prints that page with the user code written `XXXX-XXXX`. It doesn't print `verification_uri_complete`, because a link that carries the code would let anyone the link reaches approve it with one click. The CLI then polls `/auth/device/token` at the interval the server names. It treats `authorization_pending` as wait and adds five seconds on each `slow_down`. It ends on `access_denied` (exit 1), on `expired_token` or its own deadline (exit 1), or on any other refusal (exit 1). The token the grant returns is an ordinary Better Auth session token, so it has a session's expiry, refresh and revocation. If `/api/me` fails right after the grant, the CLI signs the token out again and stores nothing. `akter logout` signs it out.

The API adds a small Better Auth plugin for policy that the device plugin leaves to its host:

- `/device/code` refuses `user_id`, in JSON or form encoding. The plugin would otherwise let an unauthenticated caller bind a new code to any account.
- A signed-in lookup of a pending code that another account already claimed is refused with `access_denied` (403). Without this, it answers a status with the client hidden.
- An approval records the approver's active organization. The session the code then redeems starts in that organization, so `activeOrganizationId` matches the browser session that approved it.
- `/device` lookups are limited to 20 per 10 minutes per address, up from the plugin's 5. A person may look a code up several times while the page reloads. Rate limits are enforced in production.

**CLI tokens act across all of a user's organizations.** This is deliberate and works like `gh` or `vercel` tokens. A device session is a session of the person who approved it, not of one organization. Every request checks membership and role for the organization or project it names, exactly as for the browser session, so leaving an organization takes effect on the next request.

**The API accepts that session as a bearer token, and a bearer token alone.** `Authentication` in `@akter/cloud-api` gains a `bearer` security scheme. Effect runs every scheme on every request, and Better Auth's bearer hook acts inside the cookie lookup. So the cookie and API-key schemes refuse any request that carries `Authorization`. Only the bearer scheme can answer it, and it resolves the session from the token alone. An invalid bearer token is therefore 401, not the cookie user next to it, and an `x-api-key` sent beside a bearer token is refused. The API mounts Better Auth's `bearer` plugin with only its request hook. The plugin's response hook would copy every new session token, including browser sign-ins, into a `set-auth-token` header that scripts can read, and browser sessions would no longer be confined to their HTTP-only cookie.

**The CLI sends a token only over https, or over http to this machine.** `--api-url` must be `https`, or `http` to a loopback host (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`), with no user info or query. Anything else is refused before a request is sent. Stored credentials naming any other URL are refused as unreadable.

**The CLI stores the session in the operating system's configuration directory**, readable only by the user. The directory is `AKTER_CONFIG_DIR` when set. Otherwise it is `~/Library/Application Support/akter` on macOS, `%APPDATA%\akter` on Windows, or `$XDG_CONFIG_HOME/akter` (default `~/.config/akter`) elsewhere. The file is `credentials.json` and holds the API URL, the token and the email address. It's written `0600` inside a `0700` directory. The CLI creates it under a random temporary name, refusing a name that already exists, and renames it over the old file. A file that other users could once read is replaced, not rewritten in place, and a failed write leaves no copy behind. A credentials file that the group or others can read or write is refused, the way `ssh` refuses such a private key. The exception is `logout`, which reads such a file to revoke its token, because that token may have leaked.

**Deploy sends the source context to the control plane's builder, not a locally built image.** The existing builder already builds a Docker context into an image the runner provider can start. An uploaded context needed one change: the builder pipes the archive to `docker build -`, where `--file` names a path inside the archive. Nothing has to be pushed to a registry. The flow has four parts:

- `POST /api/projects/:projectId/sources` takes a gzip-compressed tar of up to 64 MiB. Access and the presence of a builder are checked before any byte is read. A `content-length` over the limit is refused with 413 `PayloadTooLarge` unread. A streamed body is read in chunks and cut off with 413 as soon as it passes the limit. The archive is stored once per project, under the SHA-256 of its bytes, in the control-plane database (`cloud_source_archive`), and the endpoint answers `{ digest, sizeBytes }`. Sending the same bytes again answers the same digest.
- `CreateDeployment` gains an optional `source: { digest, dockerfile }`. The handler records which archive the new deployment is built from (`cloud_deployment_source`) before it creates the deployment, because the build job can start as soon as the deployment exists. A digest the project doesn't hold is `NotFound` with resource `source`.
- The lifecycle's `build` job builds the attached archive. A deployment with no attached archive builds the builder's configured context, as before. A redeploy copies its source deployment's attachment, so it rebuilds the same upload. A rollback reuses the earlier image and builds nothing.
- On a control plane without a builder (every hosted one today), the upload endpoint and a create with `source` both answer `NotImplemented` (501). Nothing is read or stored, and no deployment is left waiting for a build that will never come.

Before Docker sees an uploaded context, the builder decompresses it as a stream and walks its tar headers without keeping the contents. It refuses a context that isn't a valid gzip-compressed tar, one that unpacks past 512 MiB, and one with more than 100,000 entries. A build is stopped after 15 minutes, which interrupts the Docker CLI and so ends its BuildKit session. Only the last 400 lines of output are held while it runs.

`akter deploy` packs the context the way `docker build` would send it. It reads `<Dockerfile>.dockerignore` when that file exists, as BuildKit does, and `.dockerignore` otherwise. Patterns are matched with Docker's rules: segment-bound `*` and `?`, `**` across segments, a rule that matches a parent directory applies to everything inside it, the last matching rule wins, and a directory that no exception could reach isn't walked. The Dockerfile is always sent and must be a regular file. `--dockerfile` is cleaned, and a path that starts with `/` or contains `..` is refused. Symbolic links are sent as tar link entries and never followed. A link to a secret outside the context uploads only the link's text, never the secret, and a link loop can't recurse. Files keep their permission bits. Owners and times are zeroed, so the same files pack to the same bytes and the same digest. Paths longer than a ustar field are carried in PAX headers.

The deployment is labeled with `--commit`, otherwise the context's git `HEAD`. When the working tree has uncommitted changes, the message is marked, because the upload holds those changes and the commit doesn't. Outside a repository, the label is the first 40 hex digits of the archive digest. The command then follows the deployment once a second and prints each rollout step as it starts and ends. It exits 0 when the deployment is `live`. It exits 1 when the deployment is `failed`, naming the failed step and why, and printing the build's last 20 lines when the build failed. It also exits 1 when `--timeout` (default 900 seconds) runs out, while the rollout continues.

**Exit statuses** follow [the CLI's convention](../api/06-cli.md): missing, exposed or unreadable credentials, a refused `--api-url` or `--dockerfile`, and an unreachable control plane are usage errors (exit 2). An expired or revoked session, a refusal from the control plane, a denied or expired login, and a failed or unfinished rollout are refusals (exit 1).

## Alternatives

- **A locally built image recorded with `RecordBuild`.** The CLI would run `docker build` and send the image id. A local `sha256:` id only means something to a runner provider that shares the CLI's Docker daemon. Anything else would need the CLI to push to a registry with credentials it doesn't have. On a control plane that builds, it would also race the build job that every create starts. The CI path ([deploy pipeline](../api/08-deploy-pipeline.md)) stays the way to deploy a prebuilt image.
- **API keys for the CLI.** They are organization-owned and represent the organization, not a person. Commands sent with one would be attributed to `api-key:<id>` instead of the user ([ADR 0082](0082-attributed-console-commands.md)).
- **Tokens scoped to one organization.** This would need a grant extension and an organization picker at approval. Per-request membership checks already bound what a token can reach, and that matches the tools developers already use.
- **The operating system keychain.** It would need a native integration on each platform. A file the user alone can read is what `gh`, `gcloud` and `aws` use by default.
- **Following symbolic links, as the first version did.** That uploaded whatever a link pointed at, including files outside the context, and recursed on loops. Docker itself sends links as links.
- **Object storage for archives.** That needs a provider that the local stack doesn't have. Postgres is enough for contexts of at most 64 MiB on a control plane that builds locally. A hosted builder will need its own storage decision.

## Consequences

- A hosted control plane has no builder, so `akter deploy` against it ends with `NotImplemented` until one exists. CI deploys through `RecordBuild` are unchanged.
- The deferred risks for a hosted builder are:
  - Any tenant can make the builder run a Dockerfile of their choice. The local builder shares one Docker daemon and one BuildKit cache across tenants, which is acceptable only on a developer's machine. A hosted builder needs per-tenant isolation (separate builders or sandboxed BuildKit workers), and its cache must not be shared across tenants.
  - Archives are kept for as long as the project exists, with no retention sweep and no per-organization quota, so they grow without bound. A hosted builder needs retention tied to deployments and a storage quota.
  - Uncompressed-size and entry limits are checked before a build, but nothing bounds the build's own disk, memory or network use beyond the 15-minute timeout.
- The bin's npm package isn't published. The console copy says `bunx akter login`, which names a package that doesn't exist yet.

## Evidence

- `apps/api/src/server.test.ts` runs the device grant over real HTTP and Postgres:
  - It refuses `user_id` binding, in JSON and form encoding.
  - A signed-in lookup binds an unclaimed code to the viewer, an anonymous one binds nobody, and a lookup of another account's pending code is `access_denied`.
  - Another user's approval is refused, and approval yields a session in the approver's active organization (none when the approver has none).
  - Denied, expired and redeemed codes yield no session.
  - Bearer sessions work on `/api/me` until sign-out, and browser sign-in has no `set-auth-token` header.
  - It also checks bearer precedence: a cookie with an invalid bearer token is 401, a cookie with another user's bearer token is that user, and an API key with a bearer token is 401. Uploads to a control plane without a builder answer 501 while the body stalls. On a control plane with a builder, a declared or streamed body over the limit answers 413 at once, access is refused before the body is read, and a small archive is stored under its digest.
- `apps/api/src/auth.test.ts` shows twenty `/device` lookups allowed from one address in production mode and the twenty-first refused with 429.
- `apps/api/src/sources.test.ts` covers content digests, idempotent storage, per-deployment attachment, redeploy copies, and refusal of archives from another project or organization.
- `packages/deployments/src/runners/build.test.ts` builds an uploaded archive with real Docker and refuses an archive without its Dockerfile. With a stand-in Docker binary, it shows that non-gzip, non-tar, oversized and over-counted contexts are refused before Docker runs, that output is kept to its last 400 lines, and that a build over its timeout is stopped and its process killed.
- The `apps/cli` unit tests cover:
  - credential paths, permissions and atomic writes
  - `--api-url` and stored-URL refusal
  - logout of an exposed file
  - the device-grant answers, with polling at the named interval, five seconds slower after `slow_down`, the local deadline, and revocation when `/api/me` fails
  - `.dockerignore` packing, symbolic links outside the context and in loops, permission bits, long paths and reproducible bytes, checked with the system `tar`
  - `--dockerfile` cleaning and refusal
  - the deploy request sequence, failed builds and steps, timeouts, and expired sessions
- `apps/cli/src/hosted-stack.test.ts` runs against the documented Compose stack. It logs in through the device grant by approving the printed code and deploys an uploaded copy of the example runner's context with a marker file. It checks that the live image holds the marker and sends a command with the stored session, which reaches the counter as the signed-in user. It then logs out, after which the session is refused.

## Revisit when

A hosted builder or a registry-push deploy path ships, archive storage needs a retention policy, organization-scoped CLI tokens are wanted, or the bin is published.
