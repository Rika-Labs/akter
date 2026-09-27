# TypeScript SDK

**Responsibility:** define the non-Effect client experience.  
**Authority:** API design.  
**Owner role:** SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

`durable-actors/client` is the browser-safe Promise client. It is derived from the same actor definitions, runtime schemas, errors, and OpenAPI surface as the Effect API; it is not a second runtime.

`X.client({ baseUrl, headers, timeoutInMs, fetch })` creates a client. Its `get` and `create` accessors follow the actor's `key`. Commands and queries return Promises, event feeds and server streams are `AsyncIterable`, and connections combine an async frame stream with typed `send` and `close` operations. A connection's frames arrive as `{ frame, cursor?, event? }` envelopes; after an ungraceful owner death the client receives `Resync { after }`, resynchronizes, and acknowledges with `ResyncDone` ([ADR 0023](../decisions/0023-connections-parking-and-streams.md); M3.5).

Reducers run optimistically: calling one applies its `reduce` to the client's copy of committed state immediately, re-applies pending inputs over each committed state the server pushes, and drops the input when its receipt arrives, rolling it back if the receipt is a failure. Every handle exposes `state` as committed state plus pending inputs. Queries carry the handle's last-seen commit version, so the nearest caught-up replica can answer with read-your-writes consistency. See [ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md).

Each command accepts a trailing `{ commandId, signal }` options bag. The client mints a command ID when omitted and reuses it across delivery retries. Aborting or timing out only stops waiting; it does not roll back accepted work. Within the external retry horizon, an authorized retry with the same ID replays the durable receipt, while reusing it with different input fails with `CommandConflict`.

Stored outcomes require the original logical caller's current access or explicit operator authority. Rotating credentials for that same caller does not change command identity. Revocation blocks new external calls and result reads without implicitly canceling accepted work.

Expired command identities are rejected even after receipt cleanup. Automatic retries must preserve the original identity and any required expiry metadata; the client must not replace an expired id to keep retrying. A fresh id is an explicit new operation, and expiry does not prove the earlier operation failed. The client mints v1 ids against the server's database clock, which it learns from `GET /protocol` and every response's `durable-now`, and sends them as `Idempotency-Key`; `client.commandId()` mints one ahead of a call. It retries retryable reasons and transport failures with the same id, honoring `retryAfter`, until `timeoutInMs`, `signal`, or the id's expiry, and never mints a replacement id on its own: not after `CommandExpired`, and not after `InvalidCommandId`. An id rejected as `future` is retried unchanged once the server clock passes it. After `window` or `version`, the error says whether every attempt was answered with a proof of non-admission, and only then may the caller choose to send the operation again under a new id. Headers may be a function called per attempt, so a refreshed credential keeps the id. Queries send the greatest `durable-version` the client has seen as `durable-min-version`. See [ADR 0027](../decisions/0027-served-protocol.md) and [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md).

Declared application errors are thrown as their schema-defined classes. Framework failures use `ActorError` with a typed `reason`, `isRetryable`, and `retryAfter`. `InvalidInput` and `TransportError` belong only to the HTTP/Promise boundary, not typed in-process Effect handles. Each Effect method narrows its framework failures through `ActorError.Of<Reasons>` rather than adding every possible reason.

## Implemented subset (M3.4)

Commands and queries over HTTP are implemented. Feeds, streams, connections, and optimistic reducers are M3.5; until then a reducer is called like a command and answered with its committed reply.

```ts
import { ActorError } from "durable-actors/client"
import { Room, RoomId } from "./room/contract.ts" // definitions and schemas only

const rooms = Room.client({
  baseUrl: "/api", // absolute, or relative to the page
  headers: () => ({ authorization: `Bearer ${token()}` }), // called for every attempt
  timeoutInMs: 10_000, // per call, retries included; default 60,000
  fetch, // optional; defaults to the global fetch
  commandIds: "client", // or "server" to take each id from POST /command-ids
})

const lobby = rooms.get(RoomId.make("lobby"))
const id = await rooms.commandId()
const messageId = await lobby.Post({ body: "hi" }, { commandId: id, signal })
const page = await lobby.History({})
```

`X.client` returns `get(id)` for keyed actors, `get()` for singletons, and `get(id)` plus `create()` for minted ones, where `create()` mints a UUIDv7 locally. Each handle method takes its input (omitted when the member has none) and `{ signal, timeoutInMs }`, plus `commandId` for commands. Routes, key encoding, input and output codecs, and the declared-error decoder come from the definition. The entry imports no runtime, SQL, Cluster, Bun, or Node module; a test walks its import graph and builds it for the browser.

Clients of one `baseUrl` share its clock samples, retry window, and `durable-version` token. The clock uses the lowest-latency sample of the last minute (at most 16 are kept) and ignores round trips over 5 seconds and every 504; with no sample from the last minute, the client reads `/protocol` again before minting, and a `window` refusal makes it re-read the retry window. A minted id is issued at least a second, or one round trip, behind the estimated database clock, capped at a quarter of the retry window but never below half the round trip. Retries stop a second before the id expires. Without a `retryAfter`, the delay backs off from 100 ms to at most 2 seconds.

A call rejects with:

- the declared error's class, for a declared failure, replayed identically on retry;
- `ActorError` with the served reason (`CommandExpired`, `CommandConflict`, `InvalidCommandId`, `Unauthorized`, `NotCreated`, `MailboxFull`, `RunnerAtCapacity`, `ActorUnavailable`, `Timeout`, `InvalidInput`) and its `isRetryable` and `retryAfter`;
- `ActorError` with `Timeout` carrying the command id, when `timeoutInMs` or `signal` stops the wait; the outcome is unknown and a retry with that id is safe;
- `ActorError` with `TransportError` for a response the server didn't describe: `network` for a failed fetch, `status` for a status without an envelope (retried for 408, 429, and 5xx), `decode` for a success body the output schema rejects, and `defect` for the server's opaque 500, which carries nothing but its status.

`InvalidCommandId` from the client carries `neverAdmitted: true` only when the client minted the id itself and every attempt was answered with that refusal, so no turn can have run under it. Only then is resending under a new id a retry rather than a second operation.

Effect callers can catch the wrapper with `Effect.catchTag("ActorError")` or branch with `Effect.catchReasons`. On Effect `4.0.0-rc.116`, omitting `orElse` retains the full `ActorError` in `E`; branching is not automatically exhaustive error-channel elimination. See the [error contract](../contracts/error-model.md). OpenAPI is the intended input for external client and tool generators.
