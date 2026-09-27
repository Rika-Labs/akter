# Generating clients

**Responsibility:** explain how to call a served actor from a client generated in any language.  
**Authority:** API guidance.  
**Owner role:** API/SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

`Actor.serve` with `openapi: { path: "/openapi.json" }` serves an OpenAPI 3.1 document (JSON Schema 2020-12) generated from the served actors. Any OpenAPI 3.1 generator can produce a client from it, for example:

```sh
curl -s localhost:3000/openapi.json > openapi.json
npx @openapitools/openapi-generator-cli generate -i openapi.json -g python -o chat-client
```

Each actor member is one operation with `operationId` `<Actor>.<Member>`. `durable.protocol` (`GET /protocol`) and `durable.commandIds` (`POST /command-ids`) are the protocol routes.

## Command ids

Every command requires an `Idempotency-Key` header, the command id `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>`. The server never mints one for a command, because a client that lost the reply to a server-minted id could not retry it.

- Mint an id before the first attempt, either with `POST /command-ids` (authenticated like a command; answers `{ commandId }` from the database clock and writes nothing) or locally from `GET /protocol`'s `now` and `retryWindowMs`, with a fresh UUIDv4.
- Store the id with the pending operation, and send the same id and the same body on every retry. The same id with the same body returns the stored result without running the command again; the same id with a different body is `409 CommandConflict`.
- The response echoes the id in `x-request-id`.
- An id older than the retry window is `410 CommandExpired`: surface it to the caller rather than minting a replacement, because an earlier attempt may have committed.

## Retries

Error bodies are `{ _tag: "ActorError", reason, isRetryable, retryAfter? }`. Retry with the same id, never a new one:

| Outcome                                                             | Retry with the same id?                   | Wait                                                 |
| ------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `503 ActorUnavailable`, `503 RunnerAtCapacity`, `429 MailboxFull`   | yes                                       | `retryAfter` ms (`retry-after` in seconds), jittered |
| `504 Timeout`                                                       | yes; the turn may have committed          | 0–250 ms of jitter                                   |
| no response (network failure)                                       | yes; the outcome is unknown               | exponential, from 100 ms, capped at 5 s, with jitter |
| `400 InvalidCommandId` with code `future`                           | yes, once `durable-now` passes `issuedAt` | until then                                           |
| `401 Unauthorized` with code `expired`                              | once, with a fresh credential             | none                                                 |
| `410 CommandExpired`                                                | no; surface it, never remint              | –                                                    |
| `409`, other `400`, `401`, `403`, `404`, `413`, `415`, `422`, `500` | no                                        | –                                                    |

Stop retrying once the id's `expiresAt` is less than a second away on the client's clock corrected by `durable-now`.

Queries take no `Idempotency-Key` and can be retried freely.

## Authentication

The document's `securitySchemes` come from the server's auth provider. Send credentials in `authorization` (or cookies for a cookie-reading provider); never in the URL. A `401` carries `www-authenticate: Bearer`.
