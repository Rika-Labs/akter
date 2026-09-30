# @durable-actors/create

Scaffolds a Durable Actors app: `bun create @durable-actors my-app [--template counter|chat]`.

The generated app runs on file-backed PGlite by default and on Postgres when `DATABASE_URL` is set. See the [quickstart](../../docs/quickstart.md). The package is private until the `0.1.0-alpha` release.

`templates/base` holds the files every app shares; `templates/counter` and `templates/chat` add their actors and entry point on top. `templates/manifest.json` names each dependency with `catalog:` or `workspace:*`, and `bun run build` resolves them into `dist/manifest.json`, which the published package carries: the app pins exactly the versions the framework is built and released with. `@effect/platform-node-shared` is listed although nothing imports it, because `@effect/platform-bun` depends on it with a caret range that admits release candidates built against a newer `effect`.
