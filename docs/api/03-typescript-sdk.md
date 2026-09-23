# TypeScript SDK

**Responsibility:** define the non-Effect client experience.  
**Authority:** API design.  
**Owner role:** SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

`durable-actors/client` is the browser-safe Promise client. It is derived from the same actor definitions, runtime schemas, errors, and OpenAPI surface as the Effect API; it is not a second runtime.

`X.client({ baseUrl, headers, timeoutInMs, fetch })` creates a client. Its `get` and `create` accessors follow the actor's `key`. Commands and queries return Promises, event feeds and server streams are `AsyncIterable`, and connections combine an async frame stream with typed `send` and `close` operations.

Reducers run optimistically: calling one applies its `reduce` to the client's copy of committed state immediately, re-applies pending inputs over each committed state the server pushes, and drops the input when its receipt arrives, rolling it back if the receipt is a failure. Every handle exposes `state` as committed state plus pending inputs. Queries carry the handle's last-seen commit version, so the nearest caught-up replica can answer with read-your-writes consistency. See [ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md).

Each command accepts a trailing `{ commandId, signal }` options bag. The client mints a command ID when omitted and reuses it across delivery retries. Aborting or timing out only stops waiting; it does not roll back accepted work. Within the external retry horizon, an authorized retry with the same ID replays the durable receipt, while reusing it with different input fails with `CommandConflict`.

Stored outcomes require the original logical caller's current access or explicit operator authority. Rotating credentials for that same caller does not change command identity. Revocation blocks new external calls and result reads without implicitly canceling accepted work.

Expired command identities are rejected even after receipt cleanup. Automatic retries must preserve the original identity and any required expiry metadata; the client must not replace an expired id to keep retrying. A fresh id is an explicit new operation, and expiry does not prove the earlier operation failed. Identity format, expiry metadata, and error mappings still require the protocol/version design described in [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md); no additional options or error classes are specified here.

Declared application errors are thrown as their schema-defined classes. Framework failures use `ActorError` with a typed `reason`, `isRetryable`, and `retryAfter`. `InvalidInput` and `TransportError` belong only to the HTTP/Promise boundary, not typed in-process Effect handles. Each Effect method narrows its framework failures through `ActorError.Of<Reasons>` rather than adding every possible reason.

Effect callers can catch the wrapper with `Effect.catchTag("ActorError")` or branch with `Effect.catchReasons`. On Effect `4.0.0-rc.116`, omitting `orElse` retains the full `ActorError` in `E`; branching is not automatically exhaustive error-channel elimination. See the [error contract](../contracts/error-model.md). OpenAPI is the intended input for external client and tool generators.
