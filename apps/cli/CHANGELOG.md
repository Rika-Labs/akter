# Changelog

## 0.1.0-alpha.2 (2026-10-07)

The first CLI release, versioned with `@rikalabs/akter` on the `alpha` dist-tag.

- Publishes as `@rikalabs/akter-cli` with the `akter` executable, compiled ESM and declarations for Node 24+ and Bun 1.4.2+. The inspector client is prebuilt; Node users do not need Bun. The private cloud API contract is bundled, not separately published.
- Includes local `akter dev`, cloud login/logout/whoami, source deployment and `akter env list`, `set`, `unset` and `import`.
- **Breaking:** operator commands read `AKTER_OPERATOR_TOKEN`, not `DURABLE_OPERATOR_TOKEN`. There is no implicit alias; set the new variable or use `--token-env`.
- **Breaking:** the local inspector page and API use `/_akter/inspector`, not `/_durable/inspector`. Update bookmarks and requests.
- **Breaking:** hosted source deploys load `src/app.ts` with a generated Dockerfile; the API refuses `source.dockerfile`.
- Login defaults to `https://api.akter.dev`; select a preview or local API explicitly with `--api-url` or `AKTER_API_URL`.
- Adds `akter logs` to read customer runner output for a project (`--project`, default `AKTER_PROJECT`) and an environment (`--env`, default `production`) or one `--deployment`. `--since` takes 1 to 3600 seconds (default 300), and the server clamps the requested time into the last hour. `--limit` takes 1 to 200 lines per page (default 100), not a total. Without `--follow` it reads every page in the window and exits; `--follow` drains available pages at once, then long-polls for up to 20 seconds. Follow resumes from the last successful cursor after transport failures and typed `Unavailable` (503) responses, with capped exponential delays, and stops after six failed requests in a row. Authentication, authorization, missing-resource and unsupported-operation refusals are not retried. Ctrl-C cancels the request and exits with code 130. Control characters, Unicode line separators and bidirectional-formatting characters are replaced, and a trailing `…` marks a line clipped at 4096 UTF-8 bytes. Fly merges stdout and stderr, so its lines show stream `unknown`. Output is recent only and expired provider output cannot be recovered; build output is not included. See the [logs API contract](https://github.com/Rika-Labs/akter/blob/main/docs/api/07-cloud-logs.md).

See the [framework changelog](https://github.com/Rika-Labs/akter/blob/main/packages/akter/CHANGELOG.md) and [alpha upgrade notes](https://docs.akter.dev/operations/alpha-upgrades) for runtime changes and the required stopped-runner database upgrade.
