# Customer runner logs API

`@akter/cloud-api` exports the `RunnerLogLine`, `RunnerLogPage`, `LogCursor`, `LogLimit`, `LogWait` schemas and bounds. Its `CloudApi.deployments` group exposes two authenticated reads:

| Client operation     | HTTP path                                                     |
| -------------------- | ------------------------------------------------------------- |
| `getEnvironmentLogs` | `GET /api/projects/:projectId/environments/:environment/logs` |
| `getLogs`            | `GET /api/projects/:projectId/deployments/:deploymentId/logs` |

Project and environment selectors match deployment and variable commands. An environment read follows its current deployment and returns an empty page when none is current. An explicit deployment read never broadens to other deployments. A session requires project membership; an API key requires the project's owning organization and read permission. Every resumed request establishes access again, including for suspended organizations, which remain readable. A resource in another organization returns 403 or 404. A cursor is a position, never permission to select a provider app or runner.

## Bounded reads and follow

Query fields are `since` (UTC ISO instant, default five minutes ago, no older than one hour and not in the future), `limit` (1–200, default 100), `cursor` (opaque, at most 16384 characters) and `wait` (0–20 seconds, default 0). With a cursor, the original position takes precedence over `since`. Invalid or mismatched cursors return 404 `NotFound` with resource `cursor`; invalid time windows return 404 with the same resource. Malformed query types or numeric bounds are rejected by HTTP schema decoding.

The JSON response is `{ lines, cursor, truncated }`. A line contains `id`, `deploymentId`, `runnerId`, `at` (UTC ISO instant), `stream` (`stdout`, `stderr`, or `unknown`) and `text` (at most 4096 UTF-8 bytes). A page contains at most 200 lines. Fly does not reliably distinguish its merged stdout/stderr, so `unknown` is honest provider metadata rather than a guess. No platform, builder, proxy or control-plane output is included.

Follow by saving the cursor from every successful response and repeating the same resource read with `cursor` and `wait=20`. Long polls return sooner when new lines become available; an empty response still contains a usable cursor. On a dropped response, repeat from the last successfully consumed page, not an unacknowledged cursor. Cancellation ends the in-flight read. Provider failure returns a typed 503 `Unavailable`, without raw provider payloads or credentials.

`truncated` signals additional available lines or clipped text. Continue from the cursor to read remaining lines. Retention expiry may irrecoverably lose earlier output. Fly's logs API is a recent-output service with provider-controlled retention and availability, not an archive or a customer trace store. Removed runner apps may no longer have readable logs. Full customer traces in Axiom are outside the launch contract.
