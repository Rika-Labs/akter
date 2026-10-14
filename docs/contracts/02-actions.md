# Actions

Status: partially normative (0.2), owned by ADR 0125. [E1 execution](../verification/e1-execution.md) promotes Shape (synchronous handlers, declared-failure and thrown-defect discard), Context (ids, time and randomness derived from the command id and admission time, with the `akter/synchronous-actions` lint cases in `tooling/oxlint`), Determinism (`ReplayMismatch` in `snapshots/recovery.test.ts` and I9 in the seed matrix, at 10,000 seeds on Bun and Node in [T7](../verification/history/2026-10-14-t7-10000-seeds.md)), the `StateTooLarge` limit, and in Discarding staged work and Execution order and speculation the declared failure, defect and lost-append cases (F1, F2, F3, F5). Still proposal, each for want of a named scenario: Admission time (the never-decreasing clamp); the `PageMiss` rerun clause, where E6 and usage seed 8110 show a cold rerun completing once but no test asserts that nothing from the stopped run survives; the System-only rule for `cron` and `onFailure` actions; and Views.

**Responsibility:** define how an action executes, what it may touch, and what happens when it fails.  
**Authority:** normative 0.2 target on `main`.  
**Owner role:** runtime architecture.  
**Change policy:** update the failure matrix and the [durability contract](03-durability.md) with every execution change.

## Shape

An action handler is `(draft, payload, ctx) => void | Fails | Success`, declared with `Actor.action(payload?, { success?, fails?, cron? })` and implemented in the actor's one `X.toLayer` ([ADR 0128](../decisions/0128-constrained-actor-api.md)).

- The handler MUST run synchronously. A handler that returns a `Promise`, an `Effect` or any thenable, or that suspends, MUST fail with the `SynchronousActionViolation` defect.
- `draft` is a copy-on-write view of the actor's durable-or-speculative state, including its lists. Changes MUST be staged and applied only when the handler returns normally with a non-failure result.
- Returning an instance of the declared `fails` error MUST discard the draft and every staged effect, and MUST record that error as the action's outcome.
- Returning a value MUST record it, encoded with the `success` schema, as the outcome; returning nothing records `void`.
- A thrown value MUST be treated as a defect: draft and staged effects discarded, the defect recorded as the outcome, the activation left resident.

## Context

`ctx` MUST expose exactly these capabilities:

| Member                                       | Requirement                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `caller`                                     | the admitted caller, narrowed by the actor's `access` guard                                                      |
| `now()`                                      | the recorded admission time in epoch milliseconds; the same value for every call within one action and on replay |
| `id()`                                       | the next UUIDv8 derived from the command id and a per-action ordinal; the same sequence on replay                |
| `random()`                                   | the next value of a generator seeded from the command id; the same sequence on replay                            |
| `self`                                       | the actor's own id                                                                                               |
| `send(Target, id).<action>(payload)`         | stages a one-way action ([messaging](05-messaging.md))                                                           |
| `schedule(durationOrDate).<action>(payload)` | stages a timer on this actor ([background work](08-background-work.md))                                          |
| `start.<job>(payload, { key? })`             | stages a job start                                                                                               |
| `emit.<event>(value)`                        | stages an event ([realtime](07-realtime.md))                                                                     |
| `connection`                                 | the connection id; present only in `connect` and `disconnect`                                                    |

An action MUST NOT have any other capability: no I/O, no clock, no randomness, no service environment, no `X.client`. The lint `akter/synchronous-actions` MUST reject `Date`, `Math.random`, `crypto`, `performance`, `process`, `globalThis`, `Promise`, `async` and `await` in action and view handlers, and MUST also reject non-exact `Math` functions (`floor`, `ceil`, `round`, `trunc`, `abs`, `min`, `max` and `sign` are allowed), the `**` operator, `Intl`, `toLocale*`, `localeCompare`, `toString(radix)`, reads of `error.message` or `error.stack`, and `structuredClone`.

## Admission time

Admission time MUST be the shard owner's wall clock at admission clamped to never decrease within the shard (`at = max(wallClock, previousAt)`), MUST be recorded in the action's log entry, and MUST be the value of `ctx.now()`. It MUST NOT come from a served or client clock.

## Execution order and speculation

- Actions on one actor MUST execute one at a time in admission order.
- An action MAY run on the speculative result of earlier actions of its shard whose segment is not yet durable. Speculative state MUST NOT be visible outside the shard owner ([durability](03-durability.md)).
- A send to an actor on the same shard MAY execute immediately; its entry MUST follow the sender's in the same shard log so that losing the sender's segment loses the dependent entry too.

## Discarding staged work

Every outcome other than success MUST discard, as one unit: the draft (state and list changes), staged sends, staged timers, staged job starts and staged events. A discarded action MUST leave no trace except its recorded outcome. This applies to:

- a returned declared failure;
- a defect (`SynchronousActionViolation`, `StateTooLarge`, a thrown value, a payload or state decode failure);
- `PageMiss`: an action that touches a list page not in memory MUST stop, the runtime MUST load the pages it needs and MUST rerun the action from the start with the same command id, admission time, `id()` sequence and `random()` sequence; nothing from the stopped run survives, and `PageMiss` MUST NOT reach the caller;
- a failed or unknown append: every action in the lost segment, and every same-shard action that ran on its result, MUST be discarded and MUST NOT publish anything.

## Limits

- State without lists MUST be at most 256 KiB encoded; an action whose result exceeds it MUST fail with the `StateTooLarge` defect.
- An action that names a `cron` option, or that is the `onFailure` target of a job, MUST accept only `System` callers.

## Determinism

- Every action log entry MUST record its encoded outcome. Replaying an entry whose outcome differs MUST raise the `ReplayMismatch` defect, stop the shard and report the command id; the mismatched outcome MUST NOT be published.
- `Simulation` MUST run each action twice against cloned state and compare outcomes and staged effects (I9).

## Views

A view handler `(state, params, ctx) => value` MUST be synchronous, MUST read durable state only, MUST stage nothing, and has `ctx.caller` and `ctx.self` only.

## Verification

F1 (declared failure, defect and `PageMiss` discard all staged work, including a dependent same-shard send), F2 (an action that awaits or returns a promise changes nothing), F3 (same-shard send whose sender segment is lost), F5 (crash between execution and append); I9 on Node and Bun.
