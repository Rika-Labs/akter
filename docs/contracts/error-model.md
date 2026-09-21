# Error model

**Responsibility:** define errors across runtime, transports, and SDKs.  
**Authority:** normative.  
**Owner role:** API/runtime.  
**Change policy:** error code changes require client compatibility review.

The framework MUST expose one tagged framework error:

```text
ActorError {
  reason: ActorUnavailable | MailboxFull | Timeout | CommandConflict |
          NotCreated | Unauthorized | InvalidInput | TransportError
  isRetryable
  retryAfter
}
```

Effect programs may catch it with `catchTag("ActorError")` or branch with `catchReasons`. Declared application errors MUST remain their declared classes and MUST never be wrapped in `ActorError`. Method signatures MUST use `ActorError.Of<Reasons>` narrowed to the reasons they can actually produce; no framework reasons means `never`. `InvalidInput` and `TransportError` are boundary-only and MUST NOT appear in a typed in-process handle's error channel.

On pinned Effect `4.0.0-rc.116`, `catchReasons` without an `orElse` retains the full `ActorError` in the error channel; do not claim exhaustive elimination without handling that remainder. Declared errors must be yieldable tagged errors; an error without `httpApiStatus` maps to HTTP 422.

`ActorUnavailable`, `MailboxFull`, and `Timeout` are retryable according to `isRetryable` and SHOULD reuse the same command id. `CommandConflict`, `NotCreated`, `Unauthorized`, and `InvalidInput` are not retryable without changing caller input or credentials. A timeout means the turn may still commit.

`Unauthorized.code` MUST carry the stable credential code, accessed as `error.reason.code` when wrapped in `ActorError`. HTTP, WebSocket, Promise client, and Effect client mappings MUST preserve the reason, retry metadata, available command id/request id, and declared-error identity.
