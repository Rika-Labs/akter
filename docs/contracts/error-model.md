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

Effect programs MUST catch it with `catchTag("ActorError")` or branch with `catchReasons`. Declared application errors MUST remain their declared classes and MUST never be wrapped in `ActorError`. `InvalidInput` and `TransportError` are boundary-only and MUST NOT appear in a typed in-process handle's error channel.

`ActorUnavailable`, `MailboxFull`, and `Timeout` are retryable according to `isRetryable` and SHOULD reuse the same command id. `CommandConflict`, `NotCreated`, `Unauthorized`, and `InvalidInput` are not retryable without changing caller input or credentials. A timeout means the turn may still commit.

`Unauthorized.reason.code` MUST carry the stable credential code. HTTP, WebSocket, Promise client, and Effect client mappings MUST preserve the reason, retry metadata, command id/request id, and declared-error identity.
