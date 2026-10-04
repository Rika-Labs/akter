# The Akter Cloud API

**Responsibility:** describe the console's control-plane HTTP API and how it is built from its contract.  
**Authority:** normative API design.  
**Owner role:** cloud API.  
**Change policy:** a change to the contract in `packages/cloud-api` is a change to this document and to every client derived from it.

`@akter/cloud-api` (`packages/cloud-api`) declares the API once as an Effect `HttpApi` named `CloudApi`: every endpoint lives under `/api`, requires `Authentication`, and is described by Schema types. `apps/api` implements it. The console builds its client from the same declaration with `HttpApiClient`, and the served OpenAPI document is derived from it, so there is no second description to keep in step. A browser carries the Better Auth session cookie and a machine client sends `x-api-key`.

## Groups

- **Account:** `me`, profile, active organization, preferences (`/me/preferences`), notifications and pinned actors (`/me/pinned-actors`).
- **Organizations, members, invitations, API keys.**
- **Projects:** list and create under `/organizations/:organizationId/projects`, then by id; environments, endpoints, variables, domains, regions and integrations.
- **Deployments:** list, create, record a successful build (`POST .../deployments/:deploymentId/build`), detail, build log, roll back, redeploy. Recording an image requires a content-addressed digest, the deployment's commit and a complete string-valued environment snapshot. An identical retry does not enqueue another rollout. A rollback names an earlier deployment that was once live and redeploys its image and environment snapshot as a new deployment whose `rolledBackFrom` is that id; the deployment it replaces ends `rolled-back` once the new one is `live`, and stays `live` if the new one fails. Unmeasured runner actor counts and CPU percentages are null. See the [deploy pipeline](08-deploy-pipeline.md).
- **Runtime:** inspection of a deployment's actors, commands, jobs, workflows, connections and dead letters, served by asking runners through the edge ([contract 11](../contracts/11-control-plane.md)). `POST .../runtime/commands` sends one command (`address`, `command`, JSON `payload` and an optional `commandId`, used as a client idempotency key and minted by the control plane when omitted) and answers with the actor's `result` and a `replayed` flag; the same key and payload reuse the durable runner assignment, while a different payload is a 409 `Conflict`. An error the actor returns is a 422 `CommandFailed` with its `errorTag` and `error`; runner admission refusals are typed 4xx `CommandRefused` errors. It needs write permission on the project and returns `NotFound` when that environment has no live deployment. A never-created actor address is valid and is created by first delivery; no inspector read is required. Per-actor jobs are mapped from the runner's inspector. Other runtime endpoints remain `NotImplemented` where that inspector cannot supply all the declared fields; counts, rates, connection state and workflow totals are never invented. The declared workflow `step.index` counts from 1 to `step.total`, and the activity and latency declarations retain their window semantics until their runner-side surfaces exist.
- **Billing, usage and the audit log** (`/organizations/:organizationId/audit-log`).

## Errors

`Unauthorized` (401) comes from the authentication middleware. A caller without the role or key permission an operation needs gets `Forbidden` (403); the project access barrier gives that same answer for a missing project or one in another organization. After access is established, a resource absent from that scope is `NotFound` (404). A taken project slug or environment name is `Conflict` (409). An endpoint declared but not yet implemented answers `NotImplemented` (501).

Temporary edge or capacity failure is `Unavailable` (503), with `retryAfterSeconds`. Command retries MUST retain their supplied `commandId`; a new id would be a new command. Invalid runner admission is a typed 4xx `CommandRefused`, not a 500; actor access denial maps to `Forbidden`, while a refused deployment credential remains `Unavailable` so an operator can repair rotation or reachability. The API's request timeout defaults to 35 seconds, leaving response slack around the edge's 30-second cold-start bound. Operators who change that edge bound must configure `RUNTIME_REQUEST_TIMEOUT_SECONDS` accordingly. A malformed runner response remains an opaque defect.

Actor-mailbox backpressure also maps to `Unavailable`, including a runner's HTTP 429 `MailboxFull`. A remote runner `Defect` maps to an opaque, non-retryable 502 `RunnerDefect`; trace details and response bodies never reach the client. Keyed sends store only canonical payload hashes and retain expired keys as 410 tombstones for 30 days, so clients must not reuse a key for at least the retry window plus 30 days.

## Durable records behind it

Projects, environments, per-user preferences, pinned actors and audit entries are read and written only through the `Repository` service in `apps/api/src/repository.ts` ([contract 11](../contracts/11-control-plane.md)). Handlers translate its domain errors to the contract's errors, map its `DateTime` values to the contract's timestamps, and add what the repository does not store: the live status of a pinned actor, and the project's environments' deployments.

| Repository operation                                                            | Contract endpoint                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `listProjects`, `getProject`, `createProject`, `updateProject`, `deleteProject` | Projects `list`, `get`, `create`, `update`, `delete` |
| `listEnvironments`, `getEnvironment`, `createEnvironment`, `deleteEnvironment`  | Projects environment endpoints                       |
| `getPreferences`, `updatePreferences`                                           | Account `getPreferences`, `updatePreferences`        |
| `getNotifications`, `updateNotifications`                                       | Account `getNotifications`, `setNotifications`       |
| `listPinnedActors`, `pinActor`, `unpinActor`                                    | Account pinned-actor endpoints                       |
| `recordAudit`, `listAudit`                                                      | Audit `list`, and any handler that records an action |

A handler checks the caller's access first (`Access.organization` or `Access.project`, whose organization it then passes to the repository), so the repository never receives an organization from a request body. Preferences need a person, not an API key, and are stored per user, not per organization. Changes made through Better Auth (organizations, members, invitations, API keys) are audited as a `requested` entry before and a completed entry after, in separate transactions, because Better Auth's own transaction cannot include the audit write.

The CLI that talks to this API is built with `effect/cli`, like every `durable` command ([CLI](06-cli.md)).
