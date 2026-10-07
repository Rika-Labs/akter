---
title: "Runner logs"
description: "Read recent customer runner output or follow it across deployments with the CLI."
---

`akter logs` reads your customer runners' recent output, not build logs or Cloud platform logs. First [sign in](/cloud/get-started). The console Logs tab is coming; this guide covers the CLI. With Node, substitute `npx akter` for `bunx akter`.

## Read recent output

Replace `PROJECT_ID` with your project ID:

```sh
bunx akter logs --project PROJECT_ID --env production
```

By default, the command requests the last five minutes of the environment's current deployment. An environment with no current deployment returns no lines.

```sh
bunx akter logs --project PROJECT_ID --env production --since 3600 --limit 200
```

`--since` is seconds of recent output, from 1 to 3600, with a default of 300. The server clamps the requested start time to the last hour through now, so client clock skew or network delay does not reject a boundary request. This does not extend the provider's retention.

`--limit` sets lines **per response**, from 1 to 200, with a default of 100. It is not a cap on the total lines printed: both normal reads and follow mode fetch subsequent pages immediately while the API reports `more`. Without `--follow`, the command exits when it reaches a page with `more: false`.

`--project` also accepts `AKTER_PROJECT`. `--env` defaults to `production`; accepted environment names are `production`, `staging` and `dev`.

## Follow an environment or deployment

```sh
bunx akter logs --project PROJECT_ID --env production --follow
```

Follow drains available pages, then uses long polls of up to 20 seconds, returning sooner when output arrives. It resumes from the last successful cursor, including after an empty response. Press Ctrl+C to cancel the current request and stop; no background follower remains.

Following an environment switches to its newly current deployment after a rollout. The server discards the previous deployment's provider position and reads the replacement from the original requested time window, still bounded to the last hour.

To stay with one deployment, use its deployment ID:

```sh
bunx akter logs --project PROJECT_ID --deployment DEPLOYMENT_ID --follow
```

An explicit `--deployment` selects that deployment instead of the environment's current deployment and never switches to a replacement.

In follow mode, transport failures and typed 503 `Unavailable` responses retry from the last successful cursor. Delays are capped at eight seconds; six consecutive failed reads stop the command. A successful read resets that failure count. Authentication and authorization refusals are not retried. Normal reads do not use this follow retry loop.

## Read the output and its limits

Each printed line contains its UTC timestamp, runner ID, stream and text, separated by tabs. Fly merges stdout and stderr, so the stream is `unknown` rather than a guessed source. Terminal color sequences are removed, and control and bidirectional-formatting characters are replaced so log text cannot forge terminal lines.

A line's text is limited to 4096 UTF-8 bytes. When the API marks that line `clipped`, the CLI appends ` …`. Clipping means text was cut; it does not mean another page can recover the rest of that line. Page-level `more` separately indicates that more lines can be read immediately.

Fly retains only recent output, with provider-controlled retention and availability. Requesting an hour does not guarantee an hour of retained lines. A reconnect cannot recover expired output, and a removed runner app may no longer have readable logs. This is not a durable log archive or a trace store.

For authenticated HTTP reads, cursor rules and response fields, see the [customer runner logs API reference](/api/07-cloud-logs). For build failures, see [deploying](/cloud/deploy).
