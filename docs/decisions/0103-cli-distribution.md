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
- The CLI and framework share the framework version. The `@akter/cloud-api` workspace remains private and is bundled into the executable; its contract also ships as compiled ESM and declarations at `@rikalabs/akter-cli/cloud-api`, without importing the executable or introducing another npm release unit. This subpath lets cloud consumers use npm rather than the framework repository's git submodule. Published `effect`, `@effect/*` and `drizzle-orm` peers use caret ranges whose floors are the exact workspace catalog versions. Peer dependencies preserve the application's shared service and schema identity; making Effect a runtime dependency could instead install a second copy. Both platform packages remain exact-version runtime dependencies so a standalone CLI install runs on either engine, and the workspace catalog stays exact for reproducible CI.
- The default hosted API URL is `https://api.akter.dev`. `--api-url` and `AKTER_API_URL` continue to override it, and local development uses `http://localhost:3001` explicitly.
- `DURABLE_OPERATOR_TOKEN` is renamed to `AKTER_OPERATOR_TOKEN`, and the local inspector moves from `/_durable/inspector` to `/_akter/inspector`. Stored `durable` schemas and wire identifiers are unchanged. The alpha has no compatibility alias.

## Consequences

The release workflow stages and smoke-tests both tarballs on Node and Bun, including a typechecked import of the cloud API with endpoint and schema assertions, then publishes both through npm trusted publishing under the same channel policy. A CLI release requires the framework release checks to pass, and a changed CLI needs a new framework version because they are one release unit. [ADR 0029](0029-licence-package-name-and-release-policy.md) defines pre-1.0 `latest` promotion and verified-main `next` canaries.

The first CLI publish is a one-time maintainer bootstrap: publish the packed tarball interactively, then configure its trusted publisher before enabling workflow publication. The dry-run checks the tarball shape only.

## Alpha.2 peer-resolution evidence and policy amendment

On 2026-10-07, plain npm tarball installation of both packages with exact peers failed `ERESOLVE`: npm first resolved `effect@^4.0.0` from the framework's optional platform peer or the CLI's SQL peer to `4.0.1`, then rejected the packages' exact `effect@4.0.0` requirement. An application already using `effect@4.0.1` also cannot satisfy an exact `4.0.0` peer. Explicit root pins do not meet the supported plain-install workflow and can still let a transitive platform dependency demand a newer Effect peer. Published compatible peer ranges avoid rejecting a compatible application and retain one peer-provided Effect identity, without adding an Effect runtime dependency. Local-registry installation and quickstart evidence is recorded with the alpha.2 release preparation. Bumping the tested catalog cohort is a separate follow-up, not part of this policy change.
