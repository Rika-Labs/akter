# ADR 0046: The shared workflow-engine suite runs through engine drivers

**Status:** proposed (2026-09-28).

**Responsibility:** decide how the shared workflow-engine suite of [ADR 0022](0022-workflow-engine-storage-and-version-markers.md) decision 10 drives the framework engine and `ClusterWorkflowEngine`, and record the divergences it found.

**Authority:** design decision record.

**Owner role:** runtime.

**Change policy:** supersede through a new ADR.

## Context

ADR 0022 decision 10 has `describeWorkflowEngine(name, { layer, executionId })` register plain Effect workflows with a `WorkflowEngine` layer and drive them through `WorkflowEngine.execute`, `poll` and `interrupt`. That assumes the framework engine is an Effect `WorkflowEngine` service. The engine M2.7 shipped (`runtime/workflows/engine.ts`) is not: `Ship.step`, `Ship.sleep`, `Ship.wait` and `Ship.race` call the owner activation's engine directly, bodies start through `Actor.workflow` members and `WorkflowRun` handles, and no `WorkflowEngine` service exists in a body. The suite as written can't run against it.

Writing the suite also found two gaps against ADR 0022 that the M2.7 cases didn't exercise:

- `Ship.step` recorded every run as attempt 1, so `Activity.retry` around a step returned the first recorded failure instead of retrying (decision 7 says a step compiles to `Activity.make` and records "per attempt").
- An interrupt recorded `Interrupt` without replaying the body, so compensation finalizers never ran (decision 8 says the run "runs Effect's compensation finalizers").

## Decision

- **Drivers, one body.** `describeWorkflowEngine({ name, registrar, open })` in `packages/durable-actors/src/testing/conformance/workflow-engine.ts` takes a driver per engine: `execute`, `start` (Effect's `discard: true`), `attach`, `awaitSuspended`, `advance`, `restart`, and the engine's `pollWhileRunning`. Each case's body is written once, as `probeBody`, over three step primitives (activity, sleep, race); each engine compiles them to its own steps. `ClusterWorkflowEngine` compiles them to `Activity.make`, `DurableClock.sleep` and `DurableDeferred.raceAll`, over Cluster's in-memory message storage, which outlives the engine so `restart` rebuilds sharding and the engine over the same journal. The framework compiles them to `Probe.step`, `Probe.sleep` and `Probe.race` on an `EngineProbe` actor, and drives it through handles. Both bodies use Effect's own `Activity.retry`, `Activity.CurrentAttempt` and `Workflow.withCompensation` unchanged.
- **Where it runs.** The Cluster run is the unit test `workflow-engine.test.ts`. The framework run is part of `conformance/workflows.ts` as `workflow engine: <case>`, so it runs on PGlite and on real Postgres.
- **Attempts.** A step reads `Activity.CurrentAttempt`; each attempt writes and settles its own `(step, attempt)` row, and derives its actor-call ids from its own attempt and `started_at_ms`. Clocks, waits and races stay attempt 1.
- **Compensation.** Each run of a body gets a fresh Effect `WorkflowInstance` and a scope, so `Workflow.withCompensation` and `Workflow.addFinalizer` work in bodies, and `X.toLayer` removes `WorkflowInstance` and `Scope` from a body's requirements. Only a run that records a result closes the instance scope, with that result's exit; a suspended or abandoned run drops it, and the next replay registers the finalizers again. An interrupted execution now replays: every recorded step returns its exit, the first step that would do new work (a pending or unstarted activity, an unsettled clock, wait or race) interrupts the body, and the engine closes the instance scope with an interrupt, which runs the compensations, before it records `Interrupt`. A body that finishes from recorded steps alone records its own result instead: completion won the race. A runner that dies between compensation and the terminal write replays and compensates again, so compensation is at least once, like an activity.

## Divergences

The suite asserts these per engine instead of hiding them:

| Case                                       | Framework engine                                                       | `ClusterWorkflowEngine`                                          |
| ------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `poll` while the body runs, not suspended  | `Suspended`                                                            | `None`                                                           |
| Interrupt while an activity runs           | Interrupts the activity at once; its pending attempt is left unsettled | Lets the activity finish, then interrupts at the next suspension |
| External `DurableDeferred.done`            | Unsupported: a body reaches no `WorkflowEngine`, so it can't be called | Supported                                                        |
| A derived actor call past its expiry bound | Dies with `ActivityOutcomeUnknown` (ADR 0022 decision 4)               | No bound                                                         |

The interrupt row keeps both engines inside ADR 0022's contract: the result is an interrupt and compensation runs once. The shared case releases the activity after interrupting, so it holds on either engine.

**Behaviour change:** ADR 0022 decision 10's `describeWorkflowEngine(name, { layer, executionId })` signature and its "plain Effect workflows registered with the engine" become drivers over one shared body. Its divergence "external completion … dies with `Unsupported`" becomes "can't be called, because a body has no `WorkflowEngine`"; decision 2's "our engine dies with `InvalidExecutionId` on any id that doesn't decode" holds at `X.run` and the handles, which are the only way in.

## Recovery, preemption, and the expiry bound

These amend ADR 0022 decision 4 with behaviour the later conformance cases pinned down.

- **Recovery can land past the expiry bound.** A runner that dies during an activity is replaced when the recovery timer fires, `RECOVERY_MS` (30 s) after the attempt last armed it. The rerun reuses the attempt's `started_at_ms`, so its derived calls keep the same `expiresAt`, and the engine refuses a call once `now + deliveryTimeout ≥ expiresAt`. When the deployment's retry window minus the actor's `deliveryTimeout` is at most 30 s, every rerun after a lost runner is already past that bound, and an activity that makes actor calls dies with `ActivityOutcomeUnknown` instead of rerunning them. This is a documented constraint, not a change to the bound: `Actors.layer` logs a warning at startup for each actor type with workflows under it, and [retention](../operations/retention.md) states it. The default retry window is a day, so defaults are unaffected.
- **A resume preempts a live run parked on a step that can settle.** When a live run has a race branch parked on a clock or wait (another branch is still running), a resume first checks whether any parked step can now settle: a clock or wait timeout that is due, or a wait with owner events of its tag after `scanned`. If one can, the engine interrupts the run so its replay settles it, as ADR 0022 decision 4's deferred completion does. A running sibling activity is interrupted and reruns under the same attempt. A resume with nothing settleable, such as the 30-second recovery re-arm, only marks the run to replay after it exits, so a long activity isn't restarted for nothing. Before this, a live run parked on a wait ignored its event until every other branch finished.
- **A parking branch lets running steps finish.** A clock or wait that parks now waits until every other activity, clock, or wait step of the run has parked or finished before it ends the run. Before this, on Postgres, one branch of `Effect.all` parking interrupted a sibling mid-step. A due clock that was settling lost its settle, so two concurrent clocks replayed forever and never resumed. Effect's own engines let running steps finish before a suspension takes effect in the same way.

## Alternatives

- **Make the framework engine an Effect `WorkflowEngine` service.** Faithful to the letter of decision 10, but it would add a second way to start and step workflows (raw `Workflow.execute`, `Activity.make`), which decision 7 forbids in bodies, and a service whose `register` and `execute` have no owner actor to run on.
- **Test the framework engine only through its own cases.** Loses what decision 10 is for: catching drift from upstream semantics.
- **Compensate without replay**, by recording compensations as steps. Compensation would need its own schema and storage; replay reuses the recorded exits Effect's own engines replay.

## Consequences and evidence

- `workflow-engine.test.ts` runs the ten shared cases against `ClusterWorkflowEngine`. `conformance/workflows.ts` runs the same ten on the framework engine, plus `a body reaches no Effect WorkflowEngine, so external DurableDeferred completion is unsupported`, on PGlite and Postgres.
- Reverting either fix fails the suite: attempts pinned to 1 fail `records each Activity.retry attempt`, and interrupting without replay fails both interrupt cases.

## Revisit when

- Upstream Effect changes `WorkflowEngine`, `WorkflowInstance`, attempt numbering or compensation semantics.
- The framework adds child workflows or external deferred completion.
