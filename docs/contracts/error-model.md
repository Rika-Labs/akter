# Error model

Status: proposal (0.2), owned by ADR 0128; promoted when E1 (reasons and defects) and E4 (wire mapping) failure evidence lands, each section with its milestone. E4 wire-mapping evidence is in [E4 RPC and serving](../verification/e4-rpc-serve.md).

**Responsibility:** define framework errors, retry metadata, defects and their wire form.  
**Authority:** normative target on `rewrite/0.2`.  
**Owner role:** API and runtime.  
**Change policy:** a reason or code change requires client compatibility review.

## One framework error

The framework MUST expose one tagged error:

```text
ActorError {
  reason: Unauthorized | InvalidInput | CommandExpired | InvalidCommandId |
          ActorUnavailable | ShardMoved | Timeout | MailboxFull |
          RunnerAtCapacity | QuotaExceeded | SessionEnded | TransportError
  isRetryable
  retryAfter
}
```

- Declared application errors (an action's `fails`) MUST remain their declared classes and MUST NOT be wrapped in `ActorError`.
- Client method signatures MUST use `ActorError.Of<Reasons>` narrowed to the reasons each member can produce. `SessionEnded` appears only on streaming members and `join`; `InvalidInput` and `TransportError` only on calls that cross a transport.
- `CommandConflict` and `NotCreated` do not exist in 0.2.

## Reasons

| Reason                                        | Meaning                                                                                                                                                        | Retry                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Unauthorized { code }`                       | `missing_credentials`, `invalid_credentials`, `expired` (credentials); `access_denied`, `outcome_access_denied`, `reauthorization_unavailable` (authorization) | `reauthorization_unavailable` is retryable by reconnecting; the rest need new credentials or access                             |
| `InvalidInput { code, issues? }`              | payload or parameters fail their schema; `issues` never carry offending values                                                                                 | no                                                                                                                              |
| `CommandExpired { commandId }`                | the external id's `expiresAt` is at or before admission time                                                                                                   | no; never retried automatically with a new id                                                                                   |
| `InvalidCommandId { commandId, code, now? }`  | `malformed`, `version`, `future` (with the owner's admission time `now`), `window`, `conflict`                                                                 | no; after `future` the same id MAY be resent once the client's clock passes `issuedAt`                                          |
| `ActorUnavailable`                            | refused before execution under overload, or a retryable failure of an admitted action; the store unreachable                                                   | yes, same id, after `retryAfter`                                                                                                |
| `ShardMoved`                                  | the shard is draining, handing off or was lost by this owner                                                                                                   | yes, same id, after `retryAfter`                                                                                                |
| `Timeout { commandId? }`                      | the caller stopped waiting; the action may still become durable                                                                                                | yes, same id                                                                                                                    |
| `MailboxFull`                                 | the actor's queue is full                                                                                                                                      | yes, same id, after `retryAfter`                                                                                                |
| `RunnerAtCapacity`                            | the shard's committer inbox or the runner's residency limit is full                                                                                            | yes, same id, after `retryAfter`                                                                                                |
| `QuotaExceeded { limit, retryAfter? }`        | a store or plan limit refused the request                                                                                                                      | only after `retryAfter`, when present                                                                                           |
| `SessionEnded { cause, resync }`              | a stream or session ended: `ClientClosed`, `ServerClosed`, `SlowConsumer`, `OwnerMoved`, `ActorUnavailable`, `Defect` or `Terminated`                          | yes by resubscribing for `SlowConsumer`, `OwnerMoved` and `ActorUnavailable`; `resync` is true when values may have been missed |
| `TransportError { code, status?, retrySafe }` | produced only by clients when no valid envelope arrived: `network`, `status`, `decode` or `defect`                                                             | when `retrySafe`                                                                                                                |

- `isRetryable` MUST be true exactly for `ActorUnavailable`, `ShardMoved`, `Timeout`, `MailboxFull`, `RunnerAtCapacity`, retryable `SessionEnded` causes, `Unauthorized` code `reauthorization_unavailable`, `QuotaExceeded` with `retryAfter`, and `TransportError` with `retrySafe`.
- `retryAfter` MUST be populated for `ActorUnavailable` (250 ms), `ShardMoved` (250 ms), `RunnerAtCapacity` (1,000 ms) and `MailboxFull` (100 ms), each jittered by ±50%. Clients MUST retry with the same command id, waiting from the error's own `retryAfter` and doubling up to the greater of 500 ms and that first wait.
- An overload refusal MUST NOT be retried inside the runtime; it reaches the caller at once. A refusal before execution MUST have written nothing, so a retry under the same id runs the action at most once.
- `Timeout`, `ActorUnavailable` after admission, and `TransportError` say nothing about whether the action became durable; only a same-id retry tells.

## Defects

Defects are not `ActorError` reasons. The caller observes a defect, its outcome is recorded, and no staged effect survives ([actions](02-actions.md)).

| Defect                       | Raised when                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `SynchronousActionViolation` | an action or view handler returned a thenable, an `Effect`, or suspended       |
| `StateTooLarge`              | an action's resulting state without lists exceeds 256 KiB                      |
| `ReplayMismatch`             | a replayed action's outcome differs from its recorded outcome; the shard stops |
| `PageCorrupt`                | a page's bytes do not match its key                                            |
| decode failure               | stored state or a payload cannot be decoded by the running build               |

## Internal errors

`StaleEpoch`, `PageMiss`, `LogUnavailable` and `StorageUnavailable` MUST NOT reach clients: a lost shard surfaces as `ShardMoved`, `PageMiss` reruns the action, and an unreachable store surfaces as `ActorUnavailable`.

## Wire form

Inside `/rpc`, a failure MUST travel in the RPC exit as the `ActorError` envelope (`_tag: "ActorError"`, `reason` with its fields, `isRetryable`, `retryAfter` in milliseconds), as `ActionFailed { error, replayed }` carrying the declared error in its own schema encoding, or as an opaque defect. A receiver MUST derive `isRetryable` and `retryAfter` from the reason, never from the envelope's copies. `ActorUnavailable` MUST NOT carry its internal cause on the wire. Refusals before the RPC handler use HTTP statuses ([protocol](protocol.md)) and also send `retry-after` in whole seconds, rounded up. Every mapping MUST preserve the reason, retry metadata, the command id when present, and declared-error identity.

## Verification

Type tests for `ActorError.Of` narrowing per member; client conformance for each reason's retry behavior with the same command id; defect tests for each class with no surviving staged effect.
