# Changelog

## 0.1.0-alpha.2 (2026-10-07)

The first CLI release, versioned with `@rikalabs/akter` on the `alpha` dist-tag.

- Publishes as `@rikalabs/akter-cli` with the `akter` executable, compiled ESM and declarations for Node 24+ and Bun 1.4.2+. The inspector client is prebuilt; Node users do not need Bun. The private cloud API contract is bundled, not separately published.
- Includes local `akter dev`, cloud login/logout/whoami, source deployment and `akter env list`, `set`, `unset` and `import`.
- **Breaking:** operator commands read `AKTER_OPERATOR_TOKEN`, not `DURABLE_OPERATOR_TOKEN`. There is no implicit alias; set the new variable or use `--token-env`.
- **Breaking:** the local inspector page and API use `/_akter/inspector`, not `/_durable/inspector`. Update bookmarks and requests.
- **Breaking:** hosted source deploys load `src/app.ts` with a generated Dockerfile; the API refuses `source.dockerfile`.
- Login defaults to `https://api.akter.dev`; select a preview or local API explicitly with `--api-url` or `AKTER_API_URL`.
- **PENDING ORCHESTRATOR FINALIZATION — `akter logs`:** the parallel customer-logs PR is intended for this release; finalize this line after merge and verification.

See the [framework changelog](https://github.com/Rika-Labs/akter/blob/main/packages/akter/CHANGELOG.md) and [alpha upgrade notes](https://docs.akter.dev/operations/alpha-upgrades) for runtime changes and the required stopped-runner database upgrade.
