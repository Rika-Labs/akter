# ADR 005: Turso/libSQL pilot backend

Date: 2026-09-17  
Status: Conditional

## Context
Managed database-per-entity service avoids building remote SQLite storage. Effect currently has a libSQL driver based on @libsql/client.

## Decision
Target a specifically tested libSQL-compatible Turso endpoint; record engine/version/capabilities and a vendor capacity agreement before hosted scale.

## Alternatives considered
Self-host libSQL shifts operations; D1 ties deployment/API to Cloudflare; mvSQLite/FDB adds a storage platform; Neon changes the database model.

## Consequences and risks
New Turso engine marketing does not automatically imply compatibility with the chosen client. Trigger/transaction/fence and restore behavior need proof.

## Validation and revisit trigger
Gate G02; switch if transaction, quota, cost or export guarantees fail the required contract.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [libSQL versus Turso Database](https://docs.turso.tech/libsql)
- [Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference)
- [Turso Platform API](https://docs.turso.tech/api-reference/introduction)
- [Effect libSQL package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/sql/libsql/package.json)
