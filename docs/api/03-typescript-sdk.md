# TypeScript SDK

**Responsibility:** define the non-Effect client experience.  
**Authority:** API design.  
**Owner role:** SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

`durable-actors/client` is the browser-safe Promise client. It is derived from the same actor definitions, runtime schemas, errors, and OpenAPI surface as the Effect API; it is not a second runtime.

`X.client({ baseUrl, headers, timeoutInMs, fetch })` creates a client. Its `get`, `create`, and singleton accessors follow the actor's identity mode. Commands and queries return Promises, event feeds and server streams are `AsyncIterable`, and connections combine an async frame stream with typed `send` and `close` operations.

Each command accepts a trailing `{ commandId, signal }` options bag. The client mints a command ID when omitted and reuses it across delivery retries. Aborting or timing out only stops waiting; it does not roll back accepted work. Retrying with the same ID replays the durable receipt, while reusing it with different input fails with `CommandConflict`.

Declared application errors are thrown as their schema-defined classes. Framework failures use `ActorError` with a typed `reason`, `isRetryable`, and `retryAfter`; transport decoding additionally exposes `InvalidInput`, `Unauthorized`, and `TransportError` reasons. Effect callers catch the wrapper with `Effect.catchTag("ActorError")` or branch with `Effect.catchReasons`. OpenAPI is the supported input for external client and tool generators.
