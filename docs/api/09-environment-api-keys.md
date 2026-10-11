---
title: "Environment API keys"
description: "Create, list and revoke keys for a deployed application's environment."
---

# Environment API keys

The public `@rikalabs/akter-cli/cloud-api` entry exports `CloudApi`, `EnvironmentApiKeysGroup`, `EnvironmentApiKey`, `CreateEnvironmentApiKey`, `CreatedEnvironmentApiKey` and `EnvironmentApiKeyTenant`. These are control-plane routes authenticated with the stored session or a control-plane API key, not with the application key they create.

## Routes and wire models

All routes use `/api/projects/:projectId/environments/:environment`, where `environment` is `production`, `staging` or `dev`.

| Method and suffix         | Request                             | Success                                          |
| ------------------------- | ----------------------------------- | ------------------------------------------------ |
| `POST /api-keys`          | `{ name: string, tenant?: string }` | `200 { key: EnvironmentApiKey, secret: string }` |
| `GET /api-keys`           | None                                | `200 EnvironmentApiKey[]`                        |
| `DELETE /api-keys/:keyId` | None                                | `204`, no body                                   |
| `GET /endpoints`          | None                                | `200 ProjectEndpoints`                           |

`name` uses the contract's `Name` schema (1–100 characters without leading or trailing blanks). A supplied tenant must be 1–128 characters drawn from `[A-Za-z0-9._:-]`; omission selects `default`. The key metadata is `{ id: string, name: string, tenant: string, createdAt: Timestamp, revokedAt: Timestamp | null }`. Timestamps are ISO strings on the wire and Effect `DateTime.Utc` values after decoding. Only the creation response contains `secret`; save it then. Listing includes revoked keys, ordered by creation time and id. An environment without a live deployment lists no keys, and creation fails with `Conflict` until deployed. Revoking an existing revoked key succeeds again; a key absent from the environment's live deployment fails with `NotFound` (`resource: "api-key"`). Creation and revocation require project admin access; listing requires project read access.

Use the application key as `Authorization: Bearer <secret>` at the environment's public host. Its tenant and subject are fixed by the key, and it remains attached to the environment across deployment activation. It cannot authenticate another project's host.

The already-published `projects.getEndpoints` operation returns `ProjectEndpoints`: `{ httpBaseUrl: string, webSocketUrl: string, openApiPath: string, mcpPath: string }`. The cloud currently returns `https://<environment-host>`, `wss://<environment-host>`, and empty strings for both paths, which means those paths are not advertised. A control plane without a public host returns `NotImplemented` (`operation: "projects.getEndpoints"`); do not construct a hostname from the project id.

Read operations declare `Unauthorized` (401), `Forbidden` (403), `NotFound` (404), `NotImplemented` (501) and `Unavailable` (503). Writes declare those plus `Conflict` (409). These use the shared tagged error schemas, not an additional environment-key error envelope.

See [`akter keys`](06-cli.md#akter-keys) for CLI usage. The cloud consumption of this contract follows publication; this contract addition does not migrate the cloud routes by itself.
