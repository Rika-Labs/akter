# Akter CLI

The `akter` command-line tool runs Akter applications locally, checks deployments, inspects and repairs running actors, and connects to Akter Cloud.

Install the current alpha in a project with `bun add -d @rikalabs/akter-cli@alpha` or `npm i -D @rikalabs/akter-cli@alpha`, then run `bunx akter --help` or `npx akter --help`. For one-off use, run `npx -p @rikalabs/akter-cli@alpha akter login`; for a global install, run `npm i -g @rikalabs/akter-cli@alpha`. The package supports Node 24 or later and Bun 1.4.2 or later. Before 1.0, tagged alphas also advance `latest`; `next` is a separate channel for verified main canaries.

Run `akter dev --entry ./src/app.ts` for local development. The local inspector is served at `/_akter/inspector`. To use a local Akter Cloud control plane, set `AKTER_API_URL=http://localhost:3001` or pass `--api-url http://localhost:3001` to `akter login`.

The framework package, `@rikalabs/akter`, does not carry a second `akter` bin. This package is the one install path for the CLI, so `npx akter` and `bunx akter` resolve the same release.

Cloud applications can import the public API contract without running the CLI:

```ts
import { CloudApi, ProjectId } from "@rikalabs/akter-cli/cloud-api"
```

The subpath ships compiled JavaScript and declarations, using the application's shared Effect runtime. `@akter/cloud-api` is a private workspace, not a separately published package. Pin the same exact framework and CLI version in deployments.
