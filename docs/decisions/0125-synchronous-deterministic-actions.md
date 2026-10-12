# ADR 0125: Synchronous deterministic actions and the action context

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** decide what an action handler is, what it may touch, and how the engine keeps it replayable.

**Owner role:** runtime architecture.

## Context

The command log ([ADR 0124](0124-engine-rewrite-and-command-log.md)) is only a source of truth if replaying it reproduces the same states and outcomes. In 0.1 a handler is an Effect that runs inside a Postgres transaction and may run SQL, read the clock or call services ([ADR 0010](0010-one-way-effect-native-api.md), [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md)); nothing stops it from suspending or reading ambient state, and replay was never a requirement. Determinism leaks in TypeScript are ordinary: `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `performance.now()`, module-level mutable state captured by a closure, `process.env`, `Intl` output, and engine differences between V8 (Node) and JavaScriptCore (Bun) in floating-point library functions.

D23 rule 4 fixes the shape: actions are synchronous plain functions on a copy-on-write draft, with recorded time, ids and randomness.

## Decision

### 1. The handler shape

An action handler is `(draft, payload, ctx) => void | Fails | Success`:

- `draft` is a copy-on-write view of the actor's state, including its lists ([ADR 0127](0127-snapshots-pages-lists-history-gc.md)). Assignments and list operations stage changes; nothing is written until the action returns.
- Returning an instance of the action's declared `fails` error discards the draft and every staged effect and records the failure as the outcome.
- Returning a value is the reply, encoded with the action's `success` schema. Returning nothing replies `void`.
- A thrown exception, a returned `Promise`, a returned `Effect`, or a handler that suspends is a defect: the draft and staged effects are discarded, the outcome records the defect, and the activation stays resident.

The engine runs the handler with the activation's per-actor serialization (one action at a time per actor) and no `await` point between reading the draft and producing the outcome.

### 2. The action context

`ctx` holds the only capabilities an action has:

| Member                                       | Meaning                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `caller`                                     | the admitted caller, narrowed by the actor's `access` guard                                          |
| `now()`                                      | the action's admission time in epoch milliseconds, recorded in the entry; constant within one action |
| `id()`                                       | the next derived UUIDv8 from the command id and an ordinal; the same sequence on replay              |
| `random()`                                   | the next value of a generator seeded from the command id; the same sequence on replay                |
| `self`                                       | the actor's own id                                                                                   |
| `send(Target, id).<action>(payload)`         | stage a one-way action on another actor ([contract 05](../contracts/05-messaging.md))                |
| `schedule(durationOrDate).<action>(payload)` | stage a timer on this actor                                                                          |
| `start.<job>(payload, { key? })`             | stage a job start ([ADR 0129](0129-jobs-timers-and-shard-workflow-engine.md))                        |
| `emit.<event>(value)`                        | stage an event, published after durability ([ADR 0130](0130-views-sessions-events-and-rpc.md))       |
| `connection`                                 | the connection id, present only in `connect` and `disconnect` handlers                               |

There is no request/reply from an action: `X.client` is not available in an action, by type and at runtime. Staged effects become visible only when the action's segment is durable; a failure, defect or `PageMiss` discards all of them together, including effects staged by same-shard actions that ran on the failed action's draft.

### 3. Admission time

Admission time is the shard owner's wall clock at admission, clamped so it never decreases within a shard: `at = max(wallClock, previousAt)`. It is recorded in the `Action` entry and is the value of `ctx.now()`. Command-id expiry and the future-id bound are checked against it ([contract 03](../contracts/03-durability.md)). After a detected clock discontinuity (wall and monotonic elapsed time disagree by more than 250 ms, or the monotonic clock moves backward), the owner verifies its shards before admitting ([ADR 0126](0126-shard-ownership-on-the-bucket-log.md)); the recorded `at` still never decreases. Admission time is never read back from a served clock: 0.1's `/command-ids`, `durable-now` and client clock estimation are removed.

### 4. Enforcement

- **Lint.** `akter/synchronous-actions` bans `Date`, `Math.random`, `crypto`, `performance`, `process`, `globalThis`, `Promise`, `await` and `async` in action and view handlers, including handlers in files that call `.toLayer(` on an actor contract. It runs with the repository's other oxlint rules.
- **Runtime.** The handler runs synchronously; any suspension or thenable result is the `SynchronousActionViolation` defect naming the actor and action.
- **Replay.** Every `Action` entry stores its encoded outcome; a replayed action whose outcome differs is the `ReplayMismatch` defect, which stops the shard and reports the command id.
- **Simulation.** `Simulation` runs each action twice against cloned state and compares the encoded outcome and staged effects; the seed matrix runs on Node and on Bun and compares segment bytes.
- **Engine identity.** The build id records the JavaScript engine and its version ([ADR 0133](0133-build-matched-replay.md)); a tail written on another engine is not replayed without operator opt-in.

### 5. Deterministic child ids

`ctx.id()` replaces `turn.mint` ([ADR 0025](0025-turn-mint.md)). An action that creates another actor derives its id and sends its first action; there is no creation proof and no `createdBy` gate. An id produced by `ctx.id()` cannot be presented by an external caller as its own command id, because derived ids are version 8 and external ids are `v1.` strings.

### 6. Views

View handlers follow the same rules: `(state, params, ctx) => value`, synchronous, with no staged effects; `ctx` holds `caller` and `self`. A view reads durable state only ([contract 07](../contracts/07-realtime.md)).

## Supersedes and amends

No record is superseded in full here; [ADR 0128](0128-constrained-actor-api.md) owns the replacement of the 0.1 API.

- Amends [ADR 0010](0010-one-way-effect-native-api.md): its handler and per-phase context clauses are replaced by this record's handler and `ctx`.
- Amends [ADR 0008](0008-foundation-completion.md) and [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) §4: deterministic defects stay telemetry plus a recorded outcome; the defect classes are `SynchronousActionViolation`, `ReplayMismatch`, `StateTooLarge` and decode failure.
- Amends [ADR 0025](0025-turn-mint.md): the deterministic-child-id principle carries as `ctx.id()`.
- Amends [ADR 0059](0059-caller-and-tenant-defaults.md): `ctx.caller` is the transport-decided caller; actions never name a tenant.
- Amends [ADR 0122](0122-suspend-safe-served-clock.md): action admission time is the owner's clamped clock, not served database time; the discontinuity rule carries through [ADR 0126](0126-shard-ownership-on-the-bucket-log.md).
- Amends [ADR 0048](0048-mint-progress-and-inspection-record-corrections.md): its mint corrections are historical.

## Alternatives

- **Effect-typed handlers run with `Effect.runSyncExitWith`** (the engine plan's first design). Rejected by D23: it catches suspension but not the common leaks inside `Effect.sync`, and it puts a service environment in front of a pure function.
- **Immutable state returned from the handler** instead of a draft. Rejected: copy-on-write drafts give the same purity with plain assignment and list operations, and the engine can see exactly which list pages changed.
- **Read the time from the log or a served clock.** Rejected: the bucket has no clock, and a served clock is a second time authority. The owner's clamped clock recorded in the entry is the one authority.
- **Allow `await` with a recorded journal** (workflow-style actions). Rejected: that is a job ([ADR 0129](0129-jobs-timers-and-shard-workflow-engine.md)); mixing the two removes the property that an action never waits.

## Consequences

- Actions cannot do I/O, sleep or call another actor and wait. I/O moves to jobs; replies from other actors arrive as actions.
- An action's cost is CPU only, so an actor's throughput is bounded by handler time and the group commit, not by round trips.
- Applications that keep mutable module-level state or read `process.env` in handlers fail lint and may fail replay; the defect names the action.
- Node and Bun can disagree in the last bit of `Math.sin`-family functions. Cross-engine replay is refused by default ([ADR 0133](0133-build-matched-replay.md)).

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | F1 (declared failure, defect and `PageMiss` discard every staged effect, including a dependent same-shard send); F2 (an action that returns a promise or awaits fails with `SynchronousActionViolation` and changes nothing); I9 double-run comparison on Node and Bun; lint fixtures that reject each banned global |
| E2        | `ReplayMismatch` stops a shard whose tail was written by a nondeterministic handler, without publishing the mismatched outcome                                                                                                                                                                                       |
| E1        | Expiry and future-id checks use the clamped admission time; a clock moved backward does not move `ctx.now()` backward                                                                                                                                                                                                |

## Revisit when

- A workload needs a capability that cannot be recorded (for example reading a large external value inside an action); the answer is a job unless evidence shows otherwise.
- Evidence shows the lint misses a common leak, or produces false positives that push developers to disable it.
- Cross-engine replay must be supported, which needs deterministic math libraries in both engines.
