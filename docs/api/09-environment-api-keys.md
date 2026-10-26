---
title: "Environment API keys"
description: "Create, list, and revoke the keys that authorize calls to a deployed app's environment."
---

# Environment API keys

An environment API key authorizes calls to one environment of your deployed app. It is not a control-plane credential: it cannot call the cloud API, and the cloud API's session or organization key cannot call your app.

`@rikalabs/akter-cli/cloud-api` exports `CloudApi`, `EnvironmentApiKeysGroup`, `EnvironmentApiKey`, `CreateEnvironmentApiKey`, `CreatedEnvironmentApiKey`, and `EnvironmentApiKeyTenant`. To use keys from a terminal, see [`akter keys`](./06-cli.md#akter-keys).

## Routes

Every route is under `/api/projects/:projectId/environments/:environment`, where `environment` is `production`, `staging`, or `dev`. They are control-plane routes, authorized with a session or an organization API key.

| Method and path           | Request                             | Success                                          | Access |
| ------------------------- | ----------------------------------- | ------------------------------------------------ | ------ |
| `POST /api-keys`          | `{ name: string, tenant?: string }` | `200 { key: EnvironmentApiKey, secret: string }` | Admin  |
| `GET /api-keys`           | none                                | `200 EnvironmentApiKey[]`                        | Read   |
| `DELETE /api-keys/:keyId` | none                                | `204`, no body                                   | Admin  |
| `GET /endpoints`          | none                                | `200 ProjectEndpoints`                           | Read   |

A key has this shape:

```ts
{ id: string, name: string, tenant: string, createdAt: Timestamp, revokedAt: Timestamp | null }
```

`name` is 1 to 100 characters with no leading or trailing blanks. `tenant` is 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`, and defaults to `default`. Timestamps are ISO strings on the wire.

Only the create response contains `secret`. Save it then; Akter cannot show it again. A secret starts with `akrun_`.

## Behavior

- A key belongs to the environment's live deployment, and it moves to the next deployment when one is activated, so a deploy does not invalidate your keys.
- An environment with no live deployment lists no keys. Creating a key there fails with `Conflict`, so deploy first.
- The list includes revoked keys, ordered by creation time.
- Revoking a key that is already revoked succeeds. Revoking a key that is not in the environment's live deployment fails with `NotFound` and `resource: "api-key"`.
- Creating a key is refused with `Conflict` while the organization is being deleted.

## Use a key

Send the secret as a bearer token to your environment's host:

```http
Authorization: Bearer akrun_…
```

The key fixes the tenant and the caller, and it works only on its own environment's host. The application interface is `/rpc`: append it to the base URL when you configure `AkterClient.layer`.

`GET /endpoints` returns the environment's base URLs:

```ts
{ httpBaseUrl: string, webSocketUrl: string, openApiPath: string, mcpPath: string }
```

`httpBaseUrl` is `https://<environment host>` and `webSocketUrl` is `wss://<environment host>`. `openApiPath` and `mcpPath` are empty strings, which means the environment advertises no OpenAPI or MCP path. If the control plane has no public host for the environment, the route answers 501 `NotImplemented`. Do not build a hostname from the project ID.

The framework server accepts only the `default` tenant today, so a key with another tenant name is valid but cannot serve requests yet.

## Errors

Reads can answer 401 `Unauthorized`, 403 `Forbidden`, 404 `NotFound`, 501 `NotImplemented`, and 503 `Unavailable`. Writes can also answer 409 `Conflict`.
