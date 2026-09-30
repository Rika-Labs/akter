# Durable Actors: a substantial simplification plan

Prepared September 30, 2026. **Implementation authorized by Dallen; delivery remains in progress.** The audit below describes the starting implementation. The execution decisions in this section supersede earlier name-preservation recommendations, not durable correctness guarantees.

## Accepted execution plan

The user authorized implementing this whole plan in parallel high-mode threads and merging the verified result into `main`. This is an unreleased, greenfield alpha: migrate names consistently through declarations, contexts, runtime, SQL, clients, examples, templates and current documentation. Do not add legacy aliases or compatibility decoders. Releases, deployments, production writes and infrastructure changes are outside this authorization.

The common source baseline is `origin/main` on September 30, 2026, after PR #466. The coordinator's local `main` initially matched that remote exactly. Workers receive this tracked file on a published foundation branch; new orbs do not inherit the coordinator's uncommitted files.

### Authoring decisions

- Keep one data-first `Actor.make`, keyed public/internal members, phase-specific services and independently deployable implementation layers.
- Use direct `Actor.event` and `Actor.job` schema values, without mandatory empty subclasses or explicit `Self`.
- Use `payload`, `success` and a tagged `error` schema consistently; retain meaningful Void defaults, service-free codecs and tagged-domain-error restrictions.
- Replace `effects` plus `policy.effects` with one actor-local `jobs` binding registry. Rename `perform` to `enqueue`, `cancelEffect` to `cancelJob`, `toEffectLayer` to `toJobLayer`, and `effectId` to `jobId`. Canonical job terminology includes runtime/storage/inspection/progress names; preserve stable identity values and provider idempotency semantics.
- Accept a handler map or an Effect-producing map and infer its requirements. Preserve ordinary layer-build versus singleton activation-build lifetime. Represent typed builder failures at their actual owner, not by running singleton builders early.
- Move `createdBy` and `schedules` to the actor definition. Keep policy shallow; use `executionTimeout`, `maxScheduleLag` and `allowedSubscriberTypes`.
- Rename ordered reducer folding to `batch: { combine }`. It is not mathematical commutativity or a CRDT promise.
- Derive subscription source/event facts from `delivery: Actor.Delivery(...)`, retaining explicit internal handler identity, shared handlers and declared failures.
- Place server/auth adapter construction behind the existing runtime entry. Browser declarations must not import serving, SQL or Cluster machinery.

### Parallel ownership

Seven high-mode worker threads implement disjoint primary scopes. The coordinator integrates their branches and owns shared assembly. Each worker reads this whole plan and the owning contracts, reports its exact interface changes early, and migrates consumers only inside its scope. It does not launch nested threads.

| Workstream                | Candidates                              | Primary write ownership                                                                                                                                                                       |
| ------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor API/compiler        | A1–A10 and complete authoring follow-up | `actor/`, `members/`, `policies/`, `contexts/`, `activation/`, `state/`, `handles/`, root framework entry, corresponding definition/type tests and authoring API documentation                |
| Testing/evidence          | T1–T5, T8 and false-green batching law  | `testing/`, framework test configurations, example test provisioning, `tooling/structure/src/ledger.ts` and its tests; evidence registration and backend metadata                             |
| Protocol/clients          | C1–C10, T6 and client half of T7        | `client/`, `serve/`, browser-safe error/protocol facts, React, Python, browser E2E fixture mechanics and transport documentation                                                              |
| Tooling/scaffolds         | G1–G5, G7–G10 and doc-link half of T7   | Structure except the evidence ledger, Oxlint/config, doc checks, create templates, pack/release tooling and repository-structure documentation                                                |
| Turn/activation           | R1–R5, R8                               | Turn execution/session/pipeline, entity/mailbox/activation, committed-result publication and shared fencing boundary; not relay or `runtime/layer.ts`                                         |
| Job/subscription delivery | R6–R7, R12 and canonical job storage    | Turn relay, `runtime/effects/` to `runtime/jobs/`, subscription storage/delivery, database schema/migrations and inspection-view job naming; background-work contracts                        |
| Workflow                  | R9–R10                                  | Workflow engine/compatibility/steps and workflow-specific documentation                                                                                                                       |
| Coordinator               | R11, G6 and integration                 | Connections/streams/progress, CLI schema deduplication, `runtime/layer.ts`, remaining app/example/benchmark consumer migration, AGENTS, foundation ADR, this ledger and combined verification |

An owner requests cross-scope edits rather than applying a broad repository-wide codemod. In particular, the API owner publishes the new descriptor/signatures; each consumer owner migrates its own code. The turn owner publishes the shared fencing interface for connection/workflow owners. Job storage and wire owners coordinate canonical names. The testing owner and tooling owner coordinate evidence-checker changes. The coordinator owns final contract/vision consistency and resolves integration conflicts without reverting unrelated work.

### Implementation and integration order

1. Publish this plan, the superseding decision and the small testing policy as the shared foundation. Capture the current collected cases, source/support size and representative package/browser evidence.
2. Start all seven workers. Correct reproduced declaration, SSE and law-check defects with discriminating regressions before refactoring their owners.
3. Land the actor descriptor and API contract first. Bring other independently developed branches onto that interface, without compatibility scaffolding.
4. Integrate tooling/harness/protocol simplifications, then the turn, delivery, workflow and connection changes. Preserve behavior in refactor commits separately from deliberate API/bug-fix commits where feasible.
5. Close every candidate with an implemented simplification or a concrete inspected/probed reason that its proposed replacement increases complexity or loses a guarantee. A spike is not an unconditional deletion; generic deferral is not completion.
6. Run combined verification on the exact integrated tree, reconcile current documentation/evidence, open the integration PR, obtain current-SHA CI evidence, merge it into `main`, and confirm the remote contains the delivered result.

### Execution ledger

| Workstream                | Initial state          | Completion evidence required                                                                                                                                           |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation and policy     | Published              | Shared foundation: tracked plan, accepted ADR and AGENTS policy; all 85 root-check tasks and the 513-file tarball check passed                                         |
| Actor API/compiler        | Implementing           | [High-mode owner](https://ampcode.com/threads/T-01a0f3f6-a816-7506-ba83-fe1b51ff7d28): A1–A10, direct constructors, inferred layers, descriptor and negative types     |
| Testing/evidence          | Implementing           | [High-mode owner](https://ampcode.com/threads/T-01a0f3f6-b1d8-7783-9618-62790e1b640f): T1–T5/T8, case parity, provider metadata, cleanup and reducer-law falsification |
| Protocol/clients          | Implementing           | [High-mode owner](https://ampcode.com/threads/T-01a0f3f6-bbc8-7251-a7a1-759982633bb6): C1–C10/T6/T7, CRLF/end-ID regression, parity and browser/session evidence       |
| Tooling/scaffolds         | Implementing           | [High-mode owner](https://ampcode.com/threads/T-01a0f3f6-c720-7773-85ce-16136794ff06): G1–G5/G7–G10/T7, duplicate engines/facts, checked docs and packed scaffolds     |
| Turn/activation           | Implementing           | [High-mode owner](https://ampcode.com/threads/T-01a0f3f6-d108-7329-9119-f069a7a48159): R1–R5/R8, real Postgres fence/commit/cancellation and pipeline evidence         |
| Job/subscription delivery | Implementing           | [High-mode owner](https://ampcode.com/threads/T-01a0f3f6-d9a6-7097-8720-b1acdcc6374f): R6–R7/R12, job storage, late/cancel settlement and epoch/summary evidence       |
| Workflow                  | Implementing           | [High-mode owner](https://ampcode.com/threads/T-01a0f3f6-e397-768e-8406-2bc1f19d6556): R9–R10, quiescence, shared verdicts and simultaneous park/resume evidence       |
| Connections and CLI       | Implementing           | Coordinator: R11/G6, preserved sequencing/session authority and browser-safe shared inspection response schemas                                                        |
| Integration and delivery  | Pending implementation | Complete candidate accounting, exact-tree root/provider/E2E/package checks, before/after measurements, current-SHA CI and merged remote `main`                         |

Early interface agreements preserve one ordered connection sequencer, move browser-safe wire facts into `src/protocol`, and expose serving as `Actors.serve` plus `Auth` on the existing runtime entry. Inspection schemas share that browser-safe protocol owner and are exported through the existing client entry; the dev inspector must not import runtime or serve modules. The job migration preserves durable identity values, and peer edits to shared seams are isolated from substantive changes for integration.

### Final proof and merge criteria

- `bun run check` passes on the integrated tree, including lint, structure, formatting, types, tests, builds, documentation and package checks.
- Disposable orb-local Postgres runs concurrency, fencing, rollback/retry, crash/recovery, job/subscription/workflow and streaming-replica cases. PGlite retains its own supported coverage. Missing Neki or provider credentials remain explicitly unsupported evidence, never a green support claim.
- Promise, React and offline browser E2E and packed/scaffold consumer checks run against the resulting API. Inspect representative rendered UI if appearance changes; interaction-only changes require actual DOM/accessibility/behavior evidence.
- Retired tests name the plausible wrong implementation and the surviving evidence that rejects it. No test-count/coverage quota, silent skips, expectation weakening or mocked-away storage boundary.
- Every candidate above and every authoring decision has a final disposition; source/support/concept reductions and any intentional tradeoffs are recorded here.
- The integration PR has successful trusted current-SHA CI and its required evidence artifact before merge. Confirm `origin/main` contains the delivered commits. Local edits or a pushed branch are not the requested finished state.

## Recommendation

Keep the durable semantics and the existing data-first, Effect-native authoring model. Radically reduce the machinery around them: declaration compilation, duplicated codec/protocol facts, test fixture construction, delivery supervision, and repository governance.

The goal is **fewer concepts and fewer owners of each invariant**, not fewer lines at any cost. Tenfold reductions are plausible for individual adapters, registration wrappers, and fixture declarations. There is no evidence that the entire framework can become ten times smaller while retaining all its current guarantees. Do not replace explicit correctness with a generic framework whose configuration is just as complicated.

Start with declaration ownership and the test harness, then consolidate the wire layer, and only then refactor transaction and worker orchestration. Separate behavior-preserving work from API changes and correctness fixes.

### SOLID, DRY, and KISS as concrete constraints

| Principle             | Application here                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single responsibility | Declaration compilation, scoped activation, turn commit, and delivery settlement have distinct owners. Splitting files alone does not achieve this.                 |
| Open/closed           | Extend through existing typed members, provider capabilities and Effect layers, not another configurable callback engine.                                           |
| Liskov substitution   | Backends promise the same common turn semantics, but PGlite must not pretend to provide independent connections or Postgres pipelining.                             |
| Interface segregation | Keep the phase-specific `Turn`, `Read`, `Workflow`, `Connection` and `Executor` services instead of a universal context.                                            |
| Dependency inversion  | Inject real capabilities with native Context/Layer; leave pure local transformations as ordinary functions.                                                         |
| DRY                   | Give schema, wire, policy, and evidence facts one source of truth. Similar-looking retry/SQL operations with different semantics are not automatically duplication. |
| KISS                  | Delete a wrapper or rule before inventing its replacement. A proposed abstraction must replace more coordination/configuration than it introduces.                  |

### Most consequential findings

1. The 3,375-line `actor/definition.ts` module combines declaration compilation, execution adapters, handle factories, registry publication, and SDK construction around `Actor.make`. Its validation is not atomic: a failed declaration can poison table ownership. This was reproduced.
2. The framework source contains more handwritten testing/support code than non-test implementation. Much of the maintenance opportunity is fixture and registration machinery, not disposable durability tests.
3. The same member schemas become declaration records, compiled codecs, registered runtime members, served views, and client decoders. Several transformations are legitimate boundaries, but their facts should have one owner.
4. Relay, workflow, activation, and post-commit orchestration mix durable decisions with volatile supervision. These are better candidates for deep, narrow modules than another public DSL.
5. The installed Effect release already supplies useful primitives that are being partially reimplemented. Native reuse needs contract probes: the SSE experiment both reproduced a local parser defect and exposed a non-drop-in upstream behavior.

## Scope and evidence

The audit used four parallel local research subagents and two external repository research subagents, followed by direct inspection and targeted executable probes. It covered the public actor interface, runtime, serving/clients, conformance/testing, examples, and supporting tooling. FoldKit and Alchemy research used their authoritative pinned repositories; Effect recommendations were checked against the installed source and the supplied Effect guidance.

This is not a complete mutation audit or a claim that every test or implementation line was reviewed. No full test suite, production operation, migration, deployment, or published API change was performed.

### Measured baseline

Counted `.ts` files and physical lines under `packages/durable-actors/src`, excluding dependencies:

| Slice                                            | Files |   Lines |
| ------------------------------------------------ | ----: | ------: |
| All framework source, including testing          |   365 | 106,776 |
| Non-`.test.ts` implementation outside `testing/` |   152 |  42,510 |
| Non-`.test.ts` code inside `testing/`            |   124 |  54,050 |
| All `.test.ts` files in the framework            |    89 |  10,216 |
| Entire `testing/` tree, including its tests      |   176 |  57,786 |
| Entire `runtime/` tree, including its tests      |    98 |  28,206 |

The distinction matters: counting only `.test.ts` misses the 54,050 lines in conformance cases, fixtures, and testing utilities. Those files contain both valuable assertions and substantial support machinery; this number is not a deletion budget.

Large ownership concentrations include:

| Module                         | Lines | Responsibilities worth separating                                                     |
| ------------------------------ | ----: | ------------------------------------------------------------------------------------- |
| `actor/definition.ts`          | 3,375 | Declaration validation, services, handlers, codecs, handles, registrations, clients   |
| `testing/conformance.ts`       | 1,788 | Global fixture, all actor layers, backend lifecycle, registration                     |
| `runtime/connections/owner.ts` | 1,770 | Durable sessions, activation broadcasts, streams, progress                            |
| `runtime/turn/relay.ts`        | 1,563 | Claims, dispatch, effect supervision, cancellation, settlement                        |
| `runtime/layer.ts`             | 1,421 | Runtime composition, admission, delivery and subsystem assembly                       |
| `runtime/turn/execute.ts`      | 1,293 | Admission, business isolation, planning, two transaction drivers, publication handoff |
| `runtime/workflows/engine.ts`  | 1,274 | Persisted steps, replay, compatibility, live run supervision                          |
| `client/make.ts`               | 1,257 | HTTP calls, identity, retries, offline/reducers, handle construction                  |

Module size is a navigation signal, not proof that the code is unnecessary.

### Executed probes

**Declaration poisoning, reproduced in a disposable Bun process:**

1. Declare an owned Drizzle table.
2. Attempt `Actor.make("RejectedDeclaration", ...)` with that table and a duplicate event.
3. Attempt a valid definition with the same table and a different actor name.

Observed:

```text
first declaration: Duplicate event: Changed
second declaration: Table audit_declaration is already owned by actor RejectedDeclaration
```

The cause is directly visible: [table ownership is mutated before event validation](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L975-L1003).

**SSE chunk-boundary defect, reproduced through the exported `readEvents`:**

```text
chunks: ["event: result\r", "\ndata: 1\r\n\r\n"]
current: [{"data":"1"}]
Effect: [{"_tag":"Event","event":"result","data":"1"}]
expected event name: result
```

The current parser normalizes the pending buffer between reads and turns a split CRLF into a false blank-line boundary. [Parser and reader](file:///home/user/workspace/repo/packages/durable-actors/src/client/sessions/feed.ts#L52-L134).

**Upstream SSE compatibility limitation, also reproduced:** Effect's parser carries the previous ID onto an `event: end` message that has no explicit ID. The current feed uses the absence of an ID to distinguish terminal messages from a domain event named `end`. A direct parser swap would therefore change behavior. [Current distinction](file:///home/user/workspace/repo/packages/durable-actors/src/client/sessions/feed.ts#L193-L215), [installed parser](file:///home/user/workspace/repo/node_modules/effect/src/unstable/encoding/Sse.ts#L259-L420).

**Browser build probes:** `Bun.build({ target: "browser", minify: true, write: false })` succeeded for the client entry at 117,600 bytes and the counter contract entry at 442,743 bytes. These are different exported surfaces, not an apples-to-apples size comparison. A transpiler import scan of the counter contract reached 82 first-party modules, including 18 under `runtime/` and 15 under `serve/`. This is an import-graph observation, not proof that every reachable module survives tree shaking.

## Current mechanism and desired ownership

```diagram
CURRENT DECLARATION
Actor.make
  ├── validate schema/policy/placement
  ├── mutate declaration registries
  ├── construct per-actor Context services
  ├── implement command/query/reducer/connection/stream adapters
  ├── construct Effect handles and intents
  ├── construct runtime registrations
  └── construct served view and Promise client

CURRENT COMMAND
Effect handle / Promise SDK
  → runtime admission and early receipt replay
  → volatile Cluster Execute request
  → activation-local mailbox
  → generation fence + receipt resolution
  → handler + isolated business consequences
  → one SQL commit
  → cache / relay wakes / progress / broadcasts / workflow kick / reply
```

```diagram
TARGET DECLARATION
Actor.make
  → validate and compile one immutable descriptor
  → publish declaration metadata only after validation succeeds
  ├── Effect handle/intents adapter
  ├── phase-specific implementation layers
  ├── serving/OpenAPI adapter
  └── Promise SDK adapter

TARGET COMMAND — DURABLE ORDER UNCHANGED
admission + authorized receipt replay
  → volatile Cluster request
  → one activation worker
  → fenced turn transaction
  → one committed result
  → ordered post-commit publication

TARGET DELIVERY
typed claim → scoped execution → guarded settlement/release
```

This is not a demand to make one new service for every box. Use ordinary functions and records for local transformations. Use `Context.Service` and `Layer` when an actual injected capability or scoped resource needs an owner.

## Guarantees that cleanup must not weaken

- Database generation fencing, not a lease or process cache, authorizes writes.
- Receipt identity binds actor, tenant, command, payload and logical caller; retries retain the same identity and encoded payload.
- External receipt reads require current authorization and valid expiry; trusted internal recovery remains distinct.
- A declared failure rolls back business work while committing its failure receipt inside the same outer transaction.
- State, owned rows, blobs, events, workflow starts, intents and effect obligations commit atomically.
- Accepted turns survive caller timeout/disconnect; no success, broadcast or delivery is published before commit.
- Pipelined Postgres and sequential PGlite preserve their actual different capabilities. Real Postgres is required for independent sessions, contention, fencing, and recovery evidence.
- Outbox/effect/subscription workers retain lease/epoch-guarded settlement and polling as the correctness path.
- External effects remain at least once with possible ambiguous outcomes, not magically exactly once.
- Feed history, watch freshness, live streams, and connection sessions keep different resume/termination semantics.
- Query reads remain read-only and non-activating; workflow and executor authority remain constrained.
- Root/client browser boundaries and separate executor deployment remain intact.
- Code uses no explanatory inline comments. JSDoc explains public behavior or a non-obvious reason; it does not narrate every implementation step or cite decisions.

Owning contracts: [authority](file:///home/user/workspace/repo/docs/contracts/01-actor-authority.md), [turns](file:///home/user/workspace/repo/docs/contracts/02-command-turns.md), [transactions](file:///home/user/workspace/repo/docs/contracts/03-transactions.md), [receipts](file:///home/user/workspace/repo/docs/contracts/04-receipts.md), [realtime](file:///home/user/workspace/repo/docs/contracts/07-realtime.md), [background work](file:///home/user/workspace/repo/docs/contracts/08-background-work.md), [verification invariants](file:///home/user/workspace/repo/docs/verification/invariants.md).

## What to borrow from FoldKit, Effect, and Alchemy

### FoldKit: consistency, not a new actor execution model

Pinned source: [FoldKit 0.163.0](https://github.com/foldkit/foldkit/tree/foldkit%400.163.0), which also targets Effect rc.116.

- [Schema-led unions](https://github.com/foldkit/foldkit/blob/foldkit%400.163.0/packages/foldkit/src/schema/index.ts#L393-L520) derive validation, constructors, types and matching from one declaration. Apply this to the actor descriptor and its projections.
- [Application construction](https://github.com/foldkit/foldkit/blob/foldkit%400.163.0/packages/foldkit/src/runtime/makeApplication.ts#L26-L172) wires independently testable values rather than becoming another behavior DSL.
- [Named deferred commands](https://github.com/foldkit/foldkit/blob/foldkit%400.163.0/packages/foldkit/src/command/index.ts#L116-L187) separate declaration from execution. Durable Actors already has effects and intents; consolidate those boundaries rather than inventing another task vocabulary.
- [Project organization](https://github.com/foldkit/foldkit/blob/foldkit%400.163.0/packages/website/src/page/projectOrganization.md) starts compact and splits around actual ownership. Permit small actors to stay compact instead of requiring ceremonial empty role files.
- [Testing boundaries](https://github.com/foldkit/foldkit/blob/foldkit%400.163.0/packages/website/src/page/testing.md) separate transition logic from external integration. Use existing reducers for pure logic; use real actor storage for durability claims.

Do not import browser-memory authority, independently forked UI commands, silent missing-child no-ops, or an opaque closure as durable work.

### Effect: reuse real contracts and primitives

The installed version is **4.0.0-rc.116**. Its service API is `Context.Service`, not an assumed `ServiceMap` API. The framework already uses per-actor Context services and Cluster; recommendations must recognize that existing reuse.

- [RpcGroup handler inference and value-or-Effect builders](file:///home/user/workspace/repo/node_modules/effect/src/unstable/rpc/RpcGroup.ts#L74-L128) are a strong reference for cleaner layer signatures.
- [Native SSE parser/encoder](file:///home/user/workspace/repo/node_modules/effect/src/unstable/encoding/Sse.ts) can replace syntax machinery only after preserving explicit-ID and terminal semantics.
- [Effect Vitest cancellation](file:///home/user/workspace/repo/tooling/doc-checks/node_modules/@effect/vitest/src/internal/internal.ts#L22-L50) passes the test signal and waits for interrupted finalizers. This directly addresses a weakness documented by the current harness.
- Prefer `Effect.gen` inline, `Effect.fn`/`fnUntraced` for reusable effect functions, `Schema` at trust boundaries, native predicates, scoped acquisition, and focused layers.

Do not add a complete parallel RpcGroup merely to say the framework uses RPC. Either it replaces meaningful custom member/handler machinery or it is extra complexity. Do not replace actor-owned workflow storage with upstream ClusterWorkflowEngine: their authoritative storage/transaction boundaries differ.

### Alchemy v2: stable declarations and layer composition

Pinned source: [Alchemy 2.0.0-beta.79](https://github.com/alchemy-run/alchemy/tree/v2.0.0-beta.79).

- [Resource declaration](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.79/packages/alchemy/src/Resource.ts#L346-L560) keeps stable identity and derived capabilities together.
- [Provider services](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.79/packages/alchemy/src/Provider.ts#L22-L69) and [lazy memoized provider layers](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.79/packages/alchemy/src/Local/ProviderLayer.ts#L91-L123) demonstrate explicit dependency/lifetime ownership.

Borrow those construction principles. Do not copy ambient resource registration as actor existence, add a fluent actor builder, or make the actor declaration Effectable just because Alchemy resources are. The existing actor API deliberately distinguishes data declarations from runtime execution.

## Issue backlog

Priorities: **P0** = correctness or foundation of later cleanup; **P1** = substantial supported simplification; **P2** = useful narrower work; **Spike** = design/replacement requiring evidence before adoption. These are 50 distinct findings/candidates, not 50 confirmed defects or unconditional deletions.

### A. Actor.make and authoring: 10 findings

| ID  | Priority       | Evidence and issue                                                                                                                                                                                                                                                                                                                                                                                                                           | Recommended change, deletion, and preservation check                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | P0             | [Ownership mutation before validation](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L970-L1003) produces the reproduced rejected-declaration poisoning.                                                                                                                                                                                                                                                  | Validate all declarations before publishing ownership/registry changes. A rejected definition must leave every table available to a valid definition; a successfully owned table must still reject a second owner. This repairs the source rather than adding reset/rollback helpers.                                                                                                   |
| A2  | P1             | [Definition constructor](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L772-L3339) owns both description and phase execution.                                                                                                                                                                                                                                                                             | Move handler/context execution adapters to cohesive existing/runtime-owned modules. Keep one constructor and one descriptor. Reduce its responsibilities, not merely split the 3,375 lines into arbitrary files. Verify the complete example corpus and capability types.                                                                                                               |
| A3  | P1             | Metadata is published through `mintables`, `placedDefinitions`, `sources`, `internalDefinitions`, `definitionPayloads`, `servedDefinitions`, and table registries in [definition](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L221-L306) and [publication](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L3317-L3339).                                               | Consolidate immutable derived metadata in a private descriptor, projected where needed. Remove parallel lookup plumbing where there is no independent lifetime. Keep sensitive/internal capabilities out of public handles; descriptor identity is not durable authority.                                                                                                               |
| A4  | P1             | [Member codecs](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L165-L193), [served codecs](file:///home/user/workspace/repo/packages/durable-actors/src/actor/served.ts#L120-L217), and client construction rebuild related schema facts.                                                                                                                                                                  | Compile one codec bundle per member and derive storage/wire adapters from it. Preserve genuine storage JSON versus HTTP JSON differences. Prove void/undefined, transformed schemas, declared errors and replay under new code.                                                                                                                                                         |
| A5  | P1, API change | [Commands](file:///home/user/workspace/repo/packages/durable-actors/src/members/command.ts#L74-L138) use `input/output/errors`; [effects](file:///home/user/workspace/repo/packages/durable-actors/src/members/effect.ts#L44-L91) use input fields and `success`; [workflow steps](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/workflows/steps.ts#L83-L160) use `success` while workflow declarations use `output`. | Prefer one Effect-aligned vocabulary: `payload`, `success`, `error` for operations, with an error schema rather than repeated array-to-union assembly. Support schemas/fields using native conventions where appropriate. Migrate declarations together; do not silently change no-input defaults, wire bytes, tags, or stored records.                                                 |
| A6  | P1, type spike | [toLayer](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L2501-L2520), [query layer](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L2816-L2829), and examples require `Effect.succeed` around already-built handler maps; signatures manually carry phase environment parameters.                                                                                       | Accept a handler map directly for the ordinary case and an Effect builder for resource acquisition, following RpcGroup. Infer each handler's actual requirements. Test inference through `Effect.fnUntraced`, wrong/missing handlers, forbidden request/reply, and mixed command/stream/workflow requirements. Add no extra `of` helper unless the inference spike proves it necessary. |
| A7  | P2, type spike | Those layer builders accept build failures only as `never`, unlike ordinary Effect layers.                                                                                                                                                                                                                                                                                                                                                   | Allow typed builder errors when they can be represented honestly. Normal actors expose startup layer errors; singleton activation build errors must preserve owner-side command failure/restart semantics. Do not force application errors into defects just for a signature, or pretend singleton build errors occur at startup.                                                       |
| A8  | P1             | [Non-singleton and singleton registration](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L2549-L2633) give the same builder syntax different lifetimes: layer build versus owner activation.                                                                                                                                                                                                              | Make those two owners explicit in implementation and precise JSDoc; consolidate shared compilation without changing lifetime. Verify once-per-layer versus once-per-activation build count, scope close, owner takeover, and singleton fork lifetime. Do not erase the distinction to shorten code.                                                                                     |
| A9  | P1             | [Effect timing/default resolution](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L548-L611) lives in the definition module while general [policy resolution](file:///home/user/workspace/repo/packages/durable-actors/src/policies/command.ts#L147-L194) owns other defaults.                                                                                                                             | Put declared-to-resolved policy conversion in one policy owner. Remove repeated fallback resolution when registering executors. Keep retry counts, duration bounds, progress coalescing and route type validation unchanged.                                                                                                                                                            |
| A10 | P1             | The root imports serving; [serving imports a size constant from the SQL content store](file:///home/user/workspace/repo/packages/durable-actors/src/serve/layer.ts#L28-L36). The browser graph reaches server-bearing modules, while the client graph test covers only `/client`.                                                                                                                                                            | Move shared protocol limits to the existing browser-safe declaration/identity owner, not a second copy. Separate runtime adapter construction from inert declaration data. Extend a real browser-contract bundle/import check, not just a path-depth lint. Do not put a Cluster Entity on the root actor object: that violates the intended browser boundary.                           |

### Recommended Actor.make experience

**Keep:** `Actor.make(name, definition)`, keyed `api` and `internal` records, per-actor `Turn/Read/Connection/Workflow/Executor`, separate phase layers, `get` outside turns, and durable intents inside them. These already resemble idiomatic Effect and enforce meaningful boundaries.

**Change:** consistency and inference, not the entire mental model. Illustrative target API after the type/compatibility spike; this is not currently implemented:

```ts
import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

const Increment = Actor.command("Increment", {
  payload: Schema.Int,
  success: Schema.Int,
})

const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  api: { Increment },
})

const CounterLive = Counter.toLayer({
  Increment: Effect.fnUntraced(function* (amount: number) {
    const turn = yield* Counter.Turn
    const count = turn.state.count
    yield* turn.state.set({ count: count + amount })
    return count + amount
  }),
})
```

The spike should remove that explicit `amount` annotation if inference is sound; the example does not assume that result. Keep the Effect builder for actual resource acquisition. Apply the same convention to query and executor layers, without bundling them into one deployment unit.

For pure state transitions, improve and document the **existing `Actor.reducer`**, rather than add a FoldKit-style message/update/result DSL. [Reducer declaration](file:///home/user/workspace/repo/packages/durable-actors/src/members/reducer.ts) already supports pure transitions, declared failure, optimistic client execution, and optional commutative merging. Arbitrary command turns still need rows, events and durable obligations; a universal pure return object would be a new framework, not equivalent cleanup.

The current counter scaffold is only 26 lines of declaration plus layer. Its boilerplate can shrink, but claiming a tenfold authoring reduction there would be misleading. The large reduction target is what the framework must understand to implement those 26 lines.

The constructor/phase rules live in [server API](file:///home/user/workspace/repo/docs/api/01-server-api.md) and [ADR 0010](file:///home/user/workspace/repo/docs/decisions/0010-one-way-effect-native-api.md). Any public convention change needs a superseding API decision and one coordinated migration, not permanent aliases, a second constructor, a fluent builder, or a mixed-member array alongside the record form.

### B. Runtime ownership: 12 findings

| ID  | Priority      | Evidence and issue                                                                                                                                                                                                                                                                                                                                                                                     | Recommended change, deletion, and preservation check                                                                                                                                                                                                                                                                                        |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | P1, high risk | [Pipelined driver](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/turn/execute.ts#L1040-L1219) and [sequential driver](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/turn/execute.ts#L1223-L1277) share admission/planning but independently drive batches, ending and publication.                                                                       | Share the common turn/batch lifecycle, with explicit backend session capabilities. Delete duplicate control flow only where semantics really match. Preserve cross-batch pipeline overlap, exact COMMIT verification, interruption invalidation, no-write rollback and commit-version observation. Benchmark before accepting the refactor. |
| R2  | P1            | [Entity registration](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/entity/register.ts#L446-L829) mixes activation scope, singleton lease watching, mailbox, restart, workflow startup, telemetry and replies.                                                                                                                                                                  | Extract activation lifetime from command settlement, keeping narrow local interfaces. Remove cross-responsibility `current/lost/ended/phase` coordination where ownership eliminates it. Preserve orphan recovery and self-managed restart after retryable failures.                                                                        |
| R3  | Spike         | [Mailbox coordination](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/entity/register.ts#L528-L656) uses an array, latch and flags around a single worker.                                                                                                                                                                                                                       | Try a scoped Effect Queue plus batch collector; adopt only if it removes state. Preserve queued-hook barriers, same-ID batch barriers, arrival order, caps, single-command failure reruns and accepted work after caller cancellation. Cluster concurrency alone is not a replacement.                                                      |
| R4  | P1            | Publication is split between [turn finish](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/turn/execute.ts#L991-L1029), [settle](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/entity/register.ts#L534-L565) and [committed processing](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/entity/register.ts#L660-L704).                | Give the committed result one publication owner with explicit ordering. Consolidate cache updates, wakes, progress close, realtime flush, workflow kick and caller settlement. Do not imply those post-commit operations are atomic or replay best-effort broadcasts as durable history.                                                    |
| R5  | P1, high risk | Generation checks occur in [turn admission](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/turn/execute.ts#L483-L590), [connection acquisition](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/connections/owner.ts#L552-L601) and [workflow fencing](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/workflows/engine.ts#L491-L502). | Consolidate actor-row identity and stale-generation policy in the storage/ownership boundary. Share actual invariants, not all SQL shapes or lock modes. Keep specialized transaction operations explicit; test a stale connection/workflow writer after generation takeover.                                                               |
| R6  | P1, high risk | [Outbox orchestration](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/turn/relay.ts#L1300-L1499) and [subscription delivery](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/subscriptions/relay.ts#L710-L1139) repeat claim capacity, leases, fibers, release and backoff.                                                                                 | Consolidate scoped lease supervision for the actual worker families. Prefer typed claimed rows over opaque JSON work and injected SQL-fragment protocols. Leave claims/settles domain-specific. Test interruption between claim and fiber start, lease expiry, epoch changes, and no claimed row waiting for capacity.                      |
| R7  | P1, high risk | [runAttempt](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/turn/relay.ts#L839-L1259) interleaves provider outcomes, renewal, cancellation, late success, route encoding and dead letters.                                                                                                                                                                                       | Decide a small tagged settlement outcome, then perform one guarded transition. Remove repeated cancellation/route branches. Keep Failed/Unknown/not-started/maybe-applied distinct. The key test is late success from attempt A after attempt B has settled a newer state.                                                                  |
| R8  | P2            | [Entity definitions](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/entity/register.ts#L226-L250) are process-global name-cached objects to avoid Cluster retaining a client per object.                                                                                                                                                                                         | Preserve stable identity, but consider a runtime-owned entity registry shared by registration and dispatch instead of permanent global caches. Verify client/activation reuse and independently built runtimes. Keep it under `/runtime`; do not import Cluster into `Actor.make` to move the cache.                                        |
| R9  | P1, high risk | [LiveRun](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/workflows/engine.ts#L400-L410) plus [quiet/suspend](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/workflows/engine.ts#L737-L757) coordinate counters/flags through a 1 ms polling loop.                                                                                                          | Use scoped fibers and a state-change signal for quiescence. Remove the spin loop and redundant flags only after modeling all live states. Test a sibling finishing exactly when another branch parks and a resume kick arrives. The persisted engine remains authoritative.                                                                 |
| R10 | P2            | Startup [compatibility analysis](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/workflows/compatibility.ts#L61-L329) and [per-run adoption](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/workflows/engine.ts#L506-L632) already share some primitives but assemble related verdicts separately.                                                          | Complete the shared pure compatibility decision, retaining distinct global snapshot versus fenced per-execution orchestration. Remove duplicated verdict assembly, not the two checks. Test newer manifests reaching an older runner and changed already-recorded results.                                                                  |
| R11 | P1            | [Connection owner](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/connections/owner.ts#L198-L1727) aggregates durable sessions, live streams and effect progress. Repeated operations fence/load/check/run/update/flush rows.                                                                                                                                                    | Separate stream/progress responsibility from durable session ownership and extend the existing owned-row operation where it removes real repetition. Keep one broadcast sequencing owner. Test frame redelivery after session write and progress versus committed-frame ordering.                                                           |
| R12 | P1            | [Subscription tag summaries](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/subscriptions/relay.ts#L373-L415) must be updated during registration, delete, settle, widening and cleanup.                                                                                                                                                                                         | Storage operations should atomically own the subscription row and tag summary together. Remove caller-maintained add/remove bookkeeping and repeated wrappers. Test unsubscribe/resubscribe at a new epoch while an old delivery settles; do not hide the invariant in triggers.                                                            |

### C. Protocol, clients and React: 10 findings

| ID  | Priority               | Evidence and issue                                                                                                                                                                                                                                                                                              | Recommended change, deletion, and preservation check                                                                                                                                                                                                                                                                      |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | P0, native-reuse spike | [Custom SSE parser](file:///home/user/workspace/repo/packages/durable-actors/src/client/sessions/feed.ts#L52-L134) has the reproduced split-CRLF defect and manually owns syntax rules.                                                                                                                         | Add the asymmetric chunk-boundary regression, then replace/fix syntax parsing with the smallest standards-backed solution. Native Effect must preserve explicit-ID behavior; test terminal `end`, a domain event named `end`, BOM, empty/NUL IDs, fragmented UTF-8, limits and cancellation. Do not blindly swap parsers. |
| C2  | P1                     | [Watch response](file:///home/user/workspace/repo/packages/durable-actors/src/serve/sessions/watch.ts) and [stream response](file:///home/user/workspace/repo/packages/durable-actors/src/serve/sessions/stream.ts) repeat value conversion, terminal encoding and keepalive merging; feed also renders SSE.    | Share typed SSE framing/terminal/keepalive mechanics, using native encoding where it fits. Keep event names, IDs and successful termination policy with each protocol. Comments/keepalives remain a small explicit frame, not a new codec framework.                                                                      |
| C3  | P1                     | [Feed reconnection](file:///home/user/workspace/repo/packages/durable-actors/src/client/sessions/feed.ts#L136-L239) and [watch reconnection](file:///home/user/workspace/repo/packages/durable-actors/src/client/sessions/watch.ts#L12-L131) repeat expiry detection, jitter, retry-after, idle and auth retry. | Share connection-attempt supervision and backoff; retain separate cursor/version strategies. Test last-delivered cursor, greatest watch version, exactly one auth refresh attempt, retry-after minimum and abort during sleep. Streams must not auto-resume.                                                              |
| C4  | P1                     | [Client credential codes](file:///home/user/workspace/repo/packages/durable-actors/src/client/transport.ts#L28-L33) and [server codes](file:///home/user/workspace/repo/packages/durable-actors/src/serve/wire.ts#L62-L66) duplicate the same fact; sessions separately classify expiry.                        | Put canonical credential classification beside the error model and derive status/challenge/retry policy. Test every Unauthorized code across HTTP, queues and live transports. Do not unify command retry and session reconnection merely because they share a predicate.                                                 |
| C5  | P1                     | [clientOf](file:///home/user/workspace/repo/packages/durable-actors/src/client/make.ts#L508-L1257) mixes typed handle projection with identity, retries, optimistic state and offline orchestration.                                                                                                            | Separate schema/handle projection from transport attempt policy and queue/reducer state owners. Reuse existing session/offline modules and Effect primitives rather than add a second client runtime. Stable operation identity and client clock sampling are necessary, not duplicate server execution.                  |
| C6  | P1                     | [Wire mapping](file:///home/user/workspace/repo/packages/durable-actors/src/serve/wire.ts), [client decoding](file:///home/user/workspace/repo/packages/durable-actors/src/client/transport.ts#L112-L157), MCP wrapping and Python decoding rediscover related envelopes and classifications.                   | Maintain one protocol schema/fact source and a cross-language golden exchange corpus. Keep declared failures unwrapped and defects opaque. Generate immutable facts, not a universal transport envelope that changes the existing wire contract.                                                                          |
| C7  | Spike                  | [Browser socket client](file:///home/user/workspace/repo/packages/durable-actors/src/client/sessions/connection.ts#L173-L430) hand-wires native events, queues, open Deferred and finalization, while serving uses Effect Socket.                                                                               | Prototype a native scoped browser Socket adapter behind the same Promise/AsyncIterable interface. Require subprotocol, abort/close races, unknown-tag forward compatibility, ordered resync acknowledgments and bundle checks before deletion.                                                                            |
| C8  | P2, API decision       | React [watch](file:///home/user/workspace/repo/packages/react/src/watch.ts#L18-L56) and [feed](file:///home/user/workspace/repo/packages/react/src/feed.ts#L40-L102) independently wait for actor creation, whereas core clients treat NotCreated as terminal.                                                  | Keep documented behavior but share the small creation-wait operation and cancellation ownership. Move policy to core only if another real consumer needs it; make that outcome explicit rather than introducing a general retry-options DSL. Test create-during-wait and unmount.                                         |
| C9  | P2, API decision       | [useConnection](file:///home/user/workspace/repo/packages/react/src/connection.ts#L78-L140) uses JSON serialization as session identity.                                                                                                                                                                        | Design an explicit stable session key or ordinary identity policy after reviewing existing consumers. Do not silently change remount behavior. Test property order, undefined fields, transformed values, unsupported JSON and StrictMode.                                                                                |
| C10 | P1                     | [Python runtime](file:///home/user/workspace/repo/packages/python-client/python/runtime.py#L76-L391) manually clones error tags, identity, retries and decoding. TS and Python differ in attempts/deadlines and Retry-After parsing.                                                                            | Preserve the standard-library Python implementation, but generate protocol tables/vectors and test both clients against identical exchanges. Decide intended differences instead of calling them bugs without a contract. Do not import an Effect execution model into Python.                                            |

### D. Testing and evidence maintenance: 8 findings

| ID  | Priority                   | Evidence and issue                                                                                                                                                                                                                                                                                              | Recommended change, deletion, and preservation check                                                                                                                                                                                                                                                                                      |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | P1, largest harness target | [ConformanceFixture](file:///home/user/workspace/repo/packages/durable-actors/src/testing/conformance.ts#L332-L367) lists all features; [describeConformance](file:///home/user/workspace/repo/packages/durable-actors/src/testing/conformance.ts#L1588-L1685) builds all their layers even for selected cases. | Let each existing suite own its fixture and layers. Keep common backend/runtime lifecycle small and run only the selected suites' actors. Remove the all-features fixture type, central hook forwarding and global merge list as suites migrate. Compare collected case IDs/capabilities before and after.                                |
| T2  | P1                         | [Harness documentation and registrar](file:///home/user/workspace/repo/packages/durable-actors/src/testing/conformance.ts#L1575-L1788) explicitly compensate for timed-out tests abandoning Effects; ordinary wrappers often call runPromise without a test signal.                                             | Use installed `@effect/vitest` for repository-owned tests, or its signal/finalizer discipline behind the portable registrar. Cases should remain interruptible Effects until the outer runner boundary. Use live-clock mode for database/network tests where needed. Test timeout rollback/finalization and the next case's independence. |
| T3  | P1                         | [Neki exclusions](file:///home/user/workspace/repo/packages/durable-actors/src/testing/conformance/neki/groups.test.ts#L11-L90) infer fresh-database requirements by parsing imports, names and source text.                                                                                                    | Put requirements, including snapshot/fresh-database, on case/suite metadata. Derive inclusion/skips and remove the source parser. Preserve explicit unsupported-case reporting; do not claim Neki support from Postgres evidence.                                                                                                         |
| T4  | P2                         | There are **24** handwritten four-line Postgres shard wrappers; [their test](file:///home/user/workspace/repo/packages/durable-actors/src/testing/conformance/postgres/shards.test.ts#L11-L31) checks a literal source string.                                                                                  | Derive worker entries from the actual shard registry or supported runner projects. Remove wrapper/source-text coupling only if worker/database isolation and replica-exclusive scheduling remain unchanged. A single serial registrar is not automatically equivalent.                                                                    |
| T5  | P1                         | Identical database provisioning appears in [orders](file:///home/user/workspace/repo/examples/orders/src/order/layer.test.ts#L14-L49), [chat](file:///home/user/workspace/repo/examples/chat/src/room/layer.test.ts#L41-L78) and other examples.                                                                | Provide one scoped disposable-backend fixture and migrate callers. `tooling/databases/src/index.ts` is currently a placeholder, not a reusable implementation. Use the existing testing boundary or deliberately implement the tooling owner; never make core import another workspace package. Keep both backend runs.                   |
| T6  | P2                         | Browser suites repeat room/auth/history/client helpers across [chat](file:///home/user/workspace/repo/apps/e2e/chat.e2e.ts#L11-L41), [React](file:///home/user/workspace/repo/apps/e2e/react.e2e.ts#L11-L41) and offline cases.                                                                                 | Share fixture mechanics while preserving both plain Promise and React entry paths. Do not replace browser cleanup/offline/reconnect evidence with core unit tests.                                                                                                                                                                        |
| T7  | P2                         | [Client dependency test](file:///home/user/workspace/repo/packages/durable-actors/src/client/index.test.ts#L30-L50) requires a particular internal file; [link check](file:///home/user/workspace/repo/tooling/doc-checks/src/links.test.ts#L78-L96) requires more than 100 sources.                            | Remove the required `/errors/actor.ts` path assertion; replace the numeric repository-size threshold with a few named authoritative inputs. Keep forbidden imports, actual browser bundling, parser fixtures and broken-link scanning. These are small, clear low-value assertions, not a large suite purge.                              |
| T8  | P1                         | [Evidence ledger checker](file:///home/user/workspace/repo/tooling/structure/src/ledger.ts) infers case names from English-shaped Markdown spans and regex-scanned string/template literals.                                                                                                                    | Give cases stable IDs and generate/check a lightweight evidence index from the case registry. Remove prose/template heuristics. The index must map claims to executable cases and provider results; a declared ID alone never proves a gate passed.                                                                                       |

### E. Structure, documentation and scaffolding: 10 findings

| ID  | Priority            | Evidence and issue                                                                                                                                                                                                                                                                                                                         | Recommended change, deletion, and preservation check                                                                                                                                                                                                                                                          |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | P1                  | [Manifest-aware structure check](file:///home/user/workspace/repo/tooling/structure/src/index.ts#L110-L231) and [path-depth barrel lint](file:///home/user/workspace/repo/tooling/oxlint/src/rules/no-barrel-index.ts) enforce the same entry rule differently.                                                                            | Keep the actual export-manifest owner; remove the duplicate approximate rule/registration/test. Preserve exact entries and no wildcard exports. Editor-local feedback is optional, not a second truth.                                                                                                        |
| G2  | P2, policy change   | [Tree checker](file:///home/user/workspace/repo/tooling/structure/src/index.ts#L110-L399) mixes package boundaries with directory-size and one-off shape rules.                                                                                                                                                                            | Narrow enforcement to dependency direction, explicit exports and real contracts. Retire arbitrary leaf-count constraints if they only force splits. Preserve the separate StyleX compile unit instead of moving UI merely to satisfy a naming ideal. Update the structure policy before changing enforcement. |
| G3  | P1, formatter spike | The readable-spacing rule plus vendored AST/options/engine is **1,091 lines** before its tests: [wrapper](file:///home/user/workspace/repo/tooling/oxlint/anti-slop/rules/require-readable-spacing.ts) and [engine](file:///home/user/workspace/repo/tooling/oxlint/anti-slop/vendor/eslint-stylistic/padding-line-between-statements.ts). | Let formatting own spacing, or accept formatter output and remove this subjective rule. Do not assume oxfmt reproduces the policy without checking. Removing this corpus is more valuable than adding a configurable formatting adapter. Retain license notices for any vendored code that remains.           |
| G4  | P2                  | Rule names are separately registered in plugin files and enabled in `.oxlintrc.json`; multiple anti-slop plugin layers add synchronization points.                                                                                                                                                                                         | Prune/consolidate plugins first and keep one rule registry where practical. Do not create a new code-generation pipeline merely to eliminate a small deliberate config list. Keep no-inline-comments and no-decision-references enabled.                                                                      |
| G5  | P1                  | [Snippet parser](file:///home/user/workspace/repo/tooling/doc-checks/src/snippets.ts#L35-L242) implements hidden preludes/modules, markers, isolation and diagnostic remapping.                                                                                                                                                            | Make important examples real checked TypeScript fixtures and embed them, or limit fences to self-contained snippets. Delete the mini-language only after published examples still typecheck. Preserve explicitly unimplemented sketches as sketches.                                                          |
| G6  | P1                  | [Dev inspector schemas](file:///home/user/workspace/repo/apps/cli/src/commands/dev/inspector/schema.ts#L6-L223) and [operator display schema](file:///home/user/workspace/repo/apps/cli/src/commands/inspect/show.ts#L28-L69) manually mirror runner responses.                                                                            | Define response schemas with the server-owned API and derive narrower CLI formatter views. Remove duplicate decoded/state/receipt/totals definitions. Optional receipt outcomes reflect authorization and must not disappear in consolidation.                                                                |
| G7  | P0, reconcile       | [Structure document](file:///home/user/workspace/repo/docs/architecture/repository-structure.md#L95-L101) says the CLI has no bin until login exists; [manifest](file:///home/user/workspace/repo/apps/cli/package.json#L5-L7) already exposes one while login/deploy/migrate reservations remain empty.                                   | Record the actual intended CLI scope in a decision and reconcile docs before changing it. Delete only unneeded reservations/stale claims after that decision. Do not remove the working CLI or implement hosted login/deploy as unrelated cleanup.                                                            |
| G8  | P1                  | [Scaffold versions](file:///home/user/workspace/repo/packages/create/src/scaffold.ts#L13-L24) duplicate root catalog/core peer pins, with a [sync test](file:///home/user/workspace/repo/packages/create/src/scaffold.test.ts#L25-L44).                                                                                                    | Derive the published template manifest during build/release. Delete manual pin synchronization, but retain explicit generated pins and packaged-project install/typecheck evidence. Published code cannot read the monorepo root at runtime.                                                                  |
| G9  | P2                  | Counter/chat templates duplicate database, tsconfig and gitignore files; [scaffold copying](file:///home/user/workspace/repo/packages/create/src/scaffold.ts#L133-L148) copies complete trees.                                                                                                                                             | Use a common template base plus concrete overlays. Delete duplicate files, not separate runnable examples. Verify each generated project and preserve npm's gitignore packaging workaround.                                                                                                                   |
| G10 | P2, policy change   | [Role-folder rule](file:///home/user/workspace/repo/docs/architecture/repository-structure.md#L79-L87) requires actor contract/layer roles; placeholder packages/directories reserve future ownership.                                                                                                                                     | Permit a tiny actor in one understandable module and split when responsibilities justify it. Remove empty reservations that no actual public contract requires. Do not reorganize the working control-plane/product packages merely to shrink a framework metric.                                             |

## Which tests should actually go?

**Recommendation: remove shape-coupling and fixture duplication first, not failure coverage.** No static review can honestly certify a broad test deletion as having zero net downside.

| Candidate                                                                         | Decision                                       | Evidence that survives / condition                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Requiring `/errors/actor.ts` in the client graph                                  | Remove assertion                               | Forbidden-runtime/dependency checks and an actual browser build still enforce the contract.                                                                                                      |
| Link source count `> 100`                                                         | Replace assertion                              | Named essential documents prevent a vacuous scan; actual broken links still fail.                                                                                                                |
| Postgres entrypoint literal text                                                  | Remove after T4                                | Case selection, unique groups, worker isolation and real provider runs remain structural/executed evidence.                                                                                      |
| Neki source-import/regex capability inference                                     | Replace after T3                               | Explicit case requirements and reported provider skips own the rule.                                                                                                                             |
| Scaffold version-equality synchronization                                         | Remove after G8                                | Generated manifest plus tarball install/typecheck validates the result without copied version facts.                                                                                             |
| `Object.keys(A.api)` insertion order in definition tests                          | Review, not automatic removal                  | Public/internal exposure must still be asserted behaviorally. Types alone do not prove runtime objects match them.                                                                               |
| Effect tag/instance or step-kind constructor smoke assertions                     | Consolidate only if equivalent evidence exists | They may be public metadata promises. Do not label every getter test tautological without reading its consumers and contract.                                                                    |
| PGlite borrowed `query` descriptor equality                                       | **Keep**                                       | The [server API](file:///home/user/workspace/repo/docs/api/01-server-api.md#L36) explicitly promises a borrowed client keeps its methods and lifetime. Query usability alone is weaker evidence. |
| Documentation example typechecking                                                | **Keep, simplify input machinery**             | Documentation is a public interface. Moving checked examples to real files can remove parser support, not the API evidence.                                                                      |
| PGlite and Postgres executions of the same cases                                  | **Keep**                                       | They prove different backend capabilities; independent connections are not simulated by PGlite.                                                                                                  |
| Seeded simulation validation/reproducibility                                      | **Keep**                                       | The testing facility must not report false fault/replay evidence.                                                                                                                                |
| Upstream WorkflowEngine differential cases                                        | **Keep**                                       | Shared scenarios against Effect and the actor-owned engine detect semantic divergence.                                                                                                           |
| SIGKILL, fencing, commit-unknown, rollback, access revocation, provider ambiguity | **Keep**                                       | These cover the framework's defining failure trajectories.                                                                                                                                       |
| Promise-versus-React E2E behavior                                                 | **Keep scenarios, merge fixtures**             | Hook lifecycle and SDK integration can fail independently.                                                                                                                                       |

For each proposed behavioral test deletion, name the plausible wrong implementation and the surviving test that rejects it. Use targeted mutation experiments for disputed duplicates, not a blanket coverage percentage. Do not manufacture dozens of easy replacement cases to keep a test-count metric unchanged.

## Simplifications considered and rejected

These are important because some initially attractive subagent recommendations would not preserve the current contracts:

1. **Remove early receipt replay and always route to activation.** [Dispatch](file:///home/user/workspace/repo/packages/durable-actors/src/runtime/layer.ts#L720-L744) intentionally serves retained receipts before entity delivery. Removing it can add activation/capacity/handler-build dependencies to replay. Share receipt policy, but retain this path unless a separate product/performance decision proves the behavior trade acceptable.
2. **Move the Cluster Entity onto the root Actor.make result.** Stable entity identity is useful, but Cluster imports belong under runtime. Use runtime-owned metadata/registration instead.
3. **Replace the whole member model with RPC.** A real RpcGroup can replace ordinary handler/schema plumbing; it does not by itself model generation authority, receipts, internal delivery, optimistic reducers, cursor history, or connection resync. Adopt only after a measured spike deletes more than it adds.
4. **Replace the custom workflow engine with ClusterWorkflowEngine.** Upstream persists through Cluster message storage. Actor starts/step state/timers have actor-owned transactional requirements here. Keep the engine adapter; reuse compatible primitives/types.
5. **Replace every Array/boolean with Ref/Queue/services.** Native primitives earn their keep when they simplify synchronization/lifetime. Local arrays and flags are not defects by themselves.
6. **Turn all handlers into a pure `{ state, reply, tasks }` return DSL.** That duplicates existing reducers and does not preserve relational command capabilities without another interpreter.
7. **One universal retry/cursor engine.** Commands, history feeds, freshness watches, non-resumable streams, and fresh connection sessions have different meanings. Share mechanics, not authority or failure semantics.
8. **Delete runtime guards because types reject misuse.** Types do not defend JavaScript, erased casts, stale closures, concurrent fibers or untrusted requests. Keep turn/fiber/ownership guards and test them.
9. **Remove JSDoc or add comment rules.** The user's preference is already enforced. Keep reasons and public contracts, avoid narration and stale decision references; no new governance layer is needed.
10. **Erase distinct providers or product packages to claim tenfold reduction.** That removes functionality or ownership, not complexity while preserving behavior.

## Implementation sequence

### 1. Reconcile the target and lock the baseline

**Owners:** docs/API decisions, `actor/definition.test.ts`, conformance registry, package/browser checks.

- Record the intended API conventions and resolve the actual CLI/doc mismatch. Preserve explicit authored contracts; do not choose whichever source is easiest to implement.
- Capture executable case IDs by suite/backend, bundle entry sizes, declaration/typecheck cost, and representative benchmark results.
- Add only the two decisive regressions for declaration poisoning and split-CRLF parsing before their fixes.
- Identify which public changes require a superseding ADR. For this unfinished alpha, prefer one deliberate API migration over a permanent compatibility maze; do not assume that authorizes breaking stored data or wire contracts.

**Exit:** the unchanged behavior and proposed intentional changes are separately reviewable; no durable guarantee is being silently removed.

### 2. Repair and simplify declaration compilation

**Owners:** `actor/definition.ts`, `actor/served.ts`, `members/*`, `policies/command.ts`, phase adapters.

- Fix A1 by validation-before-publication.
- Introduce one immutable compiled descriptor using existing module boundaries; consolidate codec and policy ownership.
- Move execution construction out of the declaration closure while preserving build lifetime; migrate public spelling to the accepted greenfield API above.
- Verify behavior before changing the API. Then run the A5–A7 type/ergonomics spike and migrate consumers/docs/templates atomically if it succeeds.

**Exit:** a reader can explain Actor.make without tracing command execution; invalid construction leaves no poisoned metadata; browser contracts and phase checks still pass.

### 3. Shrink the test and protocol scaffolding

**Owners:** `testing/conformance.ts` and suite owners, Postgres/Neki registration, examples, client/serve SSE and wire modules.

- Make fixtures and layers suite-owned; retain one backend lifecycle and portable conformance adapter.
- Add test cancellation/finalizer ownership using native Effect Vitest where appropriate.
- Replace source-derived capabilities/ledger names with explicit registry facts.
- Merge example/E2E fixture mechanics and remove only the narrow justified assertions above.
- Fix/probe SSE syntax and consolidate framing/reconnect mechanics without changing resume meaning.
- Establish shared wire/error facts and TS/Python exchange vectors.

**Exit:** identical supported case coverage, honest skips, no timed-out test contaminating the next case, unchanged transport/wire behavior except the documented parser fix.

### 4. Refactor the turn and activation kernels

**Owners:** `runtime/turn/execute.ts`, `runtime/entity/register.ts`, storage ownership, post-commit publication.

- Consolidate common session/batch lifecycle while keeping backend capability branches.
- Separate activation lifetime from command work; trial Queue only if it actually deletes coordination.
- Give committed results one ordered publication owner.
- Consolidate fencing policy without hiding lock modes or introducing another authority service.

**Exit:** all durable-transition failures pass on real Postgres; PGlite remains supported; lone-command latency, batch behavior, round trips and benchmark tails show no material regression.

### 5. Consolidate delivery and workflow supervision

**Owners:** outbox/effect/subscription relay, workflow engine/compatibility, connection owner.

- Extract only the shared lease-supervision responsibility, preserving typed domain settle operations.
- Separate effect outcome decisions from guarded persisted transitions.
- Replace workflow quiescence polling and share compatibility verdict assembly.
- Consolidate subscription-summary writes and isolate stream/progress responsibility without splitting broadcast ordering.

**Exit:** lease loss, late completion, cancel/unknown outcome, old epochs, owner resync, parking/resume, and rolling-manifest cases all retain their expected results.

### 6. Remove obsolete governance and template machinery

**Owners:** structure/Oxlint, docs snippets, CLI schemas, create templates/release artifacts.

- Delete duplicate barrel policy and spacing-vendor machinery after formatter/policy decisions.
- Replace the snippet mini-language only after real checked examples provide equivalent public API evidence.
- Derive inspector schemas and released template versions from their owners.
- Share template bases and retire justified empty reservations.
- Reconcile architecture/support documents and verification claims with the resulting implementation.

**Exit:** fewer rule engines, copied schemas and synchronization tests, with no loss of packaging, documentation, dependency or no-comment guarantees.

## Verification and stop conditions

Run the repository's actual commands at each relevant boundary; do not call a design spike successful because it compiles one counter.

| Change                    | Cheapest decisive evidence                                                                         | Broader evidence                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Declaration/compiler/API  | Exact regression and negative type cases; source and emitted declaration review                    | `bun run --cwd packages/durable-actors typecheck`, `test`, `build`; all examples; `bun run pack:check` |
| Browser descriptor/client | Real contract and `/client` browser bundle, dependency graph, wire round trips                     | Promise/React/offline E2E and packed consumer smoke                                                    |
| Harness/registry          | Collected case IDs/requirements before vs after; timeout cleanup regression                        | PGlite conformance, Postgres integration and explicit Neki capability reports                          |
| SSE and sessions          | The asymmetric CRLF probe, ID/end distinctions, cancellation, golden frames                        | Transport/feed/watch/connection conformance and reconnect E2E                                          |
| Turn/session/fencing      | Failure receipt rollback, interrupted pipeline, stale writer, duplicate IDs, failed chained commit | `bun run --cwd packages/durable-actors test:integration`, crash drills, multi-runner/replica suites    |
| Workers/workflows         | Lost lease/claim, late success, cancel ambiguity, old subscription epoch, simultaneous park/resume | Existing relay/workflow/subscription crash and compatibility suites                                    |
| Tooling/scaffolds/docs    | Relevant package tests and generated-project install/typecheck                                     | `bun run lint:structure`, `bun run format:check`, `bun run check`, packed smoke                        |

Commands for additional boundaries: `bun run --cwd packages/react test`, `bun run --cwd packages/python-client test`, `bun run test:e2e`, `bun run bench` and `bun run bench:compare`. Use package scripts/configs for supported database setup; keep connection values redacted. Verify the current exact scripts before implementation as repository state evolves.

**Stop/rework a simplification when:**

- it adds a second protocol/registry instead of replacing one;
- it moves Cluster/SQL into browser declarations;
- it reduces tests by removing a distinct invariant/provider rather than duplicate machinery;
- it creates a generic callback engine with more modes than the code it replaces;
- it changes acceptance, expiry, receipt replay, live-session or commit semantics without an explicit contract decision;
- it hides cancellation, an unknown effect outcome, a retention gap, or missing provider evidence;
- it degrades the two-round-trip/pipelined turn path without an intentional measured tradeoff.

## Success criteria

- One owner for declaration facts/codecs, resolved policy, each persisted transition, and each resource lifetime.
- The ordinary actor declaration stays compact; no alternate actor builder or mandatory new DSL.
- Substantially less handwritten fixture/registration/wire machinery. Set numerical reduction targets after separating scaffolding from behavior, not by counting test filenames.
- Each phase records deleted versus added code, removed concepts/configuration, and surviving behavior evidence. A responsibility split that only creates more files and parameter plumbing is not a simplification win.
- Public APIs consistently use Effect conventions and preserve phase capability checks.
- No permanent aliases, copied configuration tables, or new wrapper frameworks introduced solely to manufacture DRY.
- The existing examples still run end to end, and provider/durability support is backed by the same or stronger failure evidence.
- Clear JSDoc contracts and self-describing code, with existing no-inline-comment enforcement retained.

## Follow-up: complete actor-authoring API recommendation

This supplements the original 50-candidate audit. The execution decisions above authorize its implementation and supersede the original limited-renaming recommendation. Public syntax changes are recorded in [ADR 0063](docs/decisions/0063-framework-simplification.md) and require corresponding vision/API/contract updates. Do not silently treat native Effect conventions as permission to change durable semantics.

### Decisions and rejected shortcuts

1. Keep `Actor.make(name, definition)`, stable explicit member tags, keyed `api`/`internal`, and distinct phase services. Reject a fluent builder, class/decorator actor model, mixed untyped member array, or universal context.
2. Name staged external I/O **jobs**, not `effects`, to distinguish it from the Effect library. Keep jobs distinct from multi-step workflows. Rename authoring `turn.perform` to `turn.enqueue`, `cancelEffect` to `cancelJob`, `toEffectLayer` to `toJobLayer` and `Executor.effectId` to `Executor.jobId`. Migrate SQL, metadata, inspection, telemetry and progress field names consistently in this unreleased alpha, with no compatibility aliases. Preserve durable identity values, provider idempotency, outcome meanings and cancellation guarantees; this is a vocabulary migration, not exactly-once external I/O.
3. Put an actor's job schema reference and retry/result-route settings in one `jobs` binding registry. Do not put actor-specific routes on the shared job schema, and never put `execute` callbacks in `Actor.make`. Schemas remain reusable across actors; executor implementations stay in their own layer.
4. Prefer direct `Actor.event(tag, fields, options?)` and `Actor.job(tag, options?)` values to mandatory empty outer subclasses and caller-supplied `Self`. Preserve native constructor/schema capabilities, tagged wire shape, migration/write-version behavior, and yieldable tagged error classes. Do not combine this ergonomics change with deleting class-identity tests or migration prototype support.
5. Adopt `payload`, `success`, and `error` where those concepts actually exist. `error` is a schema of supported tagged yieldable errors, not an arbitrary schema allowing framework reasons to masquerade as domain failures. Normalize field maps once, preserve service-free codecs, and preserve no-input encoded defaults. Workflow and tagged job payloads remain record-shaped. Do not add a job `error` option solely for visual symmetry: executor failures and ambiguous outcomes use the existing job settlement contract.
6. Accept a handler map or an Effect producing a map on each existing phase layer, with inferred per-handler requirements. Keep query and executor deployments separate. Preserve normal per-layer and singleton per-activation build lifetimes. Typed builder failures need their real owner: layer startup for ordinary/query/job builders, activation failure for singleton builds; a singleton build must not be run early merely to obtain a convenient `Layer` error type. This full signature needs a type/lifetime spike.
7. Move `createdBy` and `cron` behavior declarations out of the generic policy bag, to `createdBy` and `schedules`. Keep actor policy shallow; reject deep policy hierarchies, behavior profiles, or moving all actor guarantees into a runner config. Optional `api` may default to `{}` for internal-only actors, subject to an inference/security probe.
8. Rename reducer `commutative` to `batch: { combine }`: the actual implementation combines consecutive inputs in order and requires fold equivalence, not mathematical commutativity or a CRDT merge. Preserve void replies, no declared failures, individual receipts, pure optimistic transitions, and the unchanged order.
9. Have `Actor.Delivery({ source, events })` retain those declaration facts, so a subscription can use `delivery: OrderDelivery` instead of restating `source` and `events`. Keep an explicit internal handler, its tag and declared errors, route/retired settings, and shared-handler support. Reject an implicit subscription-owned command in this phase: existing subscriptions share a handler across sources/event subsets and permit declared failures, so synthesizing commands would introduce identity and inference work rather than simply deleting duplication.

### Every current Actor.make option

Source: [Definition options](file:///home/user/workspace/repo/packages/durable-actors/src/actor/definition.ts#L665-L730).

| Current         | Recommended target                                            | Constraint                                                                                                           |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `key`           | Keep                                                          | Schema, tenant singleton, or omitted generated identity; no separate conflicting mode booleans.                      |
| `placement`     | Keep                                                          | Tenant/actor/parent shard boundaries are real ownership choices; parent-local key and full identity remain distinct. |
| `state`         | Keep `Actor.state`                                            | Defaults and persisted migration chain are not replaced by a plain `initialState`.                                   |
| `events`        | Keep                                                          | Declares what can be emitted/replayed, not who can read it.                                                          |
| `feeds`         | Keep explicit                                                 | Declares transport exposure; never automatically publish every event.                                                |
| `tables`        | Keep                                                          | Owned/adopted rows and enforcement gates retain their authority.                                                     |
| `blobs`         | Keep                                                          | Continue listing mutable blobs and immutable content references without erasing their distinct semantics.            |
| `api`           | Keep keyed record; consider omitted = `{}`                    | Exposure is not authorization; key/tag equality and handler coverage remain checked.                                 |
| `internal`      | Keep keyed command record                                     | Never exposed by public handles/transports.                                                                          |
| `effects`       | Replace with `jobs` binding record                            | Schema plus actor-specific policy has one owner.                                                                     |
| `policy`        | Keep shallow                                                  | Limits/security/retention/lifecycle stay actor-specific where applicable.                                            |
| `access`        | Keep                                                          | Global authorize AND actor policy; omission does not imply anonymous access.                                         |
| `subscriptions` | Keep collection; derive source/events through delivery schema | Preserve source permission, internal handler identity and cursor/epoch semantics.                                    |

This can increase the optional top-level field count from 13 to 15. The goal is fewer facts repeated across registries, not the fewest property names at the expense of meaningful boundaries.

### Every current policy field

Source: [Policy](file:///home/user/workspace/repo/packages/durable-actors/src/policies/command.ts#L24-L147).

| Current                    | Recommended                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `hibernateAfter`           | Keep actor activation idle duration.                                                                                                   |
| `commandTimeout`           | Rename to `executionTimeout`, retaining current bounded command and query execution coverage; not a workflow or live-session lifetime. |
| `lockWait`                 | Keep generation-lock acquisition limit.                                                                                                |
| `deliveryTimeout`          | Keep caller waiting limit, not cancellation of accepted work.                                                                          |
| `maxStateBytes`            | Keep.                                                                                                                                  |
| `mailboxCapacity`          | Keep actor activation admission/backpressure.                                                                                          |
| `createdBy`                | Move to actor-level `createdBy`, preserving first-commit/minting/creation/adoption restrictions.                                       |
| `keepReceipts`             | Keep identity-expiry, pending-work and delivery-margin constraints.                                                                    |
| `keepEvents`               | Keep replay retention and visible gaps.                                                                                                |
| `maxBlobBytes`             | Keep.                                                                                                                                  |
| `maxBlobEntries`           | Keep.                                                                                                                                  |
| `keepWorkflows`            | Keep finished-result retention and deployment retry-window minimum.                                                                    |
| `effects`                  | Remove this side registry; put settings on each `jobs` binding.                                                                        |
| `cron`                     | Move to actor-level `schedules`, preserving existing expressions, interval grammar, tick identity and DST/coalescing behavior.         |
| `cronSkipIfOlderThan`      | Rename `maxScheduleLag`, preserving the threshold and default.                                                                         |
| `connections`              | Keep `park`/`keepAwake`; these do not guarantee permanent residency.                                                                   |
| `reauthorizeEvery`         | Keep live external-session revocation bound; not cancellation of accepted internal work.                                               |
| `watch`                    | Keep `maxPerActor`, `minInterval`, `reconcileEvery`; reconciliation repairs lost broadcasts.                                           |
| `subscribers`              | Rename `allowedSubscriberTypes`; these are actor type names, not user principals.                                                      |
| `holdEventsForSubscribers` | Keep bounded additional history retention and lagging subscriber gaps.                                                                 |

### Related constructors and options

| Surface                        | Complete option treatment                                                                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Actor.command`                | `input/output/errors` become `payload/success/error`; preserve Void/Void/no-error defaults, tagged errors and reserved framework reasons.                                                                                                                                         |
| `Actor.query`                  | Same schema vocabulary; keep `watch` and its Read-only handler restriction.                                                                                                                                                                                                       |
| `Actor.reducer`                | Keep `state`, `reduce`; `input/errors` become `payload/error`; `commutative.combine` becomes `batch.combine`. Success remains committed state or batch Void, not a configurable reply DSL.                                                                                        |
| `Actor.stream`                 | `input/output/errors` become `payload/success/error`; success describes each live element. `progress.effects` becomes `progress.jobs`; retain transient and activation-ending semantics.                                                                                          |
| `Actor.connection`             | `params/errors` become `payload/error`; retain `server`, `client`, `session`, `stampCursor`, and `progress.to`; rename only `progress.effects` to `progress.jobs`. Client frames still default to Never, cursor stamping to true, audience to performer.                          |
| `Actor.workflow`               | `input/output/errors` become `payload/success/error`; keep `key` and `versions` (`current/min`), named `step/sleep/wait/race`, and record-shaped/no-input codecs.                                                                                                                 |
| Workflow `step`                | `input/errors` become `payload/error`; keep `success` and stable step name.                                                                                                                                                                                                       |
| Workflow `sleep`               | Keep stable declaration name and Duration argument.                                                                                                                                                                                                                               |
| Workflow `wait`                | Keep event class, stable name, `where`, `timeout`.                                                                                                                                                                                                                                |
| Workflow `race`                | `errors` becomes `error`; keep `success`, stable name and recorded winner/exit behavior.                                                                                                                                                                                          |
| Event                          | Direct value factory with tag/fields; preserve `migrations`, `writeVersion`.                                                                                                                                                                                                      |
| Job schema                     | Direct value factory; `input` becomes `payload`; preserve `success`, `progress`, `migrations`, `writeVersion`.                                                                                                                                                                    |
| Job binding                    | Preserve `timeout`, `progressEvery`, `retry.times`, `retry.backoff.base/max`, `onSuccess`, `onDeadLetter`, `onCancelled`, `concurrency.perActor`. Persisted retries are not replaced by process-local Schedule sleeps; cross-runner limits are not replaced by a local Semaphore. |
| Staging a job                  | `perform/cancelEffect` become `enqueue/cancelJob`; retain options `key`, `after`, `at` and committed replacement/cancellation semantics.                                                                                                                                          |
| Executor                       | Use stable `jobId`, `attempt`, `principal`, owner `ref` and transient `progress`; do not add actor state/database authority.                                                                                                                                                      |
| Subscription                   | Replace repeated `source/events` options with `delivery`; keep `handler`, `retired`, `route`; dynamic subscribe keeps `from` (now/start/cursor).                                                                                                                                  |
| `Actor.state`                  | Keep fields and `migrations`.                                                                                                                                                                                                                                                     |
| `Actor.migration`              | Keep `from`, `to`, `upcast`, optional `downcast`; do not infer versions from file order.                                                                                                                                                                                          |
| `Actor.table`                  | Keep Drizzle table plus adoption `owner.tenant/actor`, `access: read/write`; read adoption, write adoption and framework-owned rows are different capabilities.                                                                                                                   |
| `Actor.blob` / `Actor.content` | Keep named mutable actor bytes versus immutable shared tenant content as different resources.                                                                                                                                                                                     |
| Definition facade              | Keep `get`, conditional `create/idOf`, `intents`, `run`, derived `client`; simplify adapters, not identity/phase distinctions. `create` currently allocates a handle/identity, not evidence that a creation turn committed.                                                       |
| Serving/auth                   | Move adapter construction to the existing runtime entry if needed to make root declarations browser-light; do not preserve server import leakage with a lazy-wrapper maze. This is an explicit export-contract change, not a claim that current bundles fail.                     |

### Target job example

The syntax below is proposed, not available in the framework yet. `PaymentResult` is one shared schema fact; the two handler layers remain independent.

```ts
const PaymentResult = Schema.Struct({ providerId: Schema.String })

const Charge = Actor.job("Charge", {
  payload: { amount: Schema.Int },
  success: PaymentResult,
})

const Place = Actor.command("Place", { payload: { amount: Schema.Int } })
const Paid = Actor.command("Paid", { payload: PaymentResult })

const Order = Actor.make("Order", {
  key: Schema.String,
  state: Actor.state({
    paid: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  api: { Place },
  internal: { Paid },
  createdBy: Place,
  jobs: {
    Charge: { job: Charge, onSuccess: Paid, retry: { times: 3 } },
  },
})

const OrderLive = Order.toLayer({
  Place: Effect.fn(function* ({ amount }) {
    const turn = yield* Order.Turn
    yield* turn.enqueue(Charge.make({ amount }))
  }),
  Paid: Effect.fn(function* () {
    const turn = yield* Order.Turn
    yield* turn.state.set({ paid: true })
  }),
})

const OrderJobs = Order.toJobLayer({
  Charge: Effect.fn(function* (request) {
    const payments = yield* Payments
    const executor = yield* Order.Executor
    return yield* payments.charge(request, { idempotencyKey: executor.jobId })
  }),
})
```

`Payments` denotes the application's typed Effect service, not a new framework abstraction. Access is intentionally omitted from this compact example: without global authorization, only System callers are allowed, not anonymous customers.

```diagram
Place({ amount: 713 })
  └── fenced turn transaction
      ├── stage Charge { _tag: "Charge", amount: 713 }
      └── COMMIT obligation + creation/state + receipt
          └── separately deployed executor claims Charge
              ├── call provider with stable jobId
              └── guarded success settlement
                  └── route Paid({ providerId: "provider-a" })
                      └── new fenced turn commits paid = true
```

Rollback exposes no job. Provider success followed by a crash before settlement can cause another call with the same idempotency key; renaming the API does not make it exactly once. Progress remains transient, not durable success evidence.

### Executed follow-up probes

**Constructor prototype:** a temporary file used native `Schema.TaggedClass<Schema.TaggedStruct<Tag, Fields>["Type"]>()`, the existing payload-chain registration/codec, and inferred metadata. It needed the same metadata/default-schema assertions used by current factories, not a new HKT/overload framework or widening the public result to `any`. Strict TypeScript accepted six negative type assertions and correct literal-tag/payload/success/progress inference. Runtime preserved `.make`, `new`, `instanceof`, JSON object shape, class-instance decoding, chain metadata, and version-0 downcast/version-1 upcast behavior.

Commands:

```text
bun node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2024 --module Preserve --moduleResolution Bundler --allowImportingTsExtensions --types bun .amp/actor-value-spike.ts
→ exit 0

bun .amp/actor-value-spike.ts
→ PASS: inferred tags, payload/success/progress, negative type cases, .make/new/instanceof, JSON roundtrip, metadata lookup, payload up/downcasting
```

The prototype is removed after verification; this is evidence for the factory mechanism only, not the whole proposed Actor.make/handler/binding API or a database/provider support claim.

**False-green law check, reproduced:** `checkMergeLaw({ reducer: AlwaysThrows, runs: 3 })` returned `3` successfully. [reduceSafely](file:///home/user/workspace/repo/packages/durable-actors/src/testing/property.ts#L58-L74) erases a failure/throw to `{ ok: false }`, and [the property](file:///home/user/workspace/repo/packages/durable-actors/src/testing/property.ts#L108-L117) accepts equality of two failures. Its equality check alone does not establish the documented non-failing reducer contract. Strengthen the check to require successful valid reductions and retain independent asymmetric/order-sensitive cases; do not mistake this finding for a reason to delete algebraic evidence.

### Small, strong proof gates

- Rollback/crash/retry across actual turn storage and the after-commit executor boundary; same stable provider key, correct route/state, no pre-commit call.
- Two actors sharing one job schema with different result routes/policies, plus cancellation and unknown-outcome settlement.
- Shared subscription handler across different sources/event subsets; unchanged durable tags/bytes, ordered retries, stale epoch, declared failure and retention gap.
- Creation gates, parent identity, explicit feed exposure and live revocation, including negative authorization paths.
- Stored payload/workflow migration and recorded step identities across restart.
- A compact negative type/capability suite and browser/packed-consumer check; integration/E2E cannot replace compile-time rejection or package export evidence.
- Focused ordered-batching law evidence, with an always-throwing counterexample that must fail, and a noncommutative ordered append case that must succeed.

Do not add one test per constructor option or snapshot declaration internals. Each retained or added test must fail under a named plausible incorrect implementation, and test reduction must preserve distinct failure/provider evidence.

**Delivery state:** implementation is authorized and tracked in the execution ledger above. The audit probes describe the original defects, not proof of fixes. Completion requires integrated verification and merge into remote `main`, not merely dispatching workers.
