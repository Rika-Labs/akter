# M0 — Foundation

**Responsibility:** establish contracts and a runnable test boundary.  
**Authority:** delivery plan.  
**Owner role:** delivery/runtime lead.

## Included

- Bun/Turbo monorepo from `rika-labs/monorepo-project-template`;
- package boundaries and Effect foundation;
- protocol/error/schema packages;
- disposable real Postgres;
- contract fixtures and invariant registry;
- first ADRs and CI checks.

## Excluded

Realtime, live SQL, ownership transfer, workflows, managed deployment, and provider-specific claims.

## Exit criteria

The repository installs, typechecks, lints, tests, and runs one disposable Postgres integration test. Documentation authority, package ownership, and failure evidence are reviewable by a new agent.
