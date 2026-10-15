# Changelog

## 0.2.2 (2026-10-15)

The CLI and framework release together at `0.2.2` on the `latest` npm dist-tag; see the [framework changelog](https://github.com/Rika-Labs/akter/blob/main/packages/akter/CHANGELOG.md). Pin both packages to the same version.

- No CLI changes. `akter fork` of a position older than retained history now reports a retention refusal instead of `CorruptSegment`, through the framework's 0.2.2 fix.

## 0.2.1 (2026-10-14)

The CLI and framework release together at `0.2.1` on the `latest` npm dist-tag; see the [framework changelog](https://github.com/Rika-Labs/akter/blob/main/packages/akter/CHANGELOG.md). Pin both packages to the same version.

- No CLI changes. This release ships alongside the framework's 0.2.1 storage fixes: drains no longer serialize their checkpoints, and a stranded publication epoch expires after 60 seconds.

## 0.2.0 (2026-10-14)

The CLI and framework release together at `0.2.0` on the `latest` npm dist-tag; see the [framework changelog](https://github.com/Rika-Labs/akter/blob/main/packages/akter/CHANGELOG.md). Pin both packages to the same version.

- Adds `akter dev`, which serves a default-exported `App.make(...)` over a filesystem store, and `akter storage check`, which probes a directory or S3-compatible bucket for the store protocol and reports a verdict per probe.
- Adds the audited operator commands `inspect actor`, `inspect shard`, `log tail`, `log export`, `snapshot`, `fork`, `replay` and `retention`. Each needs its own operator capability. The 0.1 SQL inspector, receipt and repair commands are removed; there is no `migrate` or `adopt` command.
- **Breaking cloud contract:** `Environment.database` is removed from `@rikalabs/akter-cli/cloud-api`. An environment is `{ name, projectId, currentDeploymentId }`; a hosted application's data lives in its environment's store bucket, so there is no database status to report. A response that still carries `database` has the field dropped by the default decode and refused by a strict one (`onExcessProperty: "error"`). `ProjectRegion.database` is unchanged.
- `akter deploy` no longer reads the environment after the rollout is live or prints the database report (the p50 latency warning and `Database runner cap`). Its last output is `Deployment <id> is live in <environment>`.
- `DATABASE_URL` is an ordinary customer variable with no platform meaning; removing it refuses no deployment.

## 0.1.0-alpha.6 (2026-10-11)

The CLI and framework release together on the `alpha` and `latest` npm dist-tags. CLI credential storage is unchanged; the matching framework adds `0034_cold_tier`, `0035_hot_table_foreign_keys` and opt-in cold objects. Rolling-upgrade safety from alpha.5 is **not established**; see the [framework changelog](https://github.com/Rika-Labs/akter/blob/main/packages/akter/CHANGELOG.md) and [alpha upgrade notes](https://docs.akter.dev/operations/alpha-upgrades) before upgrading runners.

- Adds the environment application-key contract to `@rikalabs/akter-cli/cloud-api`: `EnvironmentApiKeysGroup`, `EnvironmentApiKeyTenant`, `EnvironmentApiKey`, `CreateEnvironmentApiKey` and `CreatedEnvironmentApiKey`, composed into `CloudApi`. The additive routes create, list and revoke keys under `/api/projects/:projectId/environments/:environment/api-keys`; only creation returns `{ key, secret }`, while list returns metadata including revoked keys and revoke returns 204. These keys authenticate the deployed application, not the control plane; see the [environment API keys contract](https://docs.akter.dev/api/09-environment-api-keys).
- Adds `akter keys create <name> [--tenant <tenant>]`, `akter keys list` and `akter keys revoke <keyId>`, using stored control-plane credentials, `--project` (default `AKTER_PROJECT`) and `--env` (default `production`). An omitted tenant selects `default`; supplied tenants are validated. Create writes only the one-time secret to stdout and a save-now warning to stderr. List prints tab-separated metadata, never secrets; revoke confirms only server success. Metadata output strips terminal escapes and replaces control, line-separator and bidirectional characters without changing requests. Protect redirected secret output and keep it out of shared logs; see [CLI usage](https://docs.akter.dev/api/06-cli#akter-keys).
- Clarifies the cloud database report's four-session runner budget and rollout overlap; its wire schema is unchanged. Environment-key contract and CLI tests establish public client encoding, decoding and output, not cloud database authorization or edge authentication. Logs-follow interruption tests now wait for an actual outstanding HTTP poll before checking cancellation; production follow behavior is unchanged.

## 0.1.0-alpha.5 (2026-10-09)

- Releases with the matching alpha.5 framework, which adds the supported four-session `Database.postgres({ url, preset: "low-connection" })` preset. CLI behavior and the bundled `@rikalabs/akter-cli/cloud-api` contract are unchanged from alpha.4.

## 0.1.0-alpha.4 (2026-10-09)

- **Breaking cloud contract:** every environment uses customer Postgres through `DATABASE_URL`. `Environment.database`, when reported, is `{ source: "customer", state: "missing" | "reachable" | "unreachable", latency, latencyWarning, runnerCap }`. Latency is nullable p50 milliseconds; runner cap is a nullable integer. The managed source and provisioning, ready, read-only and failed states are removed.
- **Breaking billing contract:** base subscription plus compute unit-hours only. Removes storage allowances, caps, overage prices, meters, samples, per-project storage usage and managed database features. `QuotaExceeded.cap` is now `compute`, `connections` or `spend`; storage is no longer a quota. All types remain derived from Effect schemas at `@rikalabs/akter-cli/cloud-api`.
- `akter env list` prints names and update times without a `managed` marker. After a deployment reaches `live`, `akter deploy` confirms success and reads the database report, printing its latency warning and non-null runner cap, including zero, only for the completed rollout. A p50 above 5 ms warns without refusing the deployment; unknown measurements stay unknown. Failed or superseded diagnostic reads warn without changing the successful exit status.
- `akter deploy` keeps following a rollout through a brief control-plane outage. Transport failures, typed `Unavailable` (503) answers without a known `reason` and unreadable 5xx answers such as a proxy's 502 are retried with the delays `logs --follow` uses (1, 2, 4, then 8 seconds), and six consecutive failed reads stop it as before. Refusals, including an ended session, are never retried.
- The cloud API contract's `Authentication` middleware declares `Unavailable` (503) alongside `Unauthorized` and `Forbidden`, so every endpoint, including `/api/me`, decodes a session-store outage as a typed `Unavailable`. `akter whoami` then reports a temporary outage (exit 1) instead of an unreachable control plane (exit 2), and never asks you to log in again. This is additive for `/cloud-api` consumers; a server may now fail authentication with `Unavailable`.

## 0.1.0-alpha.3 (2026-10-08)

The first CLI release, versioned with `@rikalabs/akter` on the `alpha` and `latest` dist-tags. This includes the unpublished alpha.2 draft and the final launch contract.

- Publishes as `@rikalabs/akter-cli` with the `akter` executable, compiled ESM and declarations for Node 24+ and Bun 1.4.2+. The inspector client is prebuilt; Node users do not need Bun. The private cloud API contract is bundled, not separately published.
- Exposes the cloud API contract as `@rikalabs/akter-cli/cloud-api`, with compiled JavaScript and declarations for npm consumers; importing it does not execute the CLI. Tagged pre-1.0 releases also advance `latest`, while verified main canaries publish only to `next`.
- Includes local `akter dev`, cloud login/logout/whoami, source deployment and `akter env list`, `set`, `unset` and `import`.
- Uses the matching alpha.3 framework and Effect/platform/SQL 4.0.2 cohort. Postgres and PGlite are the only framework backends; Neki is removed.
- **Breaking cloud contract:** environment databases report `{ source, state }`, without engine or Neki mode fields. Billing schemas remove command/read allowances and meters and deprecated compatibility fields, using compute unit-hours and pooled managed database storage. Hosted quota refusals use `QuotaExceeded.cap`; the separate spend, connection and storage quota errors are removed, and only a connections-cap refusal is retryable. Update applications importing `/cloud-api` to the new schema.
- **Breaking:** operator commands read `AKTER_OPERATOR_TOKEN`, not `DURABLE_OPERATOR_TOKEN`. There is no implicit alias; set the new variable or use `--token-env`.
- **Breaking:** the local inspector page and API use `/_akter/inspector`, not `/_durable/inspector`. Update bookmarks and requests.
- **Breaking:** hosted source deploys load `src/app.ts` with a generated Dockerfile; the API refuses `source.dockerfile`.
- Login defaults to `https://api.akter.dev`; select a preview or local API explicitly with `--api-url` or `AKTER_API_URL`.
- Adds `akter logs` to read customer runner output for a project (`--project`, default `AKTER_PROJECT`) and an environment (`--env`, default `production`) or one `--deployment`. `--since` takes 1 to 3600 seconds (default 300), and the server clamps the requested time into the last hour. `--limit` takes 1 to 200 lines per page (default 100), not a total. Without `--follow` it reads every page in the window and exits; `--follow` drains available pages at once, then long-polls for up to 20 seconds. Follow resumes from the last successful cursor after transport failures and typed `Unavailable` (503) responses, with capped exponential delays, and stops after six failed requests in a row. Authentication, authorization, missing-resource and unsupported-operation refusals are not retried. Ctrl-C cancels the request and exits with code 130. Control characters, Unicode line separators and bidirectional-formatting characters are replaced, and a trailing `…` marks a line clipped at 4096 UTF-8 bytes. Fly merges stdout and stderr, so its lines show stream `unknown`. Output is recent only and expired provider output cannot be recovered; build output is not included. See the [logs API contract](https://github.com/Rika-Labs/akter/blob/main/docs/api/07-cloud-logs.md).
- The initial CLI tarball still needs a one-time maintainer publish and trusted-publisher setup; subsequent releases use the OIDC-only `release.yml` workflow. Bumping the version does not publish it.

See the [framework changelog](https://github.com/Rika-Labs/akter/blob/main/packages/akter/CHANGELOG.md) and [alpha upgrade notes](https://docs.akter.dev/operations/alpha-upgrades) for runtime changes and the required stopped-runner database upgrade.
