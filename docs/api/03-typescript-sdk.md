# TypeScript SDK

**Responsibility:** define the non-Effect client experience.  
**Authority:** API design.  
**Owner role:** SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

`durable-actors/client` is the browser-safe Promise client. It is derived from the same actor definitions, runtime schemas, errors, and OpenAPI surface as the Effect API; it is not a second runtime.

`X.client({ baseUrl, headers, timeoutInMs, fetch })` creates a client. Its `get`, `create`, and singleton accessors follow the actor's identity mode. Commands and queries return Promises, event feeds and server streams are `AsyncIterable`, and connections combine an async frame stream with typed `send` and `close` operations.

Each command accepts a trailing `{ commandId, signal }` options bag. The client mints a command ID when omitted and reuses it across delivery retries. Aborting or timing out only stops waiting; it does not roll back accepted work. Retrying with the same ID replays the durable receipt, while reusing it with different input fails with `CommandConflict`.

Declared application errors are thrown as their schema-defined classes. Framework failures use `ActorError` with a typed `reason`, `isRetryable`, and `retryAfter`. `InvalidInput` and `TransportError` belong only to the HTTP/Promise boundary, not typed in-process Effect handles. Each Effect method narrows its framework failures through `ActorError.Of<Reasons>` rather than adding every possible reason.

Effect callers can catch the wrapper with `Effect.catchTag("ActorError")` or branch with `Effect.catchReasons`. On Effect `4.0.0-rc.116`, omitting `orElse` retains the full `ActorError` in `E`; branching is not automatically exhaustive error-channel elimination. See the [error contract](../contracts/error-model.md). OpenAPI is the intended input for external client and tool generators.
