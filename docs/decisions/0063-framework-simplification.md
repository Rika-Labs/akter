# ADR 0063: Greenfield framework simplification

**Status:** accepted (2026-09-30, Dallen).

**Responsibility:** make actor authoring consistent and reduce duplicated declaration, execution, protocol, test and tooling machinery before the first alpha.

**Authority:** design decision record.

**Owner role:** framework architecture.

**Change policy:** supersede through a new ADR.

## Context

The unreleased framework has one useful Effect-native actor model surrounded by overlapping metadata registries, repeated codecs, mandatory declaration subclasses, duplicated job policy, large shared test fixtures, custom transport mechanics and multiple sources of repository policy. The audit in [plan.md](../../plan.md) includes three reproduced defects: rejected declarations publish table ownership, split-CRLF SSE parsing loses the event name, and the batching-law checker accepts a reducer that always throws.

Dallen authorized the full simplification plan, parallel high-mode implementation and merge into `main`. The first alpha is not released, so a coordinated source/storage/wire vocabulary migration is preferable to compatibility layers. This decision amends the authoring/export conventions in ADRs 0010, 0012, 0024, 0026, 0027, 0030 and 0032, the inspection naming/version conventions in ADR 0028, and the repository/testing conventions in ADRs 0001, 0009 and 0061. It does not weaken their durable guarantees.

## Decision

1. Keep one data-first `Actor.make`, keyed `api` and `internal`, explicit phase services and separately deployable handler/query/job layers. Validate the whole definition before publishing immutable declaration metadata; compile member facts/codecs once. The descriptor is process metadata, never durable authority.
2. Use direct `Actor.event` and `Actor.job` schema values. Use `payload`, `success` and a supported tagged `error` schema where applicable, retaining service-free codecs, no-input defaults, class constructors and persisted payload migration semantics. Accept handler maps or Effect builders with inferred requirements. Preserve ordinary layer-build and singleton activation-build lifetimes, with typed errors owned at the actual boundary.
3. Name staged external work jobs throughout the public API, runtime, SQL, inspection, telemetry and progress metadata. One actor-local `jobs` binding registry owns schema references and retry/result routes. Use `enqueue`, `cancelJob`, `toJobLayer` and `jobId`. No legacy aliases or compatibility decoders. Stable identity values, provider idempotency, ambiguous outcomes, guarded settlement and independent executor deployment remain unchanged. Before the first alpha, migration `0026_jobs` replaces the unreleased `durable.effects` view with `durable.jobs` and renames the existing `durable.dead_letters` columns to `job_id` and `job`, recording version 2 in `durable.views`. This is the one greenfield exception to ADR 0028's new-name rule; after a release, breaking view changes still require a new view name and retirement decision.
4. Put `createdBy` and `schedules` on the actor definition; keep policy shallow. Use `executionTimeout`, `maxScheduleLag` and `allowedSubscriberTypes`. Use reducer `batch: { combine }` to describe ordered fold equivalence, not commutativity. Subscriptions derive source/event facts from a delivery schema while retaining explicit internal handlers, shared-handler support, routes and declared failures.
5. Keep root/client declarations browser-safe. Server/auth adapter construction belongs behind the existing runtime entry. Share protocol facts and framing mechanics, not command/feed/watch/stream/session semantics. Do not add another RPC runtime, fluent actor builder, universal context or generic job/workflow engine.
6. Consolidate lifecycle ownership inside the existing turn, activation, delivery, workflow and connection boundaries. Keep generation fencing, transaction order, backend capabilities, receipt replay, lease/epoch settlement and polling recovery explicit. Native Effect primitives replace coordination only when they remove state and preserve these contracts.
7. Prefer small integration/E2E scenarios through real public interfaces and storage. Preserve narrow type, algebraic, protocol and packaging evidence that end-to-end execution cannot prove. Retire shape assertions and duplicated fixtures before deleting behavioral coverage; a retired behavioral test identifies the surviving test that rejects the same plausible mistake. Cancellation and provider skips remain honest. Test counts and coverage quotas are not success criteria.
8. Keep one authoritative export/boundary checker and formatter-owned spacing. Permit compact actor modules when responsibilities remain clear. Retire duplicate approximate rules, forced size-driven splits and unused reservations, while preserving real dependency, export, StyleX and no-comment contracts. The existing CLI remains a working local development/inspection/repair tool; this cleanup does not implement hosted login/deploy. Documentation examples must still typecheck, and scaffold versions/schemas derive from their actual owners rather than copied facts.

## Alternatives

- Preserve all old names and add aliases: rejected for an unreleased alpha because two spellings and compatibility state increase maintenance.
- Replace the framework with RpcGroup, a pure return-object DSL or a universal interpreter: rejected because these do not own the existing actor transaction, receipt, workflow and realtime guarantees.
- Keep only E2E tests: rejected because runtime execution cannot establish negative type/capability, algebraic or package-export contracts, and a single provider cannot prove another provider's behavior.
- Set a tenfold deletion quota: rejected because it rewards removing guarantees or moving complexity. Measure removed concepts, duplicate facts and support code while retaining discriminating evidence.
- Adopt every proposed native replacement: rejected. Queue, Socket, SSE and typed-builder spikes must demonstrate equivalent behavior and lower coordination cost.

## Consequences

All consumers, examples, templates and current documentation migrate together. Accepted older ADRs remain historical records, with this decision resolving the convention conflict. Durable data still commits under one fenced transaction, external work remains at least once, and volatile notifications remain best effort. Isolated worker branches may be temporarily incompatible until integrated; they are not independently shippable products.

The coordinator owns shared runtime assembly and the final consistency check. Each candidate closes with an implementation or a concrete evidence-backed rejection, not a generic deferral. The plan's execution ledger records measurements, test retirements, verification commands and delivery state.

## Evidence

The original probes and source census are recorded in [plan.md](../../plan.md). Implementation evidence is pending. Completion requires the exact integrated tree to pass root checks, real Postgres concurrency/fencing/recovery and replica cases, PGlite support cases, browser/React/offline E2E, and packed/scaffold consumer checks. The final PR needs trusted current-SHA CI and its evidence artifact before merge; remote `main` must contain the delivered result.

No Neki or external-provider support is established without provider-specific execution. No release, deployment, production database write or infrastructure change is authorized by this decision.

## Revisit when

- A native replacement increases modes/state or loses a documented lifetime/identity guarantee.
- Measurements show a material regression in the two-round-trip pipelined turn path or browser contract boundary.
- A later published release requires an explicit compatibility or stored-data migration policy.
