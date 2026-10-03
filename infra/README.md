# Akter infrastructure

The private `@akter/infra` workspace provisions the AWS, Cloudflare, Axiom, and Neki stack through Alchemy and Distilled. It does not build container images or deploy application source. All provider versions are exact catalog pins.

## Credential-free checks

From the repository root:

```sh
bun install
bun run typecheck
bun run lint
bun run lint:structure
bun run format:check
bun run --cwd infra test
bun run --cwd infra plan:offline
```

The offline preview compiles all six stage-region combinations with memory state, deliberately invalid provider tokens, loopback API endpoints, and a nonexistent AWS profile. It checks every resource's provider registration. It never runs Alchemy's cloud planner or resource lifecycle methods and never reads a real provider credential. Its output contains only logical IDs and resource types, not secrets or resolved URLs.

`alchemy plan` exists, but needs real credentials. Its S3 state backend may create/configure the state bucket even during a plan. Do not run it as an offline check or as a promise of no provider writes.

## Organization bootstrap

`organization.run.ts` is a separate account-vending stack. Use an Alchemy profile for the AWS management account in `us-east-1`, set `AKTER_MANAGEMENT_ACCOUNT_ID`, and supply `AKTER_DEV_ACCOUNT_EMAIL`, `AKTER_STAGING_ACCOUNT_EMAIL`, and `AKTER_PROD_ACCOUNT_EMAIL`. Each email must be unique across AWS accounts. The stack creates/adopts an organization with all features, discovers its root, and creates the three member accounts with `OrganizationAccountAccessRole`.

With explicit deployment authorization and credentials:

```sh
cd infra
bunx alchemy plan organization.run.ts --stage organization --profile akter-management
bunx alchemy deploy organization.run.ts --stage organization --profile akter-management
```

The organization, root, and accounts are retained; destroying the service stack cannot remove them. Copy the returned account and organization IDs into the regional stack's configuration. Existing member accounts can instead be configured directly; account adoption/vending must be authorized separately from service deployment.

## Regional service configuration

The service stack accepts only Alchemy stages `dev`, `staging`, and `prod`. Set `AKTER_REGION` to `us-east-1` (the default) or `us-west-2`. Deploy each region separately; the stack name is `akter-<region>` and Alchemy adds stage isolation.

| Setting                                                                     | Meaning                                                                                                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AKTER_DEV_ACCOUNT_ID`, `AKTER_STAGING_ACCOUNT_ID`, `AKTER_PROD_ACCOUNT_ID` | Three distinct 12-digit member-account IDs.                                                                                                                           |
| `AKTER_ORGANIZATION_ID`                                                     | Organization expected by the credential guard.                                                                                                                        |
| `AKTER_<STAGE>_AWS_PROFILE`                                                 | Shared AWS profile, defaulting to `akter-dev`, `akter-staging`, or `akter-prod`; supports Distilled's SSO, process, web-identity, and assume-role profile mechanisms. |
| `AKTER_<STAGE>_<REGION>_ZONE`                                               | A distinct Cloudflare zone for this deployment, for example `staging-east.example.com`. Region is uppercase with underscores, such as `US_EAST_1`.                    |
| `AKTER_<STAGE>_<REGION>_CERTIFICATE_ARN`                                    | Issued ACM certificate in this account and region, covering `api`, `edge`, and `console` under the zone.                                                              |
| `AKTER_<STAGE>_<REGION>_IMAGE_TAG`                                          | Immutable tag already present in each application ECR repository.                                                                                                     |
| `AKTER_<STAGE>_<REGION>_CUSTOM_HOSTNAMES`                                   | Optional JSON string array of customer domains managed by this stack. Defaults to `[]`.                                                                               |
| `PLANETSCALE_ORGANIZATION`                                                  | PlanetScale organization with Neki preview access.                                                                                                                    |
| `AXIOM_NOTIFIER_ID`                                                         | Existing Axiom notification destination for the error monitor.                                                                                                        |

Set `AKTER_<STAGE>_<REGION>_NEKI_CLUSTER_SIZE` and `AKTER_<STAGE>_<REGION>_NEKI_ROUTER_SIZE` to available Neki shard/router SKUs confirmed with the provider. `AKTER_<STAGE>_<REGION>_NEKI_SHARD_COUNT` sets the initial actor-data shard count from 1–256 (default 1). A live count change is refused rather than treated as a reshard.

Configure Axiom, Cloudflare, and PlanetScale credentials in an Alchemy profile, or use their documented environment variables in CI. These credentials are not AWS stage selection: the stack always selects and verifies the stage's named AWS profile, ignoring ambient AWS keys. Never commit credentials or a populated environment file.

With explicit deployment authorization and credentials:

```sh
cd infra
AKTER_REGION=us-east-1 bunx alchemy plan --stage staging
AKTER_REGION=us-east-1 bunx alchemy deploy --stage staging
AKTER_REGION=us-west-2 bunx alchemy deploy --stage staging
```

## Resources and boundaries

- Each region has a VPC, two public/private subnet pairs, internet routing, two NAT gateways, a Fargate cluster, an NLB, and ARM64 task definitions/services for `api`, `edge`, and `console`. ECR repositories are `akter/runner-base`, `akter/api`, `akter/edge`, and `akter/console`. The runner repository is a base-image destination, not a deployed customer-runner service.
- GitHub Actions owns builds and pushes immutable ARM64 images. Images must listen on ports 3001, 3002, and 3000 respectively and answer `GET /health`; application exporters must honor the standard OTLP environment settings. The stack does not prove current applications or unavailable images satisfy those prerequisites.
- Cloudflare proxies CNAMEs to the NLB. Origin rules send `edge` to TLS 443, `console` to TLS 8443, and `api` to TLS 2053. Only the published Cloudflare IPv4 ranges can reach those listeners; private tasks admit traffic only from the NLB security group. Review the ranges against `https://www.cloudflare.com/ips-v4` before deployment.
- Each stack owns the zone's origin-rule entrypoint. Use a distinct zone per stage-region and do not manage that phase in another stack. Cloudflare for SaaS and the custom-origin/SNI entitlement must be enabled for customer domains; TXT ownership/certificate validation and customers' CNAME changes remain external obligations. The certificate must match the origin SNI and be usable in Full (strict) mode.
- SES uses a domain identity, three DNS-only Easy DKIM CNAMEs, and a TLS-required configuration set. Domain delegation, DNS propagation, production sending access, and limits require real provider verification.
- Customer environment variables use a rotating KMS envelope-encryption key, separate from the service-secrets key. Auth material is generated in Secrets Manager; provider-derived Turnstile and Axiom secrets stay redacted and are injected by ARN, not stack outputs. Axiom OTLP traces and logs have separate datasets and header secrets.
- The state backend bootstraps `akter-state-<account>-<region>-an`. The retained bucket resource adopts it, enables versioning, blocks public access, and rejects SSE-C. Do not delete this bucket during ordinary teardown; it contains sensitive provider state. Restrict IAM access and keep its version history.

Neki connection outputs are redacted provider role URLs on port 5432, with percent-encoded credentials and `sslmode=verify-full`. Runtime and migration roles are separate; the runtime URL is injected into API and edge through Secrets Manager. The topology defaults actor tables to a range index on `routing_key`; `src/placement.ts` lists the existing control-plane, framework metadata, and Effect Cluster tables without routing keys that stay unsharded. Future tables without routing keys need explicit placement before deployment.

The range mapping assumes Neki encodes a negative `int8` as its unsigned two's-complement bit pattern: buckets 0–127 become `00`–`7f` and buckets -128–-1 become `80`–`ff`. The topology tests prove complete nonoverlapping ranges under that convention, but Neki's published documentation does not confirm its negative-integer encoding. Verify both signed halves with `EXPLAIN (NEKI_PLAN)` before deploying a topology with more than one actor-data shard. The default one-shard topology does not split that boundary. Changing a live topology fails closed; no REST-based resharding workflow is invented.

Provisioning and topology generation do not prove runtime Neki support; the provider-specific create/reconcile/delete and SQL conformance checks remain separate gates. Topology polling observes stored API state, not every router's applied state; router propagation needs the provider's SQL readiness check during live verification.

## Teardown

After authorized live verification, `alchemy destroy --stage staging` removes service resources but retains the state bucket and DNS zone. Production also retains customer/service KMS keys and its Neki database. Retained resources need an explicit operator removal procedure; do not treat a destroy as an AWS account closure or complete erasure.
