# Akter CLI

The `akter` command-line tool runs Akter applications locally, checks deployments, inspects and repairs running actors, and connects to Akter Cloud.

Install it with `npm install --save-dev akter`, `npx akter --help`, `bun add --dev akter`, or `bunx akter --help`. The package supports Node 24 or later and Bun 1.4.2 or later.

Run `akter dev --entry ./src/app.ts` for local development. The local inspector is served at `/_akter/inspector`. To use a local Akter Cloud control plane, set `AKTER_API_URL=http://localhost:3001` or pass `--api-url http://localhost:3001` to `akter login`.

The framework package, `@rikalabs/akter`, does not carry a second `akter` bin. This package is the one install path for the CLI, so `npx akter` and `bunx akter` resolve the same release.
