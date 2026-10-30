# ADR 0141: Domain vocabulary for 0.3

**Status:** accepted (2026-10-29, Dallen).

**Responsibility:** decide the public names and shapes of actor members, jobs and handler tests from 0.3.0.

**Authority:** design decision record.

**Owner role:** framework API.

**Change policy:** supersede through a new ADR.

## Context

The 0.2 API named a caller's request an "action" and a live, never-stored value an "event". In domain-driven design a command is an imperative request an aggregate may refuse, and an event is a stored fact; Akter has commands and stores no domain events, so "event" promised something the engine does not do. FoldKit and Alchemy, both Effect-native, show the shapes worth borrowing: imperative commands whose results come back as past-tense facts, side effects as data the runtime runs, policies attached as pipeable values, and pure tests of the decision step.

## Decision

1. **Commands.** `Actor.action` becomes `Actor.command`, the `actions` option becomes `commands`, and the handler and context types follow (`CommandHandler`, `CommandContext`, `CommandDefect`). A command is named with an imperative verb (`add`, `post`, `rename`).
2. **Broadcasts.** `Actor.event` becomes `Actor.broadcast`, the `events` option becomes `broadcasts`, and `emit` in command and job contexts becomes `broadcast`. A broadcast is a live value, published after durability from a command and at once from a job, and never stored. "Event" is reserved for stored facts, which Akter does not have.
3. **Results are facts.** An internal command that receives a job's result is named as a past-tense fact: `succeeded<Job>` for success and `failed<Job>` for failure (for example `succeededGenerate`, `failedGenerate`).
4. **Job success is delivered.** `Actor.job({ onSuccess })` names an internal command. The job handler's success value is journaled as an internal step and then delivered to that command once, under an id derived from the job, the way `onFailure` already is. A job without `onSuccess` keeps 0.2 behaviour.
5. **Retry and timeout are policies.** `retry` and `timeout` leave `Actor.job` options and attach with `.pipe(Job.retry({ times, schedule }), Job.timeout(duration))`. `times` bounds the retries and `schedule` is an Effect `Schedule` whose delay for each retry is journaled when the failure is, so replay never recomputes it.
6. **Handler stories.** `Story` in `@rikalabs/akter/testing` runs one actor's handlers with no engine and no store: given a state, a command and recorded `id`, `now` and `random` values, it checks the new state, the reply or failure, and every staged send, timer, job start and broadcast, and it resolves a staged job with its result. `Simulation` remains the end-to-end engine test.
7. **Clean renames.** No 0.2 spelling is kept as an alias.
8. **Data is unchanged.** Every spelling written to a store, an audit record or the `/rpc` wire keeps its 0.2 form (entry tags such as `Action`, stored defect kinds such as `SynchronousActionViolation`, RPC tags), so 0.2 stores open unchanged and mixed 0.2/0.3 data needs no migration. Only the TypeScript API is renamed. The one exception is a defect's name on `/rpc`, now `CommandDefect`: a defect is opaque to callers and never stored, so nothing reads the old name.

## Rejected

- **Stored domain events (event sourcing).** The durable log is a command log with checkpoints ([ADR 0124](0124-engine-rewrite-and-command-log.md)); storing events would change every durability contract, not a name.
- **Commands as values** (`handle.send(Counter.Add({ amount }))`). It would change every handle and the wire format; it is deferred, not refused.
- **`renamedFrom` for actors.** An instance's address is `<actor>/<key>` and its shard is a hash of the address, so a renamed actor's instances live on other shards. A rename is a data move, not an alias. Dotted names such as `Billing.Invoice` already work.

## Consequences

Applications change their declarations and handler contexts when they move to 0.3.0; stores do not change. The repository lint rule `akter/synchronous-commands` keeps commands deterministic and `akter/result-command-names` checks rule 3. Neither is published to npm.
