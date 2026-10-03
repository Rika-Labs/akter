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
- **Deployments:** list, create, detail, build log, roll back, redeploy.
- **Runtime:** inspection of a deployment's actors, commands, jobs, workflows, connections and dead letters, served by asking runners through the edge ([contract 11](../contracts/11-control-plane.md)). `POST .../runtime/commands` sends one command (`address`, `command`, JSON `payload` and an optional `commandId`, minted when omitted) and answers with the actor's `result` and a `replayed` flag; an error the actor returns is a 422 `CommandFailed` with its `errorTag` and `error`. It needs write permission on the project and answers `NotImplemented` until the edge proxy exists.
- **Billing, usage and the audit log** (`/organizations/:organizationId/audit-log`).

## Errors

`Unauthorized` (401) comes from the authentication middleware. A caller without the role or key permission an operation needs gets `Forbidden` (403); the project access barrier gives that same answer for a missing project or one in another organization. After access is established, a resource absent from that scope is `NotFound` (404). A taken project slug or environment name is `Conflict` (409). An endpoint declared but not yet implemented answers `NotImplemented` (501).

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
