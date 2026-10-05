# ADR 0089: Fly.io infrastructure and environments

**Status:** implementation decision (2026-10-04), for [#611](https://github.com/Rika-Labs/akter/issues/611); supersedes [ADR 0065](0065-aws-alchemy-infrastructure.md). The runner backend that replaces ADR 0075's ECS provisioning is recorded in ADR 0090.

**Responsibility:** place the hosted platform on Fly.io and define its environments, the providers behind them, and how they are deployed.

**Authority:** design decision record.

**Owner role:** platform infrastructure.

**Change policy:** supersede through a new ADR.

## Context

ADR 0065 put the platform on AWS Fargate behind an NLB, with Cloudflare in front, SES for email, KMS for customer secrets and one AWS account per stage. Dallen replaced that on 2026-10-04 to reduce what the platform depends on. He compared Railway, Render, Fly.io and Vercel and chose Fly.io for compute. The same day he fixed the other providers, the hostnames and the environments below. They are decisions, not options.

## Decision

1. **Environments.** The deployed environments are `prod` and `pr-<n>`, one per open pull request. A third stage, `preview`, is not an environment: it runs no application and owns what every pull request preview shares (decision 6 and 7). There is no `dev` stage and no staging stage. The stack refuses any other name before it reaches a provider, and CI never destroys `prod` or `preview`. `pr-<n>` and `preview` use the Fly organization `rika-labs-dev`; `prod` lives in `rika-labs-prod`. Every machine runs in `iad`.

   |                      | prod             | preview `pr-<n>`                |
   | -------------------- | ---------------- | ------------------------------- |
   | site                 | `akter.dev`      | `pr-<n>.preview.akter.dev`      |
   | console              | `app.akter.dev`  | `app-pr-<n>.preview.akter.dev`  |
   | API                  | `api.akter.dev`  | `api-pr-<n>.preview.akter.dev`  |
   | edge                 | `edge.akter.dev` | `edge-pr-<n>.preview.akter.dev` |
   | customer deployments | `akter.run`      | `pr-<n>.preview.akter.run`      |

   The customer domain is the one value `DEPLOYMENT_DOMAIN` carries, written once per stage in `infra/src/config.ts`. Fly app names are global to Fly, so each carries the stage: `akter-<stage>-api`, `-edge`, `-console` and `-site`.

2. **Compute.** The API and the edge are Fly Machines running images that the stack builds from `apps/api/Dockerfile` and `apps/edge/Dockerfile` for `linux/amd64`, the only architecture Fly runs, and pushes to `registry.fly.io/<app>`. The console and the site are static builds served by Alchemy's `Fly.Website.Foldkit` and `Fly.Website.Astro`. Every secret is a Fly secret. Each machine carries the digest of each of its secrets as metadata, so rotating one restarts the machine with the new value. The API runs one machine, because it hosts its orchestration actors in one process; the edge runs two in `prod` and one in a preview. Customer runners are Fly Machines in one Fly app per deployment, which the API creates with an organization token; that path is ADR 0090's.

3. **Idle previews sleep.** A preview's machines and static sites stop when idle and start on the next request (`autostop: stop`, `autostart`, no minimum running), so an open pull request costs only the storage of its stopped machines while nobody uses it. `prod` stays running. The first request after a pause is slower, and the API's timers do not fire while its machine is stopped.

4. **Certificates and DNS.** Fly issues a certificate for each hostname, and the edge also holds the wildcard `*.<customer domain>`. Vercel hosts the DNS of `akter.dev` and `akter.run`. Alchemy has no Vercel resources and the generated `@distilled.cloud/vercel` operation for creating a record carries only the record's type, so `infra/src/vercel` sends the full body through the same protocol and credentials. The resource creates records only: it never creates a zone, so `akter.run` must be bought in Vercel before the first deploy. It adopts a record at the same name and type only when it made it or the record already holds the wanted value, so the mail records on `akter.dev` and anything added later at the root are never touched. Subdomains are CNAMEs to `<app>.fly.dev`; the production apex gets A and AAAA records from the site's addresses; the wildcard needs the DNS-01 challenge CNAME Fly returns for the certificate.

5. **Email.** Resend's free plan allows one domain, so every stage sends from the root `akter.dev`, which was added in Resend and verified with records added in Vercel by hand. The stack does not create Resend domains or records. `RESEND_API_KEY` is a stack input handed to the API as a secret, and `EMAIL_FROM` names the stage: `Akter <auth@akter.dev>` or `Akter Preview <auth-preview@akter.dev>`.

6. **Database.** Every database is Neki (`infra/src/neki`). `prod` owns `akter-prod`: two replicas, two routers per cell, deletion-protected and retained when its stage is destroyed, with the routing-key topology and the list of unsharded control tables in `infra/src/placement.ts`. The `preview` stage owns `akter-preview`, the same resources at the smallest sizes (`PREVIEW_NEKI_CLUSTER_SIZE` and `PREVIEW_NEKI_ROUTER_SIZE`): no replicas, one shard, one router, no deletion protection. Pull request previews share it. A preview creates a `Neki.Role` that inherits `postgres` and `neki_viewer` and, through that role, a logical database named `akter_pr_<n>` with `CREATE DATABASE`; it drops the database and the role when its stage is destroyed, and learns the cluster from the `preview` stage's output. Neki roles are cluster-wide, so a preview's role can read every logical database on the shared cluster; that is acceptable only because the cluster holds preview data and `prod` never shares it. Services connect with a role that inherits `postgres`, because the API creates its tables when it boots, so each deployed stage has one such role instead of a read-write role and a migration role. Whether a Neki router accepts `CREATE DATABASE` and `DROP DATABASE` has no provider evidence yet. If it refuses, the deploy of a preview fails with the router's error; the fallback is one schema per preview in the shared database, which is a change to `infra/src/database.ts` and the logical-database resource, not something the stack does by itself.

7. **Observability.** Axiom's free Personal plan allows three datasets and three monitors for the whole organization. Every stage therefore writes to the shared datasets `akter-traces` and `akter-logs`, told apart by the OpenTelemetry resource attribute `deployment.environment`. `prod` and the `preview` stage both declare the datasets, adopting what exists and retaining them, so neither needs the other deployed first and destroying either cannot take them from the other. `prod` owns the single error monitor, which watches `prod` only, because previews are expected to break. Every deployed stage mints its own ingest token, which is deleted with the stage.

8. **Billing.** Previews use Stripe test mode and `prod` uses live mode; the stack refuses a key of the other mode. Each deployed stage creates its own webhook endpoint at its API and gives the signing secret to the API. Stripe allows 16 endpoints per account, which bounds the previews open at once.

9. **State.** Alchemy keeps state in `PostgresState`, in small PlanetScale Postgres databases of their own, taken from `ALCHEMY_STATE_DATABASE_URL`. State holds each stage's generated secrets, and pull request code runs with the `preview` environment's credentials, so `prod` and the previews use two state databases: one in the `production` environment and one in `preview`, which holds the `preview` stage and every `pr-<n>`. A preview reads the `preview` stage's output through an Alchemy stack reference, which works because both live in the same database, so the `preview` stage must be deployed before the first preview.

10. **Generated secrets.** `AUTH_SECRET` and the edge's Ed25519 `EDGE_SIGNING_KEYS` are generated inside the stack and live in its state, which is sensitive. The edge key is one key; rotation adds a second to the array and redeploys, as in the key-rotation runbook. The stack provisions no key for customer environment variables, because the runtime uses none.

11. **Credentials as code and CI.** `infra/stacks/github.ts` writes two GitHub environments for the repository, with the secrets and variables the workflow reads, from values in its own environment. `preview` serves every pull request preview and the `preview` stage; `production` serves `prod`, accepts deployments from `main` alone and has no required reviewer. Every credential that could reach production, including the state database, is a separate value per environment, and each environment receives an Axiom token the stack minted for it with the capabilities its deploys need. `.github/workflows/deploy.yml` deploys `pr-<n>` when a pull request from this repository opens or changes and destroys it when the pull request closes. A push to `main` deploys `prod` as soon as the `Verify` workflow succeeds for it, with no approval step, and also deploys the `preview` stage when that push changed `infra/`. A manual run redeploys `prod` or `preview` from `main`. A nightly job destroys previews whose pull request is closed. Each stage has its own concurrency group, so two deploys of `prod` never overlap. The workflow runs on an Arm runner; because Fly runs amd64 only, the images build under QEMU.

12. **Release safety.** Nothing in the infrastructure gates a release: a merged change that passes `Verify` reaches `prod`. Feature flags (`packages/flags`) are what keeps an unfinished or risky change dark in production, and the stack passes them nothing.

## Consequences

The stack declares more than AWS did and does not prove any of it. `plan:offline` compiles every declaration with registered providers and placeholder inputs; unit tests run the custom Vercel provider against a recorded API and the logical-database provider against a real Postgres. None of that establishes Fly, Neki, Vercel, Axiom or Stripe behavior; `docs/verification/cloud-infrastructure.md` lists the live checks.

A pull request's workflow runs with the `preview` environment's secrets, so a collaborator who can push a branch can read them. The stack reads every credential that could reach production per environment, so `preview` can hold a Fly token for `rika-labs-dev`, Stripe test keys, a separate state database, and PlanetScale and Resend credentials that cannot touch production. Nothing enforces that the values differ: an operator who pastes production's into `preview` defeats the `main`-only branch rule on `production`. The Vercel token is the one shared secret and can edit any DNS record in the team. Fork pull requests never run the workflow.

`prod` deploys without a person in the loop, so a bad merge reaches customers before anyone looks. The checks before it are `Verify` and feature flags, and a revert redeploys through the same path.

Destroying a `pr-<n>` stage deletes its Fly apps with their machines, its Neki role and logical database, its Stripe endpoint and its Axiom token. The `preview` stage is never destroyed by CI; an operator who destroys it deletes the shared Neki cluster and must destroy every preview first. Destroying `prod` keeps its Neki database and the Axiom datasets, and the workflow never does it. State, DNS zones and the Resend domain are outside every stage's destroy.

Not decided here: runner provisioning and the edge-to-runner path (ADR 0090), multi-region, paid Fly support, and a staging environment.
