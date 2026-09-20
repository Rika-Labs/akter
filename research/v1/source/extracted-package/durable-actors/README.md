# Durable Actors — research and bootstrap

An opinionated TypeScript / Effect virtual-actor framework design, with Bun-first tooling and Node compatibility.

**This repository is a research package and setup-only skeleton. It does not contain a working actor runtime.** No actors, databases, cloud resources, background relays, or deployments are started by importing a package.

Start with [START_HERE.md](START_HERE.md), then [DECISIONS_SUMMARY.md](DECISIONS_SUMMARY.md). The architecture is intentionally conditional on the failure tests documented in [docs/VALIDATION_GATES.md](docs/VALIDATION_GATES.md).

## Planned architecture

- Effect v4 and Effect Cluster for typed execution, entity routing and persistent-message machinery.
- Actor-private libSQL-compatible databases, with Turso as the preferred hosted pilot.
- PostgreSQL for cluster/control metadata, with PlanetScale direct connections as the preferred managed pilot.
- Local transactional receipts and outboxes bridge those independent stores; no distributed SQL transaction is implied.
- Optional projections into an application-owned PostgreSQL database.
- A future agent framework uses this actor foundation. Agents are not implemented in this repository.

## Repository commands

`bun install` installs the pinned workspace. `bun run setup:toolchain` prepares the selected Effect diagnostics integration and reports any unsupported tuple. `bun run check:scaffold` checks file/package boundaries without cloud credentials. See [VALIDATION.md](VALIDATION.md) for the checks actually executed during generation.

`bun dev` serves the documentation/setup portal, **not an actor emulator**. Implementing the local actor runtime is a roadmap milestone.

There are no cloud credentials in this archive. Provider configuration files are templates and are not applied automatically. Packages remain private until the release checklist and licensing decision are completed.
