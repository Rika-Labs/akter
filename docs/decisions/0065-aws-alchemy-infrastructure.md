# ADR 0065: AWS infrastructure in a stage-isolated Alchemy workspace

**Status:** superseded by [ADR 0089](0089-fly-infrastructure-and-environments.md) (2026-10-04). Implementation decision (2026-10-03), implementing Dallen's provider choices; the AWS and Cloudflare stack it describes was deleted, so read the rest as history.

**Responsibility:** place the hosted infrastructure in the repository and define its deployment boundaries.

**Authority:** design decision record.

**Owner role:** platform infrastructure.

## Context

Issues #520 and #521 require AWS accounts isolated by stage and an Alchemy resource for Neki. The framework already defines signed routing keys and 256 relay buckets. Provisioning a database does not establish its transaction, fencing, or recovery guarantees.

## Decision

`infra/` is the private `@akter/infra` workspace. It imports no application workspace and uses Alchemy `2.0.0-beta.80` and Distilled providers `1.0.0-rc.13`, pinned exactly in the catalog. Cloud integrations use these resources and clients, not vendor SDKs.

Account vending lives in `infra/organization.run.ts`; its organization and member accounts are retained. The service stack in `infra/alchemy.run.ts` uses Alchemy stages `dev`, `staging`, and `prod`, three distinct account IDs, a selected AWS profile per stage, and a selected region (`us-east-1` or `us-west-2`). Each stage-region pair has separate state, networking, compute, registry, DNS, telemetry, and database resources. Credential resolution verifies the actual AWS account and organization before signing provider writes.

The service stack uses private Fargate ARM64 tasks behind an NLB, with one NAT gateway per availability zone. Cloudflare origin-port rules route the service hostnames to distinct TLS listeners; an NLB does not do HTTP host routing. Customer hostnames use the edge listener and an explicit origin SNI override, which requires the corresponding Cloudflare for SaaS entitlement. Stage-region zones are distinct so independently deployed stacks cannot overwrite one another's zone-level origin rules.

Alchemy's S3 backend bootstraps its state bucket before provisioning. A retained bucket resource adopts it and enables versioning and public-access blocking. State remains after destroy. Production encryption keys and the database are retained as well; staging/dev service resources can be removed for lifecycle verification.

Neki data topology maps the signed bigint routing key to range boundaries aligned with the 256 buckets and keeps control tables in an unsharded authoritative group. Topology changes that require provider resharding workflows must not be represented as an ordinary destructive database replacement.

## Consequences

Deploying both launch regions requires invoking the same regional stack twice. Application images are built in GitHub Actions and must already exist in ECR under an immutable image tag; this infrastructure workspace does not build images or restore deleted applications.

`plan:offline` compiles the resource graph and verifies provider registration using in-memory state and nonfunctional placeholder tokens. It never invokes the cloud planner, reads live resources, or applies changes. A real `alchemy plan` requires credentials and can bootstrap the S3 state bucket, so it is not a credential-free, mutation-free substitute.

The runtime contract and support matrix are unchanged. Live create/reconcile/delete, networking, TLS, Neki connections, and conformance still require provider-specific evidence.
