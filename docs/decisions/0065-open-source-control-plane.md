# ADR 0065: The open-source cloud control plane: ownership, evidence, compute and trust

**Status:** accepted (2026-10-03). Records Dallen's decisions of 2026-10-02 and 2026-10-03 for the Akter Cloud control plane. It supersedes the `apps/*` licensing caveat in [ADR 0029](0029-licence-package-name-and-release-policy.md) and amends [ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md) with the control plane's own access path.

**Responsibility:** decide who owns the control plane's records, how they are verified, where customer code runs, and how the control plane reaches it.

**Authority:** design decision record.

**Owner role:** cloud and security.

**Change policy:** supersede through a new ADR.

## Context

`apps/api` (`@akter/api`) serves the console's HTTP API, whose contract lives in `packages/cloud-api` (`@akter/cloud-api`). It needs durable records of its own (projects, environments, user preferences and an audit log) beside the identity records that Better Auth keeps. ADR 0029 licensed the whole repository under Apache-2.0 but left room to carve out `apps/*` with a new ADR. ADR 0031 fixed how the edge signs assertions for runners and said the control plane owns the tenant directory.

The earlier accounts, billing and email packages were deleted. The hosted product is built on AWS, with Fargate for compute and Neki as the database from day one.

## Decision

1. **Apache-2.0 and open source.** The control plane (`apps/api`, `packages/cloud-api`, `apps/edge`, `packages/deployments` and the infrastructure code) is Apache-2.0 like the rest of the repository and is published with it. ADR 0029's reservation that `apps/*` might become source-available is closed; its other rules stand.
2. **Records and authority.** Better Auth is the authority for users, sessions, organizations, members, invitations and API keys; the control plane never copies them or decides who a caller is. `apps/api` owns four tables of its own, created by idempotent `CREATE TABLE IF NOT EXISTS` migrations when its `Repository` layer starts: `cloud_project`, `cloud_environment`, `cloud_preference` and `cloud_audit`. Every query names the organization (and the user for preferences). A project or environment mutation and the audit entry that describes it commit in one SQL transaction; a change made through Better Auth cannot, so its handler records a `requested` entry before and a completed entry after, each in its own transaction ([contract 11](../contracts/11-control-plane.md)). Preferences are keyed by user alone.
3. **Stateful platform services are actors.** Deployment lifecycle, runner provisioning, usage metering, tenant-directory changes and billing synchronization are Akter actors on `@rikalabs/akter`, as `packages/deployments` already demonstrates. Provider calls run in jobs; actor state, receipts, retries and reconciliation remain in Postgres rather than process memory. The first accounts slice uses Better Auth for identity authority and an Effect `SqlClient` repository for relational project/environment metadata, personal preferences and append-only audit records. It does not introduce a second lifecycle executor; deployment and provisioning endpoints remain typed `NotImplemented` until their actors exist.
4. **Evidence.** The control plane is verified on real local Postgres, with a failure test for every durable transition (cross-organization access, rollback of a mutation whose audit write fails, concurrent writers). The control-plane database is intended to run on Neki, but no document or test claims Neki behavior until provider-specific evidence exists ([ADR 0057](0057-neki-suite-preparation.md)).
5. **Compute.** Hosted runners and platform services run as AWS ECS on Fargate (Graviton), one task per VM-isolated unit, in the launch regions us-east-1 and us-west-2.
6. **Reaching runners.** The API never connects to a runner directly. Every request it makes to customer code (runtime inspection, dead-letter actions) goes through the edge, which authenticates, picks the region and signs the assertion of [ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md) §2. The API holds no runner address and no signing key.
7. **Cell authentication.** A cell contains a regional database and its runner capacity; shared cells serve Free and Pro deployments, while Enterprise uses a dedicated database. A runner trusts only the signed, short-lived assertion, verified against the edge's published keys. A control-plane caller's own credential, session or API key is never forwarded to a runner. The control-plane database is separate from customer cells and initially keeps its cross-table identity/organization authority on one Neki group; local Postgres startup locking is not evidence that Neki has that lock or topology behavior.
8. **No restore of deleted packages.** Accounts, billing and email are rebuilt from the contract in `@akter/cloud-api`; nothing from the deleted packages is brought back from history.

## Alternatives

- **Keep the control plane source-available.** Rejected: self-hosters and contributors need the code that deploys their projects, and the licence split would have to be explained in every package.
- **Write an imperative deployment lifecycle service.** Rejected: stateful orchestration belongs to Akter actors, so a process restart cannot lose provisioning, reconciliation or billing synchronization.
- **Let the API call runners directly.** Rejected: it would duplicate the edge's authentication, region routing and assertion signing, and give the API a second path to customer code.

## Consequences

- [Contract 11](../contracts/11-control-plane.md) states the control plane's durable guarantees, and the [cloud API](../api/07-cloud-api.md) describes the console's HTTP surface.
- [Repository structure](../architecture/repository-structure.md) lists `apps/api` and `packages/cloud-api`.
- Handlers outside `repository.ts` never write the four tables directly.

## Evidence

`apps/api/src/repository.test.ts` runs against real Postgres: organization isolation for projects, environments, pins and the audit log; slug and environment-name uniqueness under concurrent creates; whole provisioning and deletion of a project with its environments and pins; one transaction for each mutation and its audit entry, shown by an audit write that fails and leaves the data unchanged; and concurrent pins that lose nothing.

## Revisit when

- Neki evidence for the control-plane database exists, or a record needs actor guarantees.
- A caller other than the console needs the control plane to reach a runner without the edge.
