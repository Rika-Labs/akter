# ADR 0133: Build-matched replay, engine identity and deploy versioning

Status: partially accepted, 2026-10-12 (rewrite/0.2). E2/E7 establish same-runtime build checks and audited replay; cross-runtime and hosted orchestration gates remain open.

**Responsibility:** decide which code replays a log tail, what a build id contains, how state and payload schemas evolve across builds, and what a host must keep to recover.

**Owner role:** runtime and operations.

## Context

Replay rebuilds state from a checkpoint plus the tail after it, and every `Action` entry stores its outcome so a mismatch is detected ([ADR 0124](0124-engine-rewrite-and-command-log.md)). A tail written by one build and replayed by another can diverge without a bug: a changed handler, a changed schema, or a different JavaScript engine (V8 under Node, JavaScriptCore under Bun) with different floating-point library results. 0.1 guarded deploys with workflow version markers and startup compatibility checks ([ADR 0022](0022-workflow-engine-storage-and-version-markers.md)) and payload version chains ([ADR 0032](0032-event-and-effect-payload-evolution.md)).

## Decision

### 1. Build id

Every segment records the `build` that wrote it: a digest of the application bundle, the framework version, the runtime and its version, the JavaScript engine, platform, architecture, and the ICU, Unicode and time-zone database versions. Replay runs only on a matching `build`; the stored outcome check is the backstop. `meta/store` records nothing about builds; each release brings its own.

### 2. Who replays a tail

- **Graceful handoff** leaves an empty tail ([ADR 0126](0126-shard-ownership-on-the-bucket-log.md)), so the next owner replays nothing written by another build.
- **After a crash**, a tail written by another build is replayed by a runner of that build. Akter Cloud keeps the last three release images per store and starts a replay runner that opens only the shards whose tails need it, replays, checkpoints, releases and exits.
- **Self-hosted**, a runner that finds a tail from another build refuses the shard, reports it through readiness and inspection, and waits, unless the operator sets `replay: "current"`, which accepts that the tail must replay identically on the current build. A `ReplayMismatch` under that setting stops the shard.
- **Engine changes** (Node to Bun or the reverse, or another engine version) are refused without operator opt-in, even when the application bundle is unchanged.

### 3. Schema evolution

- State decodes with the running build's schema: added fields take their decoding defaults; a reshaped field is a `Schema` transformation on that field. A runner that cannot decode a checkpoint's state refuses the shard; it never substitutes default state.
- Tail payloads are decoded by the build that replays them, which under §2 is the build that wrote them.
- After a graceful handoff, the new build decodes the checkpoint's state and later payloads with its own schemas; action payload schemas MUST stay able to decode what clients still send during the rollout.
- Job bodies follow §6 of [ADR 0129](0129-jobs-timers-and-shard-workflow-engine.md): steps by name, incompatible open jobs suspended, never failed.

## E2b amendment: actionable tails

Build matching applies to segments that replay application code: currently `Action` runs a handler and `Seed` applies the state schema. The build equality check compares every recorded build field, not just the bundle digest. Empty open segments and bookkeeping-only segments (`Released`, `Skipped`, delivery acknowledgements and job journal bookkeeping) do not run that code and do not require a matching build. An undecodable entry is still refused; the exception is not permission to ignore corruption or a `ReplayMismatch`.

A clean drain checkpoints through the last action, then writes `Released`. This leaves no actionable old-build tail, rather than literally no tail. A new build may decode that checkpoint and replay its bookkeeping. After a crash, an incompatible actionable tail is refused; assigning a runner of the old build lets it recover, drain and hand over. `replay: "current"` opts into current-code replay but never disables the recorded-effects comparison.

[E2 recovery](../verification/e2-recovery.md) records the old-build refusal/replay/drain/new-build sequence on the simulator and real-store harness. Cross-engine identity matching is implemented, but an actual Node-to-Bun or Bun-to-Node recovery run (F12′), host replay-runner orchestration, image retention, readiness and inspection reporting are not established by that sequence.

## E7 amendment: audited replay image

The operator endpoint replays only a locally assigned refused shard. Its default policy is `matching`; `--current` explicitly selects current-code replay, while every recorded-effect comparison still runs. The validated rebuilt image is serialized into a `Replayed` entry and appended with its `Audit` entry in one segment. No rebuilt state is published before that append. Recovery accepts such an image only when the same segment contains an allowed replay audit for that shard. This image is an inline checkpoint, so interruption before a later checkpoint upload cannot strand an unaudited result or require old application code again. Subsequent actionable tail segments still obey build matching.

The normal checkpoint and `Released` write are attempted after the atomic append. If their upload fails, the inline replay image and audit remain authoritative and the assigned engine reopens from them. The cost is one replay segment proportional to the rebuilt shard image; replay is an exceptional operator operation, not an action hot path. [E7 evidence](../verification/e7-find-operators.md) interrupts the append, refuses a mismatched build without opt-in, and fails the post-append page upload before restart.

## Supersedes and amends

No earlier record is superseded; build-matched replay is new.

- Amends [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) and [ADR 0022](0022-workflow-engine-storage-and-version-markers.md): version markers and startup refusal become build ids, step names and suspension.
- Amends [ADR 0032](0032-event-and-effect-payload-evolution.md): state evolution carries as §3; stored payload version chains end.

## Alternatives

- **Replay every tail on the current build.** Rejected as the default: correct only when the change is replay-safe, which nothing checks.
- **Keep every build forever.** Rejected: drain-then-open makes old-build tails a crash-only case; three images cover it.
- **Allow cross-engine replay.** Rejected by default: engines differ in the last bit of some math functions.

## Consequences

- Cloud's builder retains images and gains a replay mode (a Cloud ADR implements this).
- Self-hosters see a refused shard after a crash during deploy until they run the old build or opt in.
- Frequent checkpoints keep tails, and therefore replay windows, short.

## Evidence

| Milestone | Evidence                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | `TestSchema` round-trip of state and a payload across two schema versions, decoded from a checkpoint and from a tail (R14)                                                               |
| E2        | F12 (tail from an older build, with and without that build available) and F12′ (build available, engine changed); count of old-build tails at release switch under drain-then-open (R11) |

## Revisit when

- Old-build tails turn out to be common rather than crash-only.
- Deterministic math across engines becomes available.
