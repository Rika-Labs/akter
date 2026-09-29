# TypeScript SDK

**Responsibility:** define the non-Effect client experience.  
**Authority:** API design.  
**Owner role:** SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

`@durable-actors/core/client` is the browser-safe Promise client. It is derived from the same actor definitions, runtime schemas, errors, and OpenAPI surface as the Effect API; it is not a second runtime.

`X.client({ baseUrl, headers, timeoutInMs, fetch })` creates a client. Its `get` and `create` accessors follow the actor's `key`. Commands and queries return Promises, event feeds and server streams are `AsyncIterable`, and connections combine an async frame stream with typed `send` and `close` operations. A connection's frames arrive as `{ frame, cursor?, event? }` envelopes; after an ungraceful owner death the client receives `Resync { after }`, resynchronizes, and acknowledges with `ResyncDone` ([ADR 0023](../decisions/0023-connections-parking-and-streams.md); M3.5). A member that opts into executor progress ([ADR 0030](../decisions/0030-executor-progress-frames.md)) also yields `Progress { effect, effectId, attempt, seq, frame }` messages, whose `frame` is decoded by that effect's `progress` schema. Over WebSocket they arrive as the server message `t: "progress"` with `effect`, `effectId`, `attempt`, `seq`, and `frame` and no `cursor` or `event`, never inside a `frame` message; this amends ADR 0027, and clients ignore a `t` they don't know. Progress is best-effort and display-only: it may be coalesced or dropped, a loss followed by a later frame of the same attempt shows as a `seq` gap, and it is never replayed after `Resync` or a reconnect. SSE event feeds carry no progress.

Reducers run optimistically: calling one applies its `reduce` to the client's copy of committed state immediately, re-applies pending inputs over each committed state the server pushes, and drops the input when its receipt arrives, rolling it back if the receipt is a failure. Every handle exposes `state` as committed state plus pending inputs. Queries carry the handle's last-seen commit version, so the nearest caught-up replica can answer with read-your-writes consistency. See [ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md).

Each command accepts a trailing `{ commandId, signal }` options bag. The client mints a command ID when omitted and reuses it across delivery retries. Aborting or timing out only stops waiting; it does not roll back accepted work. Within the external retry horizon, an authorized retry with the same ID replays the durable receipt, while reusing it with different input fails with `CommandConflict`.

Stored outcomes require the original logical caller's current access or explicit operator authority. Rotating credentials for that same caller does not change command identity. Revocation blocks new external calls and result reads without implicitly canceling accepted work.

Expired command identities are rejected even after receipt cleanup. Automatic retries must preserve the original identity and any required expiry metadata; the client must not replace an expired id to keep retrying. A fresh id is an explicit new operation, and expiry does not prove the earlier operation failed. The client mints v1 ids against the server's database clock, which it learns from `GET /protocol` and every response's `durable-now`, and sends them as `Idempotency-Key`; `client.commandId()` mints one ahead of a call. It retries retryable reasons and transport failures with the same id, honoring `retryAfter`, until `timeoutInMs`, `signal`, or the id's expiry, and never mints a replacement id on its own: not after `CommandExpired`, and not after `InvalidCommandId`. An id rejected as `future` is retried unchanged once the server clock passes it. After `window` or `version`, the error says whether every attempt was answered with a proof of non-admission, and only then may the caller choose to send the operation again under a new id. Headers may be a function called per attempt, so a refreshed credential keeps the id. Queries send the greatest `durable-version` the client has seen as `durable-min-version`. See [ADR 0027](../decisions/0027-served-protocol.md) and [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md).

Declared application errors are thrown as their schema-defined classes. Framework failures use `ActorError` with a typed `reason`, `isRetryable`, and `retryAfter`. `InvalidInput` and `TransportError` belong only to the HTTP/Promise boundary, not typed in-process Effect handles. Each Effect method narrows its framework failures through `ActorError.Of<Reasons>` rather than adding every possible reason.

## Implemented subset (M3.4)

Commands, queries, and optimistic reducers over HTTP are implemented, and so are event feeds, streams, and connections (M3.5). No server pushes committed state yet: a handle learns committed state from each non-commutative reducer's reply and from `handle.state.reconcile(committed)`, such as with a state a query read.

- **Event feeds.** `handle.events(Event, { after?, signal? })` is an `AsyncIterable` of `{ cursor, event, commandId, timestamp }` (`timestamp` in epoch milliseconds) over the actor's SSE feed, for events the actor type lists in `feeds`. It is read over `fetch`, so it sends `headers` like a command. When the response drops, goes 45 seconds without a byte (the server sends a keepalive every 15), or ends with a retryable reason, the feed reopens with `Last-Event-ID` set to the last cursor it delivered, after `retryAfter` (from the envelope or the `Retry-After` header, never sooner) or a jittered backoff. A feed ended by `Unauthorized expired` reopens once with fresh headers. It throws `RetentionGap` when events after the cursor were pruned, `UnknownCursor` for a cursor the actor never issued, and `ActorError` for any other failure, including `NotCreated` for an actor no command has created yet. `break` or `signal` closes it.
- **Streams.** `handle.Member(input?, { signal? })` subscribes once and is an `AsyncIterable` of the member's decoded outputs. It ends when the stream ends by itself. It throws the member's declared error as its class, or the `ActorError` that ended it (`SessionEnded` `ActivationEnded`, `SlowConsumer`, or `Unauthorized`). A response that closes without `end` throws a retryable `TransportError` `network`. Streams have no cursor, so the client never resubscribes by itself.
- **Connections.** `handle.Member.connect(params, { signal?, onResync? })` opens a WebSocket (`ws:` or `wss:` from `baseUrl`, resolved against the page when relative) and sends the `authorization` header from `headers` in `hello`, because browsers can't set headers on a socket. It resolves once the server sent `open`, with `{ connectionId, cursor, messages, frames, send, close }`. It rejects with the member's declared `open` failure as its class, or with an `ActorError`. `messages` yields, in order:
  - `Frame { frame, cursor, event }`. Frames whose `event` the client already delivered are dropped after a resync.
  - `Resync { after, reason, deadline }`.
  - `ResyncReplayed`.
  - `Progress { effect, effectId, attempt, seq, frame }`, for a member with `progress: { effects }`. `frame` is decoded by the effect's `progress` schema and typed `unknown`. A progress message whose effect the member doesn't list, or whose frame doesn't decode, is dropped, because progress is lossy anyway.

  A message whose `t` the client doesn't know is ignored; one that isn't valid JSON, or a known `t` with the wrong shape, ends the connection with `TransportError` `decode`. `frames` yields only the decoded member frames, without resync notices or progress. Iteration ends on a normal close and throws the session's `ActorError` otherwise. A socket that drops without `end` is `SessionEnded` `HolderLost` with `resync: true`, and the caller reconnects: a connection is not reopened automatically, because a new one has a fresh session. After `Resync`, the client calls `onResync({ after })` and acknowledges with `resyncDone` once it settles, and again after `resyncReplayed`, because the holder ignores an acknowledgment that comes before the member's own replay. On `reauthenticate`, the client calls `headers` again and sends its `authorization`.

`rooms.get(id)` returns the same handle for the same id while it has pending inputs or listeners. `handle.state` is `{ current, pending, subscribe, reconcile }`:

- Calling a reducer applies its `reduce` to a copy of `current`'s committed state at once and appends its input to `pending`. Until committed state is known, `current` is `undefined`.
- A handle sends its reducer calls one at a time in call order, each with its own command id and the usual retries, so each non-commutative reply is the committed state before every later pending input. A call's `timeoutInMs` and `signal` include its wait behind earlier calls; one stopped while waiting is never sent. `pending` returns copies of its inputs.
- A success receipt removes the input. A non-commutative reducer's reply replaces committed state; a commutative reducer replies nothing, so its `reduce` is applied to committed state.
- A failure (a declared error, or any `ActorError`, including `Timeout`) removes the input and rethrows; `current` becomes committed state with the remaining inputs. A timed-out call may still commit; the next reply or `reconcile` shows it.
- After every change, `current` is recomputed from committed state and `pending` in order, and each `subscribe` listener is called with it. An input whose `reduce` fails, throws, or returns a state the schema rejects is skipped in `current`; the server decides its receipt.
- `reconcile` replaces committed state and reapplies `pending`, so a state read before a pending input committed can show that input twice until its receipt arrives.

`state` is a reserved member tag, like `ref`.

```ts
const tally = tallies.get("t1")
tally.state.reconcile(await tally.Snapshot())
const unsubscribe = tally.state.subscribe((state) => render(state))
const reply = tally.Add({ by: 2 }) // tally.state.current shows the +2 now
await reply // committed state from the reply; or throws TooMany and rolls back
```

```ts
import { ActorError } from "@durable-actors/core/client"
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

A `headers` provider that throws or rejects fails the call with its own error, unchanged and not retried. Retries of an id stop a second before it expires, or a quarter of its window before when the window is shorter than four seconds; until the client holds a database-clock sample from the last minute, that deadline is not applied.

A void member resolves `undefined` from its `204`, and an output the server wrote as `null` for `undefined` decodes back to `undefined`. Clients of one `baseUrl` share its clock samples, retry window, and `durable-version` token; the state of the 64 most recently used base URLs is kept, and a client keeps the state it was created with. `Actor.serve` does not issue `durable-version` yet, so until it does queries send no `durable-min-version` against it and the token gives no read-your-writes guarantee. The clock uses the lowest-latency sample of the last minute (at most 16 are kept) and ignores round trips over 5 seconds and every 504; with no sample from the last minute, the client reads `/protocol` again before minting, takes the id from `/command-ids` when that read leaves no sample either, and a `window` refusal makes it re-read the retry window. A minted id is issued at least a second, or one round trip, behind the estimated database clock, capped at a quarter of the retry window but never below half the round trip. Retries stop a second before the id expires. A `retry-after` header gives delay seconds or an HTTP date; a date is measured from the response's `date` less the time since the request was sent, or from the local clock without one. Without a `retryAfter`, the delay backs off from 100 ms to at most 2 seconds.

A call rejects with:

- the declared error's class, for a declared failure, replayed identically on retry;
- `ActorError` with the served reason (`CommandExpired`, `CommandConflict`, `InvalidCommandId`, `Unauthorized`, `NotCreated`, `MailboxFull`, `RunnerAtCapacity`, `ActorUnavailable`, `Timeout`, `InvalidInput`) and its `isRetryable` and `retryAfter`;
- `ActorError` with `Timeout` when `timeoutInMs` or `signal` stops the wait. A command's `Timeout` carries its command id: the outcome is unknown and a retry with that id is safe. A query's, or a command's stopped before any id existed, has no `commandId`;
- `ActorError` with `TransportError` for a response the server didn't describe: `network` for a failed fetch, `status` for a status without an envelope (retried for 408, 429, and 5xx), `decode` for a success body the output schema rejects, and `defect` for the server's opaque 500, which carries nothing but its status.

`InvalidCommandId` from the client carries `neverAdmitted: true` only when the client minted the id itself, every attempt with it was answered with that refusal, and no other call with the id is still waiting, so no turn can have run under it. Only then is resending under a new id a retry rather than a second operation.

Effect callers can catch the wrapper with `Effect.catchTag("ActorError")` or branch with `Effect.catchReasons`. On Effect `4.0.0-rc.116`, omitting `orElse` retains the full `ActorError` in `E`; branching is not automatically exhaustive error-channel elimination. See the [error contract](../contracts/error-model.md). OpenAPI is the intended input for external client and tool generators.
