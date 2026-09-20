# Remote infrastructure

`@project/infra` pins Alchemy **2.0.0-beta.79** and Effect **4.0.0-rc.116**. The installed Alchemy peer requirement is `>=4.0.0-rc.115 || >=4.0.0`; rc116 typechecks. All provider API calls use Alchemy or published Distilled packages. No infrastructure was provisioned by this implementation.

## Commands (repository root)

```sh
bun infra/src/cli.ts plan deployment.json
bun infra/src/cli.ts deploy deployment.json --approve
PROJECT_OWNER=alice bun infra/src/cli.ts destroy deployment.json --approve
bun infra/src/inject-secrets.ts project-id dev /local -- bun run dev
```

Manifest example (replace the expiry at invocation):

```json
{
  "project": "example",
  "stage": "dev",
  "owner": "alice",
  "id": "work",
  "expiresAt": "2026-09-20T12:00:00Z",
  "appOrigin": "https://alice.example.com"
}
```

`plan` is an offline validated lifecycle description, **not a cloud diff**. `deploy` invokes installed Alchemy from repository root with `context: "."`, so the local working tree, including uncommitted files, is uploaded. Dockerfile-specific ignore files exclude secrets, state, Git metadata, dependencies and generated artifacts. Alchemy limits local uploads to 32 MiB/10,000 entries and rejects symlinks/non-ASCII paths. Review the upload contents before approval. A generated root `bun.lock` and all workspace manifests are required.

One Railway project per lifecycle identity owns two Bun services: web port 3000 and API port 3001, both `/health`. PlanetScale Postgres is remote for every environment. **Only Alchemy's PostgresDatabase owns SQL migrations** from `packages/database/migrations`; do not also execute the database package migration command during API startup or CI deployment. Axiom datasets are per identity. Infisical `listSecretsV4` retrieves `/deployments/<id>` in the selected stage using `INFISICAL_TOKEN` and `INFISICAL_PROJECT_ID`; values are redacted at the infra boundary and not printed. Include `BETTER_AUTH_SECRET`, provider application secrets, and Axiom ingest token there. Provider bootstrap credentials come from Alchemy profiles/environment, not those application secrets.

`appOrigin` is a required HTTPS callback origin at deployment. Both services receive APP_ORIGIN; web receives API_ORIGIN. When CLOUDFLARE_ZONE_ID is set, Cloudflare owns proxied CNAME DNS only, pointing to Railway; Railway owns application execution and custom domain TLS. Certificate validation/verification TXT requirements must be verified against the real domain after approved provisioning. No Workers runtime, database, or local database substitute is introduced.

## Lifecycle and operational limits

Dev/PR IDs include project, stage, owner and caller identity. They require TTL ≤7 days. Destroy checks owner and rejects staging/prod. Persistent database, Railway project, and Axiom dataset resources use Alchemy retain policy; retain forgets state on removal and is not a substitute for operator approval. The CLI validates intent, not authenticated identity; run under a trusted identity-bound wrapper in automation.

State uses Alchemy localState under repository-root `.alchemy`. **Preserve and protect this directory on one owning persistent orb; do not deploy from disposable Actions runners.** Serialize all operations per identity. State can contain credentials despite redacted output. Multi-host locking/state backup, scheduled TTL sweeper and automatic PR-close cleanup are not installed. An approved janitor can invoke the destroy command on stored expired manifests (expired manifests remain destroyable). Do not claim automatic cleanup until this wiring exists. Losing state requires explicit operator recovery/adoption, never a blind redeploy.

Process secret injection rejects prod/production and writes no secret file. It injects only into the spawned child, not the calling shell or already running supervised services. Setup/resume must start the desired process through this command.

## Qualified sources

The exact npm tarball contains `src/Railway/Service.ts`, `local-context.ts`, `Up.ts`, `Project.ts`, `CustomDomain.ts`; `src/Planetscale/Postgres/PostgresDatabase.ts`, `PostgresRole.ts`; `src/Axiom/Dataset.ts`; `src/Cloudflare/DNS/Record.ts`; and `src/RemovalPolicy.ts`. Important: the actual migration prop is **migrations**, not the stale example's migrationsDir.

Published `@distilled.cloud/infisical@1.0.0-rc.12` includes `src/services/infisical.ts:listSecretsV4` and `src/credentials.ts:CredentialsFromEnv`. It exists on npm despite a prior private-package repository snapshot. `@distilled.cloud/github@1.0.0-rc.12` implements the GitHub operations used by the plugin/policy gate. Local tests and typechecks qualify API compatibility, not credentials, service startup, domain TLS, billing, or live migration execution.
