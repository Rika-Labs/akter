# Tenancy model

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Identity hierarchy

Use explicit organization -> application -> environment -> actor type -> actor ID -> incarnation. A SaaS customer of our platform is not the same thing as an end-user tenant inside their application. Both may appear in data, but platform authorization must not trust arbitrary application-provided tenant columns.

## Actor databases

A private database belongs to one actor incarnation under a deployment. Provisioning catalogs enforce quotas and deterministic mappings. Different applications may define incompatible `todos` tables safely because actor databases and their schema registries are separate. Database IDs or provider URLs must not be publicly guessable authority tokens.

## Projection destination

Each application configures its own external PostgreSQL sink. We do not merge a million unrelated customer-defined schemas into one global `projected_todos` table. Multiple environments use distinct sink namespaces/credentials. The projection protocol includes platform namespace plus source identity even when the customer chooses shared tables.

## Runtime PostgreSQL

Platform metadata can be shared where a tested tenant key and access path enforce isolation. Only trusted runtime services access it. Application actor code does not receive the control SQL pool. Separate credentials, schema ownership and connection budgets by role. Large customers may receive dedicated deployments for cost predictability or compliance.

## Noisy neighbors

Enforce weighted admission and per-application limits for messages, open actor DB clients, workflow work, event subscriptions and provisioning. An idle-million-actor tenant still consumes catalog rows, migration metadata, backups and support burden. Avoid promising zero-cost identities before measuring those costs.

## Hosted rollout

Phase one: dedicated application runner deployments with a managed platform control plane. Phase two: carefully shared trusted runtime data plane with code isolated per application and resource budgets. Phase three: regional placement or private runners only after operational evidence. Multi-tenancy complexity is not solved by including `tenant_id` in a primary key.

## Sources and evidence

- [T04: Turso Platform API](https://docs.turso.tech/api-reference/introduction) — Provisioning/control API is separate from SQL data-plane client.
- [D02: Railway private networking](https://docs.railway.com/guides/private-networking) — Must validate per-replica identity/routing, not use one load-balanced address as runner identity.
- [P01: PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer) — Transaction pool on port 6432; session-sensitive locks require suitable direct/session connection.
- [A09: AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) — Choose control-plane-managed secrets, grants, rotation and audit.
