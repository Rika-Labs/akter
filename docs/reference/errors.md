# Errors

A call to an actor can end in three ways besides success.

**A declared error.** The command returned the error it declared with `fails`. The client receives an instance of that same class, in the Effect's error channel.

**An `ActorError`.** Akter couldn't run the command, or couldn't tell you how it went. Every `ActorError` has a `reason`, an `isRetryable` flag and, for some reasons, a `retryAfter` in milliseconds.

**A `CommandDefect`.** The handler threw, or broke a rule such as returning a Promise. The command's changes were thrown away and the defect was recorded. It reaches the client as an Effect defect, not in the error channel.

## Reasons

| Reason             | What happened                                                                        | Retried by the client      |
| ------------------ | ------------------------------------------------------------------------------------ | -------------------------- |
| `Unauthorized`     | Credentials are missing, invalid or expired, or `access` said no. `code` says which. | No                         |
| `InvalidInput`     | The payload or parameters didn't match the schema                                    | No                         |
| `ActorUnavailable` | The server is overloaded or can't reach the bucket                                   | Yes                        |
| `ShardMoved`       | The actor is moving to another server                                                | Yes                        |
| `Timeout`          | The caller stopped waiting. The command may still complete.                          | Yes                        |
| `MailboxFull`      | Too many commands are queued for this actor                                          | Yes                        |
| `RunnerAtCapacity` | The server can't take more work right now                                            | Yes                        |
| `QuotaExceeded`    | A configured limit refused the request                                               | After `retryAfter`, if set |
| `SessionEnded`     | A stream or WebSocket session ended. `cause` says why.                               | Streams resubscribe        |
| `TransportError`   | No valid response arrived: a network failure, an HTTP error or a decode failure      | When `retrySafe`           |
| `CommandExpired`   | The command id was too old to accept                                                 | No                         |
| `InvalidCommandId` | The command id was malformed, or reused with a different payload                     | No                         |

The client retries the retryable reasons on its own, with the same command id, for up to ten minutes. You see one of them only when retrying didn't help.

`Timeout`, `TransportError` and an `ActorUnavailable` after the command was accepted say nothing about whether the command ran. Retry with the same id to find out: if it ran, you get its stored outcome.

## Defect kinds

| Kind                         | Raised when                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `SynchronousActionViolation` | A command or view handler returned a Promise or an Effect                           |
| `StateTooLarge`              | A command left the state, without lists, larger than 256 KiB                        |
| `ReplayMismatch`             | Replaying a command gave a different result than the recorded one. The shard stops. |
| `PageCorrupt`                | A stored page didn't match its hash                                                 |

A handler that throws produces a defect too, carrying what it threw.

`SynchronousActionViolation` keeps its name from when commands were called actions; the name is part of the stored format.

## Matching on errors

```ts
const result =
  yield *
  account.withdraw(80).pipe(
    Effect.catchTag("InsufficientFunds", (error) => Effect.succeed(error.balance)),
    Effect.catchTag("ActorError", (error) =>
      error.reason._tag === "Unauthorized" ? Effect.succeed(0) : Effect.fail(error),
    ),
  )
```
