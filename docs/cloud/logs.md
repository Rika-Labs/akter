---
title: "Runner logs"
description: "Read recent output from your app's runners, or follow it live."
---

# Runner logs

Runner logs are what your app writes to standard output and standard error while it runs on Akter Cloud. They do not include build output or Akter Cloud's own logs; the CLI prints build output while `akter deploy` runs.

You can read logs in the console, on the Logs tab of the Deployments page, or with the CLI. The tab has a recent view and a live-follow toggle. This page covers the CLI. [Sign in](./get-started.md) first, and use `npx akter` instead of `bunx akter` if you use Node.

## Read recent output

```sh
bunx akter logs --project PROJECT_ID --env production
```

By default the command prints the last five minutes of output from the environment's current deployment. If the environment has no current deployment, it prints nothing.

```sh
bunx akter logs --project PROJECT_ID --env production --since 3600 --limit 200
```

| Flag           | Default            | Meaning                                  |
| -------------- | ------------------ | ---------------------------------------- |
| `--project`    | `AKTER_PROJECT`    | The project                              |
| `--env`        | `production`       | `production`, `staging`, or `dev`        |
| `--deployment` | current deployment | Read one deployment instead              |
| `--since`      | `300`              | Seconds of recent output, from 1 to 3600 |
| `--limit`      | `100`              | Lines per response, from 1 to 200        |
| `--follow`     | off                | Keep reading until you stop it           |

`--since` reaches back at most one hour. `--limit` is the size of each response, not a cap on how many lines print: the command keeps requesting pages while more are ready, and without `--follow` it exits after the last page.

## Follow output

```sh
bunx akter logs --project PROJECT_ID --env production --follow
```

Follow prints everything that is ready, then waits for new lines with requests that last up to 20 seconds and return sooner when output arrives. Press Ctrl+C to stop.

When you follow an environment, the command moves to the new deployment after a rollout and reads it from the start of the original time window. To stay on one deployment, name it:

```sh
bunx akter logs --project PROJECT_ID --deployment DEPLOYMENT_ID --follow
```

If the control plane is unavailable or a request fails in transit, follow reconnects from the last line it read, waiting 1, 2, 4, then 8 seconds between attempts. It stops after the sixth failure in a row. Any successful read resets the count. Refusals, such as an expired session, are not retried.

## What each line contains

Each line has four tab-separated fields: a UTC timestamp, the runner ID, the stream, and the text.

```text
TIMESTAMP<TAB>RUNNER_ID<TAB>STREAM<TAB>TEXT
```

The stream is `stdout`, `stderr`, or `unknown`. The log source can merge the two, and then Akter reports `unknown` instead of guessing.

The CLI removes terminal color codes and replaces control and text-direction characters, so log text cannot rewrite your terminal. Text longer than 4096 bytes is cut, and the CLI appends ` …` to a cut line. The rest of that line is not available on another page.

## Limits

Akter Cloud keeps recent output for a limited time. Asking for an hour does not guarantee an hour of lines, and output that has expired cannot be recovered by reconnecting. Logs from a runner that has been removed, such as one from an old failed deployment, may no longer be readable. This is a place to look at recent behavior, not a log archive or a trace store.

For the HTTP routes, cursor rules, and response fields, see the [runner logs API](../api/07-cloud-logs.md).
