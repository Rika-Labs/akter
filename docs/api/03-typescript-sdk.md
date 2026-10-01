# TypeScript SDK

**Responsibility:** define the non-Effect client experience.  
**Authority:** API design.  
**Owner role:** SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

`@rikalabs/akter/client` is the browser-safe Promise client. It is derived from the same actor definitions, runtime schemas, errors, and OpenAPI surface as the Effect API; it is not a second runtime. It also exports `Inspection`, the schemas of the runtime's inspection responses, so a browser tool decodes what the inspector serves without restating its shape.

`X.client({ baseUrl, headers, timeoutInMs, fetch, commandIds, offline })` creates a client. Its `get` and `create` accessors follow the actor's `key`. Commands and queries return Promises, event feeds and server streams are `AsyncIterable`, and connections combine an async frame stream with typed `send` and `close` operations. A connection's frames arrive as `{ frame, cursor?, event? }` envelopes; after an ungraceful owner death the client receives `Resync { after }`, resynchronizes, and acknowledges with `ResyncDone` ([ADR 0023](../decisions/0023-connections-parking-and-streams.md); M3.5). A member that opts into executor progress ([ADR 0030](../decisions/0030-executor-progress-frames.md)) also yields `Progress { job, jobId, attempt, seq, frame }` messages, whose `frame` is decoded by that job's `progress` schema. Over WebSocket they arrive as the server message `t: "progress"` with `job`, `jobId`, `attempt`, `seq`, and `frame` and no `cursor` or `event`, never inside a `frame` message; this amends ADR 0027, and clients ignore a `t` they don't know. Progress is best-effort and display-only: it may be coalesced or dropped, a loss followed by a later frame of the same attempt shows as a `seq` gap, and it is never replayed after `Resync` or a reconnect. SSE event feeds carry no progress.

Reducers run optimistically: calling one applies its `reduce` to the client's copy of committed state immediately, re-applies pending inputs over each committed state the server pushes, and drops the input when its receipt arrives, rolling it back if the receipt is a failure. Every handle exposes `state` as committed state plus pending inputs. Queries carry the handle's last-seen commit version, so the nearest caught-up replica can answer with read-your-writes consistency. See [ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md).

Each command accepts a trailing `{ commandId, signal }` options bag. The client mints a command ID when omitted and reuses it across delivery retries. Aborting or timing out only stops waiting; it does not roll back accepted work. Within the external retry horizon, an authorized retry with the same ID replays the durable receipt, while reusing it with different input fails with `CommandConflict`.

A client is never trusted: the server's auth provider turns each request into a `User` or `Anonymous` caller, and the served actor's `access` policy (with the runtime's optional `authorize`) decides what it may do. An actor that declares neither answers `403` `Unauthorized` `access_denied` to every client call ([ADR 0059](../decisions/0059-caller-and-tenant-defaults.md)); `Actor.access.public` opens one to anyone, for demos.

Stored outcomes require the original logical caller's current access or explicit operator authority. Rotating credentials for that same caller does not change command identity. Revocation blocks new external calls and result reads without implicitly canceling accepted work.

Expired command identities are rejected even after receipt cleanup. Automatic retries must preserve the original identity and any required expiry metadata; the client must not replace an expired id to keep retrying. A fresh id is an explicit new operation, and expiry does not prove the earlier operation failed. The client mints v1 ids against the server's database clock, which it learns from `GET /protocol` and every response's `durable-now`, and sends them as `Idempotency-Key`; `client.commandId()` mints one ahead of a call. It retries retryable reasons and transport failures with the same id, honoring `retryAfter`, until `timeoutInMs`, `signal`, or the id's expiry, and never mints a replacement id on its own: not after `CommandExpired`, and not after `InvalidCommandId`. An id rejected as `future` is retried unchanged once the server clock passes it. After `window` or `version`, the error says whether every attempt was answered with a proof of non-admission, and only then may the caller choose to send the operation again under a new id. Headers may be a function called per attempt, so a refreshed credential keeps the id. Queries send the greatest `durable-version` the client has seen as `durable-min-version`. See [ADR 0027](../decisions/0027-served-protocol.md) and [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md).

Declared application errors are thrown as their schema-defined classes. Framework failures use `ActorError` with a typed `reason`, `isRetryable`, and `retryAfter`. `InvalidInput` and `TransportError` belong only to the HTTP/Promise boundary, not typed in-process Effect handles. Each Effect method narrows its framework failures through `ActorError.Of<Reasons>` rather than adding every possible reason.

## Implemented subset (M3.4)

Commands, queries, and optimistic reducers over HTTP are implemented, and so are event feeds, streams, and connections (M3.5). No server pushes committed state yet: a handle learns committed state from each non-batched reducer's reply and from `handle.state.reconcile(committed)`, such as with a state a query read.

- **Event feeds.** `handle.events(Event, { after?, signal? })` is an `AsyncIterable` of `{ cursor, event, commandId, timestamp }` (`timestamp` in epoch milliseconds) over the actor's SSE feed, for events the actor type lists in `feeds`. It is read over `fetch`, so it sends `headers` like a command. When the response drops, goes 45 seconds without a byte (the server sends a keepalive every 15), or ends with a retryable reason, the feed reopens with `Last-Event-ID` set to the last cursor it delivered, after `retryAfter` (from the envelope or the `Retry-After` header, never sooner) or a jittered backoff. A feed ended by `Unauthorized expired` reopens once with fresh headers. It throws `RetentionGap` when events after the cursor were pruned, `UnknownCursor` for a cursor the actor never issued, and `ActorError` for any other failure, including `NotCreated` for an actor no command has created yet. `break` or `signal` closes it.
- **Watches.** `handle.Query.watch(input?, { signal? })`, on a query declared `watch: true`, is an `AsyncIterable` of the query's decoded outputs: the current result, then the newest result after each change. It is state, not history, so it skips intermediate results and never repeats an unchanged one. A dropped connection is reopened after a jittered backoff with the greatest version any result carried as `durable-min-version` (or the client's read-your-writes token before the first result), so its first result is never older than one already delivered. It throws the query's declared error as its class or the `ActorError` that ended it when a retry cannot help (`Unauthorized`, `NotCreated`, `InvalidInput` `not_watchable`); a retryable end or an expired credential is retried once. `signal` ends the iteration.
- **Streams.** `handle.Member(input?, { signal? })` subscribes once and is an `AsyncIterable` of the member's decoded outputs. It ends when the stream ends by itself. It throws the member's declared error as its class, or the `ActorError` that ended it (`SessionEnded` `ActivationEnded`, `SlowConsumer`, or `Unauthorized`). A response that closes without `end` throws a retryable `TransportError` `network`. Streams have no cursor, so the client never resubscribes by itself.
- **Connections.** `handle.Member.connect(params, { signal?, onResync? })` opens a WebSocket (`ws:` or `wss:` from `baseUrl`, resolved against the page when relative) and sends the `authorization` header from `headers` in `hello`, because browsers can't set headers on a socket. It resolves once the server sent `open`, with `{ connectionId, cursor, messages, frames, send, close }`. It rejects with the member's declared `open` failure as its class, or with an `ActorError`. `messages` yields, in order:
  - `Frame { frame, cursor, event }`. Frames whose `event` the client already delivered are dropped after a resync.
  - `Resync { after, reason, deadline }`.
  - `ResyncReplayed`.
  - `Progress { job, jobId, attempt, seq, frame }`, for a member with `progress: { jobs }`. `frame` is decoded by the job's `progress` schema and typed by it: the message type is a union over the jobs the member lists, so narrowing on `job` types `frame`, as in `if (message.job === "Render") message.frame.percent`. `ProgressUpdate`, `ProgressMessage`, and `ProgressOfConnection<Member>` from `@rikalabs/akter/client` name these types; a member that lists no jobs has no `Progress` message, and code written against no particular member sees `job: string` and `frame: unknown`. Only connections carry progress to a client, so the types come per job, not per command. A progress message whose job the member doesn't list, or whose frame doesn't decode, is dropped, because progress is lossy anyway.

  A message whose `t` the client doesn't know is ignored; one that isn't valid JSON, or a known `t` with the wrong shape, ends the connection with `TransportError` `decode`. `frames` yields only the decoded member frames, without resync notices or progress. Iteration ends on a normal close and throws the session's `ActorError` otherwise. A socket that drops without `end` is `SessionEnded` `HolderLost` with `resync: true`, and the caller reconnects: a connection is not reopened automatically, because a new one has a fresh session. After `Resync`, the client calls `onResync({ after })` and acknowledges with `resyncDone` once it settles, and again after `resyncReplayed`, because the holder ignores an acknowledgment that comes before the member's own replay. On `reauthenticate`, the client calls `headers` again and sends its `authorization`.

`rooms.get(id)` returns the same handle for the same id while it has pending inputs or listeners. `handle.state` is `{ current, pending, subscribe, reconcile }`:

- Calling a reducer applies its `reduce` to a copy of `current`'s committed state at once and appends its input to `pending`. Until committed state is known, `current` is `undefined`.
- A handle sends its reducer calls one at a time in call order, each with its own command id and the usual retries, so each non-commutative reply is the committed state before every later pending input. A call's `timeoutInMs` and `signal` include its wait behind earlier calls; one stopped while waiting is never sent. `pending` returns copies of its inputs.
- A success receipt removes the input. A non-batched reducer's reply replaces committed state; a batched reducer replies nothing, so its `reduce` is applied to committed state.
- A failure (a declared error, or any `ActorError`, including `Timeout`) removes the input and rethrows; `current` becomes committed state with the remaining inputs. A timed-out call may still commit; the next reply or `reconcile` shows it.
- After every change, `current` is recomputed from committed state and `pending` in order, and each `subscribe` listener is called with it. An input whose `reduce` fails, throws, or returns a state the schema rejects is skipped in `current`; the server decides its receipt.
- `reconcile` replaces committed state and reapplies `pending`, so a state read before a pending input committed can show that input twice until its receipt arrives.

`state` is a reserved member tag, like `ref`.

```ts
import { Actor } from "@rikalabs/akter"
import { Result, Schema } from "effect"

class TooMany extends Schema.TaggedError<TooMany>()("TooMany", {}) {}
const TallyState = Actor.state({ count: Schema.Int })
const Add = Actor.reducer("Add", {
  state: TallyState,
  payload: Schema.Struct({ by: Schema.Int }),
  error: TooMany,
  reduce: (state, { by }) =>
    state.count + by > 10
      ? Result.fail(new TooMany())
      : Result.succeed({ count: state.count + by }),
})
const Snapshot = Actor.query("Snapshot", { success: Schema.Struct({ count: Schema.Int }) })
const Tally = Actor.make("Tally", { key: Schema.String, state: TallyState, api: { Add, Snapshot } })
const tallies = Tally.client({ baseUrl: "/api" })
declare const render: (state: { readonly count: number } | undefined) => void

const tally = tallies.get("t1")
tally.state.reconcile(await tally.Snapshot())
const unsubscribe = tally.state.subscribe((state) => render(state))
const reply = tally.Add({ by: 2 }) // tally.state.current shows the +2 now
await reply // committed state from the reply; or throws TooMany and rolls back
```

```ts title="room/contract.ts"
import { Actor } from "@rikalabs/akter"
import { Schema } from "effect"
export const RoomId = Schema.NonEmptyString.pipe(Schema.brand("RoomId"))
export const Post = Actor.command("Post", {
  payload: Schema.Struct({ body: Schema.String }),
  success: Schema.String,
})
export const History = Actor.query("History", {
  payload: Schema.Struct({}),
  success: Schema.Array(Schema.String),
})
export const Room = Actor.make("Room", { key: RoomId, api: { Post, History } })
```

```ts
import { ActorError } from "@rikalabs/akter/client"
import { Room, RoomId } from "./room/contract.ts" // definitions and schemas only

declare const token: () => string
declare const signal: AbortSignal

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

A void member resolves `undefined` from its `204`, and an output the server wrote as `null` for `undefined` decodes back to `undefined`. Clients of one `baseUrl` share its clock samples, retry window, and `durable-version` token; the state of the 64 most recently used base URLs is kept, and a client keeps the state it was created with. `Actors.serve` issues `durable-version` on every committed or replayed command, so a query after a client's own command reads it even from a lagging replica ([ADR 0052](../decisions/0052-read-your-writes-commit-versions.md)). The clock uses the lowest-latency sample of the last minute (at most 16 are kept) and ignores round trips over 5 seconds and every 504; with no sample from the last minute, the client reads `/protocol` again before minting, takes the id from `/command-ids` when that read leaves no sample either, and a `window` refusal makes it re-read the retry window. A minted id is issued at least a second, or one round trip, behind the estimated database clock, capped at a quarter of the retry window but never below half the round trip. Retries stop a second before the id expires. A `retry-after` header gives delay seconds or an HTTP date; a date is measured from the response's `date` less the time since the request was sent, or from the local clock without one. Without a `retryAfter`, the delay backs off from 100 ms to at most 2 seconds.

A call rejects with:

- the declared error's class, for a declared failure, replayed identically on retry;
- `ActorError` with the served reason (`CommandExpired`, `CommandConflict`, `InvalidCommandId`, `Unauthorized`, `NotCreated`, `MailboxFull`, `RunnerAtCapacity`, `ActorUnavailable`, `Timeout`, `InvalidInput`) and its `isRetryable` and `retryAfter`;
- `ActorError` with `Timeout` when `timeoutInMs` or `signal` stops the wait. A command's `Timeout` carries its command id: the outcome is unknown and a retry with that id is safe. A query's, or a command's stopped before any id existed, has no `commandId`;
- `ActorError` with `TransportError` for a response the server didn't describe: `network` for a failed fetch, `status` for a status without an envelope (retried for 408, 429, and 5xx), `decode` for a success body the `success` schema rejects, and `defect` for the server's opaque 500, which carries nothing but its status.

`InvalidCommandId` from the client carries `neverAdmitted: true` only when the client minted the id itself, every attempt with it was answered with that refusal, and no other call with the id is still waiting, so no turn can have run under it. Only then is resending under a new id a retry rather than a second operation.

Effect callers can catch the wrapper with `Effect.catchTag("ActorError")` or branch with `Effect.catchReasons`. On Effect `4.0.0`, omitting `orElse` retains the full `ActorError` in `E`; branching is not automatically exhaustive error-channel elimination. See the [error contract](../contracts/error-model.md). OpenAPI is the intended input for external client and tool generators.

## React (CR.6)

`@akter/react` wraps the Promise client in hooks. Every hook talks to the server only from effects and event handlers, so rendering on a server does no I/O: state hooks return `undefined` and feeds and connections start empty.

- `useActor(client, id)` returns `client.get(id)`, stable while `client` and `id` are.
- `useCommand(client, (input, options) => handle.Member(input, options))` holds one user intent. `run(input)` mints a command id with `client.commandId()` before sending and passes it in `options`. `retry()` sends the same input under the same id, so a retry after a lost response or a timeout replays the receipt instead of running the command twice. `state` is `idle`, `pending`, `success` with `data`, or `error` with the failure and `expired`. `expired` is true for `CommandExpired`: `retry` cannot help, and a new `run` is a new operation. `reset()` forgets the intent.
- `useQuery(query, deps)` runs `query({ signal })` on mount and when `deps` change. Only the latest read updates `{ data, error, loading }`; `refetch()` reads again.
- `useWatch((options) => fleet.View.subscribe(filter, options), deps)` follows a served fleet view the same way, where `fleet` is `fleetClient([View], options)` ([fleet views](04-drizzle.md#fleet-views)).
- `useWatch((options) => handle.Query.watch(input, options), deps)` follows a watched query. It returns the newest result as `data` and the `error` that ended the watch; an actor no command has created yet (`NotCreated`) is asked for again every 500 ms, as `useEventFeed` does. The Promise client itself treats `NotCreated` as final; waiting for creation is the hooks' choice, and unmounting stops the wait at once. `deps` is named by the caller, as for `useEffect`.
- `useEventFeed(handle, Event, { after?, storageKey? })` follows `handle.events`. It returns the `entries` delivered since mount, the last `cursor`, the `error` that ended the feed, and `gap` when that error is `RetentionGap`, which is never skipped. With `storageKey`, each delivered cursor is written to `sessionStorage`, and a remount or reload resumes after it. A feed of an actor no command has created yet (`NotCreated`) is asked for again every 500 ms.
- `useConnection(handle.Member, params, { key?, onResync?, keep? })` holds one connection while mounted with the same member and session key. Primitive params (or none) are their own key; object params require `key`, a string, number, or boolean, and do not compile without one. A new key closes the connection and opens one with that render's params; params that change under the same key are not sent. It returns `status` (`connecting`, `open`, or `closed`), the latest `keep` frames (default 100), the latest `keep` executor `progress` messages (default 100; the Promise client's `Progress` messages, typed by job as above, and display-only, so a `seq` gap within one `jobId` and `attempt` is a dropped one), the `error` that ended it, and `send`. A closed connection is not reopened by itself, because a new one is a new session.
- `useActorState(handle)` is the handle's `state`: committed state with pending optimistic reducer inputs applied, through `useSyncExternalStore`.

The chat example's `/react/rooms/<id>` page uses every hook under `StrictMode`.

## Offline queue (M6.5)

`X.client({ baseUrl, offline: Offline.indexedDb("chat") })` saves every command before its first attempt and delivers it under the id it was saved with, across outages, reloads, and lost replies ([ADR 0058](../decisions/0058-offline-command-queue.md)). `Offline.indexedDb(name)` keeps one record per command in the IndexedDB database `akter:<name>`; `Offline.memory()` keeps them in memory. Any object with `entries()`, `save(command)`, and `remove(commandId)` is an `OfflineStore`. Each command is saved under the client's `identity`, a stable key for the signed-in user (never a credential); without one, the key is the `iss` and `sub` of an `authorization: Bearer` JWT, and an offline client with neither refuses to queue. Only the current principal's commands are sent: another's show as `held` until that user signs back in or the application discards them, so a shared device never sends one user's commands as another.

```ts
import { Offline, type PendingCommand } from "@rikalabs/akter/client"
import { Room, RoomId } from "./room/contract.ts"

declare const user: string
declare const commandId: string
declare const render: (pending: ReadonlyArray<PendingCommand>) => void

const rooms = Room.client({
  baseUrl: "/api",
  identity: () => user,
  offline: Offline.indexedDb(`chat:${user}`),
})
const queue = rooms.offline! // undefined without `offline`

queue.subscribe((pending) => render(pending)) // { commandId, target, member, input, status, failure }
await rooms.get(RoomId.make("lobby")).Post({ body: "on a plane" }) // resolves once the server answers
await queue.discard(commandId) // the only way to resolve an `expired`, `failed`, or `held` command
```

- **Calls stay Promises.** A command resolves with its output once the server answers. `timeoutInMs` or `signal` stops the wait with `Timeout` carrying the command id, as always, but the command stays queued and is still delivered. A call aborted before its command was saved queues nothing.
- **Order.** Commands of one actor are sent one at a time in call order; different actors are independent. A command that expired or was rejected for good does not hold back later ones. Tabs sharing a store deliver what they read, and a duplicate is a retry the receipt answers.
- **Retries.** Retryable failures wait as online retries do, until the id's retry deadline; the browser's `online` event and `queue.flush()` skip the wait. A rejected credential stops that actor's queue, keeping its commands, until `flush()` or another command for the actor.
- **Expiry.** A command whose id passed its retry window is never sent and is never given a new id. Its caller is rejected with `CommandExpired`, and it stays in `pending` as `expired` until `discard`. A declared or other final failure stays as `failed` with the server's answer, decoded again after a reload. A repeated id with the same input joins the queued command; with other input it fails `CommandConflict`.
- **Failures of the store.** A command that could not be saved rejects with `OfflineStoreError` (`operation` `save`) and was never sent. An unreadable store rejects `queue.ready` and every later call with `OfflineStoreError`. A failed removal after a commit is reported through `reportError` and the receipt answers the replay.
- **Minting.** With a store, a mint that cannot reach the server within three seconds uses the retry window and clock offset this page last learned; a page that never reached the server rejects with the network error.
- **React.** `useCommand` needs nothing more: `run` mints its id through `client.commandId()`, which works offline, the queued command keeps that id, and `retry` joins it or replays its receipt. Show the queue with `useSyncExternalStore` over `client.offline.subscribe` and `pending`, as the chat example's React page does with `?offline=1`.
- **Reducers.** An optimistic reducer stays applied while its command waits and follows the command's delivery, not the call's timeout. After a reload `handle.state` shows committed state until the queue's commands land.

Queued commands hold their input as JSON on the device. The queue never stores headers or credentials.
