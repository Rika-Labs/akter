# ADR 0059: Caller and tenant defaults: a trusted process caller and per-actor access

**Status:** accepted (2026-09-30, decided by Dallen). It amends [contract 10](../contracts/10-security.md), [ADR 0007](0007-foundation-command-protocol.md) (`Actors.layer` requires an authorization function), [ADR 0013](0013-m0-reconciliation.md) (the ambient caller and tenant), [ADR 0023](0023-connections-parking-and-streams.md) section 8 (the `authorize` hook) and [ADR 0027](0027-served-protocol.md) (its `authorize` `kind` table under Amendments). It supersedes nothing else: [ADR 0004](0004-receipt-access-revocation-and-expiry.md)'s revocation rules and the per-request caller resolution of ADR 0027 stand unchanged.

**Responsibility:** decide who a call is attributed to and which tenant it runs in when application code names neither, and where authorization decisions live.

**Authority:** design decision record.

**Owner role:** security/runtime.

**Change policy:** supersede through a new ADR.

## Context

Until now the ambient caller defaulted to `Anonymous`, and `Actors.layer` required an `authorize` function. Both defaults pushed the wrong work onto ordinary code:

- **Ordinary code had to name a caller.** A program that starts a runtime and calls `counter.Increment(1)` acts as no one. Every quickstart, template, example, and test that did this either passed an `authorize` that allowed everything, wrapped its calls in `Actor.as`, or both, only to get past the defaults. The [counter quickstart](../quickstart.md) opened with an authorization callback the reader could not yet have a reason to write.
- **Authorization was one global function.** Rules about one actor type sat in a callback that switched on `request.ref.actor` and `request.command`, far from the actor it protected.
- **`Anonymous` meant two things.** It was the identity of an unauthenticated visitor to a public `Actor.serve` endpoint, and it was the identity of the application's own code.

The transport already knows who the caller is. `Actor.serve` resolves a caller and a tenant for every request, and turns, crons, workflows, effect routes, and subscriptions already carry `System` attribution with `onBehalfOf`. Only code running in the application's own process was left without a truthful identity.

## Decision

The rule: **the transport decides who the caller is and which tenant; actors decide what is allowed; ordinary code names neither.**

1. **In-process calls default to a trusted `System` caller.** Code that runs in the application's own process, outside a turn and not through `Actor.serve`, runs as `System({ source: "process" })` in tenant `"default"`. `"process"` joins the `System` source literals (`actor`, `timer`, `cron`, `workflow`, `effect`, `subscription`). `CurrentCaller` defaults to that caller instead of `Anonymous`, and `Tenant` keeps its `"default"` default. Calls from inside turns, crons, workflows, effects, and subscriptions keep the `System` attribution they had, `onBehalfOf` included. An auth provider still cannot produce a `System` caller, so `process` never arrives from a request.
2. **`Actors.layer()` takes no required options.** `authorize` is optional and stays the global cross-cutting hook, for rules that span actor types (revoked principals, tenant suspension, audit).
3. **A per-actor `access` policy on `Actor.make`.** `access: ({ caller, ref, command, kind, of }) => boolean | Effect<boolean>` has the request shape and the `kind` values of `authorize`: `command`, `query`, `open`, `stream`, `feed`, `reauthorize`, and `content`, with `of` set on `reauthorize` to `open`, `stream`, or `feed`. It is asked for every external request to that actor type, in the same places `authorize` is asked. When both exist, the global `authorize` and the actor's `access` must both allow. Either alone decides when the other is absent.
4. **Secure defaults.** With no `access` and no `authorize`, `System` callers are allowed, and `User` and `Anonymous` callers are denied with `Unauthorized` code `access_denied`. Those two only arrive through `Actor.serve` or the client, so a served actor with no policy answers `403` to everyone until it declares one. An actor whose `access` (or a runtime whose `authorize`) exists decides for every caller it is asked about, `System` included, because the policy replaces the default rather than adding to it. [Contract 10](../contracts/10-security.md) records this, and a conformance case covers it. The existing rules stand: internal commands are `System`-only and a non-`System` attempt is a deterministic defect that no `access` policy can turn into a success, public actor capabilities do not expose internal execution, HTTP callers resolve per request, and revocation blocks admission without cancelling accepted work. Intent deliveries from inside turns keep skipping external admission, so `access` is never asked about a committed obligation.
5. **`Actor.tenant` and `Actor.as` stay, as opt-in.** They are for trusted code that acts on behalf of a tenant or a user, such as a job that processes one customer. Ordinary code does not need them. `Actor.serve`'s auth providers (`jwt`, `assertion`, `make`, `none`) are unchanged: each produces `{ caller, tenant }`. `Actor.auth.none` produces `Anonymous` callers, who are denied unless the actor's `access` allows them, so a public actor says so on the actor: `access: () => true`, or a check of `caller._tag`.
6. **`Actor.access.public` for demos.** Dallen chose to keep deny-by-default and add one ready-made policy, `Actor.access.public`, which allows every caller and kind. It is a one-line opt-in for demos and deliberately public actors, and its documentation warns that it opens the actor to anyone who can reach the server.
7. **No compatibility shims.** Nothing is released. Every call site changes directly: `ActorTest` no longer supplies an allow-all `authorize` or an `Anonymous` ambient caller, and examples, templates, and tests that passed `authorize`, `Actor.as`, or `Actor.tenant` only to get past the old defaults drop them. Those that test real authorization keep them.

## Alternatives

- **Keep `Anonymous` as the default and a required `authorize`.** Rejected: it makes every first program name a caller and write a policy, and it lets `Anonymous` mean both "no credentials" and "our own code".
- **Default to allow everything when no policy exists.** Rejected: a served actor that forgot its policy would be public. Denying `User` and `Anonymous` by default costs a served actor one line and keeps the mistake closed.
- **Make in-process code a `User`, such as an application principal.** Rejected: it invents a subject that no credential proves, and `principal` would then name someone who does not exist. `System` says exactly what it is.
- **Per-actor policy only, no global `authorize`.** Rejected: revocation, tenant suspension, and audit apply to every actor and belong in one place.
- **Let `access` replace `authorize` for an actor.** Rejected: a global rule such as a revoked principal must not be bypassable by a permissive actor policy.

## Consequences

- The counter quickstart is `const counter = yield* Counter.get("visits"); yield* counter.Increment(1)` with `Actors.layer()`.
- A served actor needs an `access` policy, or a global `authorize`, before any `User` or `Anonymous` request succeeds. Applications that served actors under `Actor.auth.none` with a global allow-all now declare `access` on the public actors.
- Receipts written by in-process code carry `System({ source: "process" })` as their logical caller. A command id retried by another in-process caller reaches the same receipt, and one retried under `Actor.as(User)` does not.
- `access` runs on every external admission and on every live-session recheck, like `authorize`. It should be quick and avoid calling other actors.
- `ActorTest.layer` runs with the runtime's real defaults, so a test that passes `as: User` without `access` or `authorize` sees `access_denied`.
- An HTTP route the application mounts itself, beside `Actor.serve` rather than through it, is code in the application's own process: handles it acquires call as the trusted `System({ source: "process" })` in tenant `"default"`, which `access` and `authorize` may allow everything. Such a route must authenticate its request itself and acquire handles inside `Actor.as(caller)` and `Actor.tenant(tenant)` built from the verified credential, never from request content, or serve the actor through `Actor.serve` instead.

## Evidence

The `access` conformance group, on PGlite and real Postgres:

- `runs in-process code as System({ source: process }) in the default tenant, with no authorize and no Actor.as or Actor.tenant`;
- `allows System callers and denies User and Anonymous callers of every kind when there is no access and no authorize`;
- `asks an actor's access policy for each kind: command, query, open, stream, feed, and content each allow and deny on their own`;
- `requires the global authorize and the actor's access to both allow, and lets either alone decide when the other is absent`;
- `applies an actor's access policy to live sessions on reauthorize: a revoked connection, stream, and feed each end with access_denied`;
- `answers a served request from a User or Anonymous caller with 403 access_denied by default, and lets an actor's access, or Actor.access.public, allow them`;
- `sees Anonymous, never System, on every served entry point under Actor.auth.none, and denies it by default`;
- `keeps internal commands System-only and off public handles when an actor's access allows everyone`.

## Revisit when

- An application needs a policy that depends on the target actor's state, which `access` cannot read without a turn.
- Operators or the hosted edge need `System` callers that differ per process, so `process` needs a name.
