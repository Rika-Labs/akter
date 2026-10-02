# ADR 0058: The offline command queue

**Status:** implementation decision (2026-09-30).

**Amended (2026-09-30):** a saved command also records `principal`, the client's `identity` (or, without one, the `iss` and `sub` of its `Bearer` JWT), never a credential. A client sends only the commands saved under the principal it runs as now, read before every save and every attempt; another principal's commands are `held` in `pending` until that principal signs back in or the application discards them. An offline client with neither an `identity` nor a JWT refuses to queue. Before this, commands one user queued on a shared store were sent with the next user's credential.

**Responsibility:** specify the persisted command queue of the Promise client: what it stores, when it sends, in what order, and when it gives up, without ever changing a command's identity.
**Authority:** design.
**Owner role:** SDK/runtime.
**Change policy:** supersede through an ADR when the stored record, the ordering, or the expiry rule changes.

## Context

[ADR 0014](0014-adoption-observation-and-client-reach.md) decided that the Promise client may persist commands and replay the original command ids, and that an expired id surfaces as a conflict instead of being replaced. [Contract 04](../contracts/04-receipts.md) makes the id the only deduplication key: a retry within the horizon replays the receipt, and an expired id is refused even after cleanup. [ADR 0027](../decisions/0027-served-protocol.md) already lets a caller mint an id ahead of a call, and the client's own retry loop keeps an id for as long as one call waits. What was missing is an id that outlives the call, the tab, and the page.

## Decision

1. **Opt in with a store.** `X.client({ offline })` takes an `OfflineStore` (`entries`, `save`, `remove`). `Offline.indexedDb(name)` keeps one record per command in the database `akter:<name>`; `Offline.memory()` keeps them in memory for tests. Without `offline`, the client is unchanged. Queries, streams, feeds and connections never use the queue.
2. **Save, then send.** A command call encodes its input once, mints its id (or takes the caller's), and saves `{ commandId, sequence, baseUrl, target, member, body, status }` before the first attempt. If `save` fails the call rejects with `OfflineStoreError` and nothing was sent. Credentials are never stored; `headers` is read again for every attempt, so a refreshed token keeps the id. The body is the command payload, so an application that stores private payloads on a device chooses that by passing a store.
3. **One id, forever.** Every attempt, in every session, sends the stored id and the stored bytes. The queue never mints, refreshes, or replaces an id. A duplicate delivery, whether from a lost reply, a crash between the reply and the removal, or a second tab reading the same store, is a retry of the same id that the receipt answers, so the handler runs once.
4. **Order per actor, in call order.** Commands of one actor are sent one at a time in the order they were called, including when an earlier call's id took longer to mint. A command waits for the earlier ones to be answered, so it cannot overtake one that is waiting for the network. Different actors are independent. A command that expired or was rejected for good does not hold back the ones after it. Order is kept within a client; tabs sharing one store each deliver what they read and are not ordered against each other.
5. **When to retry.** Retryable failures are retried with the client's own delays, honoring `retryAfter`, until the id's retry deadline (the same one the online client uses); the browser's `online` event and `flush()` skip the wait. A rejected credential stops that actor's queue without dropping anything, and it resumes on `flush()` or when another command is queued for the actor.
6. **Expiry is explicit.** A command is not sent, and not retried, once its id's retry deadline has passed by the client's database-clock estimate, and it is not retried when the server answers `CommandExpired`. It becomes `expired`: its caller, if any, is rejected with `CommandExpired` carrying the id, and the record stays saved until the application calls `discard(commandId)`. The window is the deployment's retry window, so the queue cannot outlive it whatever `keepReceipts` says. Expiry says nothing about whether an earlier attempt committed. Sending the same operation again is a new call with a new id.
7. **Terminal answers stay visible.** A declared failure or other non-retryable answer marks the command `failed` and keeps the server's answer, so a later session decodes it as the same declared error. A committed command is removed after its caller is answered; if removal fails, the failure is reported with `reportError` and the next session replays the receipt.
8. **Calls stay Promises.** A command call resolves with its output once the server answers. `timeoutInMs` and `signal` stop the wait with `Timeout` carrying the id, as before, but the command stays queued and is still delivered; a call aborted before its command was saved queues nothing. `client.offline` exposes `pending`, `subscribe`, `flush`, `discard`, `close` and `ready`. Repeating a queued id with the same input joins the queued command; with different input it fails `CommandConflict` locally.
9. **Reducers.** An optimistic reducer stays applied through the outage and follows the command's real delivery, not the caller's timeout. After a reload the view shows committed state until the replayed commands land; the commands themselves are in `pending`.
10. **Minting offline.** With a store, a mint that cannot reach the server within three seconds uses the retry window and clock offset this page last learned; the queue reads `/protocol` once it is ready so both are known. A page that has never reached the server has neither, and its calls reject with the network error instead of guessing a window.

## Alternatives

- **A new id when the old one expires.** It turns an unknown outcome into a possible duplicate ([ADR 0014](0014-adoption-observation-and-client-reach.md)).
- **Dropping failed and expired commands.** A user's message would vanish silently after a reload; the application decides with `discard`.
- **A promise that stays open until the command commits.** It cannot survive a reload and hides the queued state. Keeping the call's timeout and adding `pending` says which commands wait.
- **Ordering across tabs with locks.** Receipts already make a duplicate safe, and the browser lock API is not available everywhere; it can be added without changing the record.
- **A React hook in this slice.** `useCommand` already keeps one id per intent and shows `expired`; `client.offline.subscribe` plugs into `useSyncExternalStore` directly.

## Consequences and evidence

`conformance/offline.ts` runs against a served runtime on PGlite and Postgres: queueing through an outage and replaying in order once each, a lost reply replayed after a reload, expiry of a saved command and of an explicit id, joining and receipt replay of a repeated id, per-actor ordering, a terminal failure decoded after a reload, a rejected credential, a failed save, and an optimistic reducer through an outage. `client/offline/queue.test.ts` and `client/offline/store.test.ts` cover the queue against fake attempts, and both stores against one contract, with IndexedDB from `fake-indexeddb`. `apps/e2e/offline.e2e.ts` drives real Chromium and real IndexedDB: posts queued while the context is offline are delivered once each after it returns, one with its first reply lost, and posts queued behind a blocked API survive a reload.

The queue depends on the retry window: at the default 24 hours a client offline longer loses its unsent commands to `expired`. A store the browser clears (storage pressure, private windows) loses queued commands, which nothing in the client can detect. Firefox and Safari are not run.

## Revisit when

- Applications need ordering across tabs or devices.
- A server-side retention window per actor type makes the retry window an unsuitable bound.
- A generated non-TypeScript client needs the same record ([M6.6](../milestones/M6.md)).
