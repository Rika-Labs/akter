# ADR 0103: CLI distribution for Node and Bun

**Status:** accepted (2026-10-06).

**Responsibility:** decide the CLI package name, runtime support, release unit, and local development defaults.

This amends [ADR 0029](0029-licence-package-name-and-release-policy.md)'s package-location rule: `apps/cli` is a publishable application package, while `@akter/cloud-api` remains private and is bundled into it.

## Context

The public repository now contains `apps/cli`, while the framework already publishes as `@rikalabs/akter`. The console onboarding command is `bunx akter login`, so the CLI needs a real npm package that works on Node 24+ and Bun 1.4.2+.

## Decision

- The CLI publishes as `@rikalabs/akter-cli` with the `akter` bin. ADR 0029 records npm's refusal of the unscoped `akter` name as too similar to existing packages; a registry dry-run cannot prove that similarity check will accept a real publish. Users install it with `bun add -d @rikalabs/akter-cli` or `npm i -D @rikalabs/akter-cli`, then invoke `bunx akter` or `npx akter`. One-off use is `npx -p @rikalabs/akter-cli akter login`, and a global install is `npm i -g @rikalabs/akter-cli`.
- `@rikalabs/akter` does not carry a second `akter` bin. There is one CLI package and one executable, so framework installs cannot shadow an independently versioned CLI.
- The CLI ships compiled ESM and declarations only. Its executable has a `#!/usr/bin/env node` entry and selects the Node or Bun Effect platform layers at runtime. The browser inspector client is bundled during package build, so `akter dev` does not require Bun when run under Node.
- The CLI and framework share the framework version. The `@akter/cloud-api` contract is bundled into the CLI executable and remains private; it is not a second npm release unit. Libraries whose schemas or runtime identity must be shared with the application remain exact-version peers, while both platform packages are exact-version runtime dependencies so a standalone CLI install runs on either engine.
- The default hosted API URL is `https://api.akter.dev`. `--api-url` and `AKTER_API_URL` continue to override it, and local development uses `http://localhost:3001` explicitly.
- `DURABLE_OPERATOR_TOKEN` is renamed to `AKTER_OPERATOR_TOKEN`, and the local inspector moves from `/_durable/inspector` to `/_akter/inspector`. Stored `durable` schemas and wire identifiers are unchanged. The alpha has no compatibility alias.

## Consequences

The release workflow stages and smoke-tests both tarballs on Node and Bun, then publishes both through npm trusted publishing under the same tag. A CLI release requires the framework release checks to pass, and a changed CLI needs a new framework version because they are one release unit.

The first CLI publish is a one-time maintainer bootstrap: publish the packed tarball interactively, then configure its trusted publisher before enabling workflow publication. The dry-run checks the tarball shape only.
