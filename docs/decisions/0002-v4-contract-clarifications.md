# ADR 0002: Clarify the adopted v4 contracts

**Status:** accepted design (2026-09-21); executable conformance remains pending.

**Responsibility:** resolve remaining inconsistencies between the v4 decisions and documentation.

**Authority:** historical decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when the agreed API or guarantees change.

## Context

Commit `85adfb2` incorporated the settled v4 design into `docs/`. A comparison against the final [decision ledger](../../research/v4/DECISIONS.md) and its type-level sketches found several remaining contradictions. Later decisions supersede earlier rows even when the older row still says “settled.” Research provides evidence for this reconciliation; it does not silently override the documentation.

## Decision

Preserve the adopted one-actor framework and the package layout in [ADR 0001](0001-repository-structure.md). Make the following clarifications without implementing a runtime or changing tooling:

| Area                     | Adopted interpretation                                                                                                                                                                                                                                                                                                                                           | Decision evidence                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Foundations              | F1 is the deployment database; F2 is the serialized Cluster entity; F3 is the framework-owned transaction; F4 is retryable defects/redelivery; F5 is the gated Neki storage arrangement. Do not reuse these labels for different rules.                                                                                                                          | F1–F5.                                                              |
| Turn mechanics           | Persisted Cluster commands use `WithTransaction: false` and no Cluster `primaryKey`. Fence validation precedes authoritative receipt lookup. A caller's delivery timeout does not restart or cancel the admitted turn; a command execution timeout follows the retryable-defect path.                                                                            | F2–F4, 47, 113; `Timeout` in the sketch.                            |
| Phase capabilities       | Commands write durable state; queries return committed values without activation `vars` or `state.changes`. Activation read contexts have committed snapshots and `vars`. Workflow bodies have `owner`, `actors`, `principal`, and durable workflow operations, not direct actor-row or `ctx.caller` capabilities. Effect executors have no database capability. | 45, 103, 136, 154, 158, 160, 165; context interfaces in the sketch. |
| Failure types            | `Unauthorized` has `code`; an `ActorError` wrapping it exposes that as `error.reason.code`. Declared errors remain unwrapped; method error channels narrow framework reasons.                                                                                                                                                                                    | 97, 106, 167.                                                       |
| Neki relay               | The agreed path is a tenant-local outbox and post-commit relay. The older direct cross-shard transaction experiment is not an alternative an implementer may silently select. Handoff retries retain one logical intent through deduplication; delivery remains at least once.                                                                                   | 46 as amended by 156; messaging contract.                           |
| Workflow transactions    | An actor turn commits workflow start/cancel intents. The workflow engine persists activity results outside that actor turn; the provider call does not run in a held transaction.                                                                                                                                                                                | 158 and F3.                                                         |
| Storage and lifecycle    | Small keyed state is JSONB; actor blobs are `bytea` chunks in `actor_blobs`, writable in turns. `vars` are ephemeral. Actors with no durable data members still have fenced, receipted commands.                                                                                                                                                                 | 125, 131, 136, 157, 160.                                            |
| Hibernation and failover | Parking retains a socket while an activation sleeps; it does not promise socket survival after the transport process dies. Failover tests distinguish lock expiry from resumed service; the unverified lock-expiration target is not a measured availability SLA.                                                                                                | 77, 163, 169–170; pending connection and singleton gates.           |
| Deployment topology      | `Topology.single` and `Topology.http` are the intended surface. `Topology.k8s` was removed and is not an available fallback for unverified Railway routing. A service-per-runner layout also requires evidence.                                                                                                                                                  | 60 revised by 142; removal retained in 151.                         |

The root, `/runtime`, `/client`, and `/testing` remain the only public entries. `Actor.make`, actor-owned workflows, `Actors.layer`, caller binding at handle acquisition, and no AI-specific framework surface remain unchanged.

## Alternatives

- Keep older research alternatives alongside final decisions: rejected because it would leave incompatible APIs and transaction paths normative.
- Treat the research sketches as implementations: rejected because runtime internals are declared and the package entrypoints remain placeholders.
- Infer new behavior for unspecified edges: rejected. Implementation must still specify and test terminal declared-error receipt persistence, supported SQL mutation shapes, and recovery bounds without weakening the adopted guarantees.

## Consequences and evidence

The documentation describes required design, not shipped behavior. The 17 recorded verification gates remain traceable; the earlier Neki cross-shard alternative is explicitly superseded, and applicable runtime/provider checks remain unverified.

Repository structure enforcement now exists in the pulled commit, but framework and example entrypoints remain scaffolds. This documentation-only reconciliation adds no runtime, tooling, or provider implementation and makes no new test-pass claim.

## Revisit when

- Executable conformance disproves a transaction, ownership, or provider assumption.
- A new public entrypoint, topology, actor kind, or storage API is proposed.
- An implementation decision resolves an explicitly unverified edge and its evidence is ready to record.
