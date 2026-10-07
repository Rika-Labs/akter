# Customer runner logs API

`@akter/cloud-api` exports the `RunnerLogLine`, `RunnerLogPage`, `LogCursor`, `LogLimit`, `LogWait` schemas and bounds. Its `CloudApi.deployments` group exposes two authenticated reads:

| Client operation     | HTTP path                                                     |
| -------------------- | ------------------------------------------------------------- |
| `getEnvironmentLogs` | `GET /api/projects/:projectId/environments/:environment/logs` |
| `getLogs`            | `GET /api/projects/:projectId/deployments/:deploymentId/logs` |

Project and environment selectors match deployment and variable commands. An environment read follows its current deployment and returns an empty page when none is current. An explicit deployment read never broadens to other deployments. A session requires project membership; an API key requires the project's owning organization and read permission. Every resumed request establishes access again, including for suspended organizations, which remain readable. A resource in another organization returns 403 or 404. A cursor is a position, never permission to select a provider app or runner.

## Bounded reads and follow

Query fields are `since` (UTC ISO instant, default five minutes ago), `limit` (1–200, default 100), `cursor` (opaque, at most 2048 characters) and `wait` (0–20 seconds, default 0). The server clamps `since` to `[now − one hour, now]`; network latency and client clock skew never reject the advertised window boundary. With a cursor, the original position takes precedence over `since`, still bounded to the current one-hour window. Invalid or mismatched cursors return 404 `NotFound` with resource `cursor`. Malformed query types or numeric bounds are rejected by HTTP schema decoding.

The JSON response is `{ lines, cursor, more }`. A line contains `id`, `deploymentId`, `runnerId`, `at` (UTC ISO instant), `stream` (`stdout`, `stderr`, or `unknown`), `text` (at most 4096 UTF-8 bytes), and `clipped` (whether text was cut). A page contains at most 200 lines. `more` means another page is immediately available; it never signals clipped text. Fly does not reliably distinguish its merged stdout/stderr, so `unknown` is honest provider metadata rather than a guess. No platform, builder, proxy or control-plane output is included.

Read each subsequent page with the returned cursor and `wait=0` until `more` is false. Follow then continues with `wait=20`, reverting to immediate reads whenever `more` is true. Long polls return sooner when new lines become available; an empty response still contains a usable cursor. On a dropped response, repeat from the last successfully consumed page, not an unacknowledged cursor. Cancellation ends the in-flight read. Provider failure returns a typed 503 `Unavailable`, without raw provider payloads or credentials.

Environment follow switches to the new deployment when the environment's current deployment changes. It discards the previous deployment's provider position, reads the new deployment from the original bounded time window, and identifies every line with the new deployment ID. An explicit deployment read never switches.

Retention expiry may irrecoverably lose earlier output. Fly's logs API is a recent-output service with provider-controlled retention and availability, not an archive or a customer trace store. Removed runner apps may no longer have readable logs. Full customer traces in Axiom are outside the launch contract.
