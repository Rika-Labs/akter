---
title: "Runner logs API"
sidebarTitle: "Cloud logs"
description: "Read a deployment's recent runner output over HTTP, with bounded windows and resumable cursors."
---

# Runner logs API

The runner logs API returns recent standard output and standard error from your app's runners. `akter logs` and the console's Logs tab both use it. For a guide to the command, see [Runner logs](../cloud/logs.md).

`@rikalabs/akter-cli/cloud-api` exports the `RunnerLogLine` and `RunnerLogPage` schemas, the `LogCursor`, `LogLimit`, and `LogWait` schemas, and the limits as constants. The `CloudApi.deployments` group has two operations. Both live under `/api`:

| Client operation     | HTTP route                                                    |
| -------------------- | ------------------------------------------------------------- |
| `getEnvironmentLogs` | `GET /api/projects/:projectId/environments/:environment/logs` |
| `getLogs`            | `GET /api/projects/:projectId/deployments/:deploymentId/logs` |

`environment` is `production`, `staging`, or `dev`. An environment read follows the environment's current deployment, and returns an empty page when there is none. A deployment read returns that deployment's output only and never switches to another one.

## Access

Send a session (the `better-auth.session_token` cookie, or the same token as a bearer token) or an organization API key in the `x-api-key` header. A session needs membership in the project. An API key needs read permission in the project's organization. Access is checked again on every request, including each resumed poll, and organizations that are suspended can still read. A project or deployment in another organization answers 403 or 404.

## Query

| Field    | Type                          | Default          | Meaning                                                |
| -------- | ----------------------------- | ---------------- | ------------------------------------------------------ |
| `since`  | UTC ISO instant               | five minutes ago | Start of the window                                    |
| `limit`  | integer, 1 to 200             | 100              | Most lines in one page                                 |
| `cursor` | string, up to 2048 characters | none             | Resume from a position returned by an earlier page     |
| `wait`   | integer, 0 to 20              | 0                | Seconds to hold the request open when no line is ready |

The server clamps `since` to the range from one hour ago to now, so network delay or a skewed client clock does not reject a request near the edge of the window. When you send a cursor, its position takes precedence over `since`, and it stays inside the same one-hour window. A cursor that is invalid, or that belongs to another resource, returns 404 `NotFound` with `resource: "cursor"`. A cursor is only a position. It never grants access to a runner.

## Response

```json
{ "lines": [], "cursor": "…", "more": false }
```

A page has at most 200 lines. `cursor` is always present, even for an empty page, so you can resume from it. `more` is `true` when another page is ready right now. It says nothing about clipped text.

Each line has these fields:

| Field          | Meaning                                     |
| -------------- | ------------------------------------------- |
| `id`           | The line's identifier                       |
| `deploymentId` | The deployment that produced it             |
| `runnerId`     | The runner that produced it                 |
| `at`           | When the line was written, as a UTC instant |
| `stream`       | `stdout`, `stderr`, or `unknown`            |
| `text`         | The text, at most 4096 UTF-8 bytes          |
| `clipped`      | `true` if the text was cut to fit           |

The log source can merge the two streams, and then `stream` is `unknown`. The API returns only your runners' output. It does not include build output or Akter Cloud's own logs.

## Read and follow

To read a window, request a page, then keep requesting with the returned `cursor` and `wait=0` while `more` is `true`.

To follow, keep going once `more` is `false`, and send `wait=20` with the latest cursor. The request returns early when a new line arrives, or after 20 seconds with an empty page and a cursor you can use again. After a dropped response, repeat the request from the last cursor you finished processing, not one you never received.

When the environment's current deployment changes, an environment follow switches to the new deployment. It starts that deployment from the original time window, and every line carries the new `deploymentId`. A deployment follow never switches.

## Errors

The routes can answer 401 `Unauthorized`, 403 `Forbidden`, 404 `NotFound`, 501 `NotImplemented`, and 503 `Unavailable`. A 503 carries `retryAfterSeconds`. Query values outside the limits are rejected when the request is decoded.

## Limits

Akter Cloud keeps recent output for a limited time. Output that has expired cannot be recovered, and a removed runner may leave no readable history. Use this API to look at recent behavior, not as a log archive.
