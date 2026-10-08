# Contributing

Thanks for helping with Akter. It is alpha software, so please open an issue before starting a large change.

This public repository contains the framework, CLI, public cloud API contract and shared tooling. Hosted service implementations, deployment infrastructure and cloud operator commands are maintained privately. Use the bug issue form for reproducible defects, the feature form for proposed changes and the question form for usage questions. Send Akter Cloud account and billing issues to support@akter.dev rather than opening public GitHub issues.

Read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating. Report security vulnerabilities privately using [SECURITY.md](SECURITY.md), not a public bug report.

## Prerequisites

- Bun 1.4.2 or newer (the repository pins `bun@1.4.2`)
- Docker, for the Postgres server 18.6 used by CI and integration tests

## Setup

```sh
bun install --frozen-lockfile
bun run prepare
docker compose up -d
```

If installation or compiler patching fails on a different Bun version, switch to the pinned version and retry the frozen install instead of editing dependency versions.

## Running checks

```sh
bun run check
```

`bun run check` runs the directive and structure lints, the format check, and lint, typecheck, test and build through Turbo, then the package check.

Integration tests need a disposable Postgres database. Point `TEST_DATABASE_URL` at the Compose database and never at a production database:

```sh
TEST_DATABASE_URL=postgres://project:project@127.0.0.1:5432/project bun run test:integration
```

[CI and verification](.github/ci.md) describes what CI runs.

## Branches and pull requests

Name branches `type/slug`, where `type` is one of `feat`, `fix`, `chore`, `docs`, `refactor`, `test` or `ci`, for example `fix/login`. An issue number is optional: `fix/42-login` is also valid. CI enforces this in [`.github/src/policy.ts`](.github/src/policy.ts).

Pull requests target `main`.

## Engineering rules

[AGENTS.md](AGENTS.md) has the full rules. The main ones:

- Contracts first: read the owning contract in `docs/contracts/` before implementing, and update the contract, ADR, API docs and verification when behavior changes.
- Add a failure test for every durable transition. Prefer a real Postgres database for concurrency, fencing, ownership and recovery tests.
- No inline `//` or `/* */` comments. A reason the code cannot show goes in the JSDoc of the enclosing declaration.
- Never weaken, skip or delete a test to make it pass.

## License

The project is licensed under [Apache-2.0](LICENSE). By submitting a contribution you agree that it is licensed under the same terms.
