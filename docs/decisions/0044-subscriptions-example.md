# ADR 0044: The billing example is `examples/subscriptions`

**Status:** proposed (2026-09-28).

**Responsibility:** decide where M3.6's billing example lives and what it may claim.

**Authority:** design decision record.

**Owner role:** API / SDK.

**Change policy:** supersede through a new ADR.

## Context

[M3.6](../milestones/M3.md) asks for a billing example with cron and a workflow beside the counter, chat, and coding-agent examples. [ADR 0001](0001-repository-structure.md) lists only `counter`, `chat`, and `coding-agent` under `examples/`, and [repository structure](../architecture/repository-structure.md) requires an ADR for a new workspace package. Workspace packages are named `@durable-actors/<directory>`, and `@durable-actors/billing` already belongs to `packages/billing`, the control plane's Polar integration.

## Decision

- **Place.** The example is the workspace package `examples/subscriptions`, named `@durable-actors/subscriptions`. It follows the other examples: one actor folder (`src/account/{contract,layer,authorize,gateway}.ts` with its test beside it), a runnable `src/main.ts`, and `test` / `test:integration` scripts that run the same cases on PGlite and on a fresh Postgres database.
- **Scope.** An `Account` actor owns its invoices as rows. Its first invoice is issued once a card reaches the provider, and `Renew` issues each later one; `policy.cron` drives `Renew` once M2.5 is on main. A `Collect` workflow charges an invoice, waits up to three days for a newer card after a decline, retries twice, and reports back through `Settle`. `authorize` refuses `Collect` and `Settle` to every external caller; the account starts collections through intents, and step calls to its commands skip `authorize`.
- **Provider.** The payment provider is an in-memory stand-in behind a `PaymentGateway` service. The example claims no provider behaviour: it shows where the idempotency keys go (the effect id for attaching a card, the execution id and step name for a charge) and counts calls per key in its tests.

## Alternatives

- **`examples/billing`.** Its package name would collide with `packages/billing`.
- **Billing inside `examples/counter` or `examples/chat`.** Mixes unrelated domains and hides the cron and workflow shape the slice asks for.

## Consequences

- `bun.lock` gains one workspace package; the repository-structure tree lists it.
- The example depends on M2.5 for its schedule. Until then, tests deliver `Renew` as a System caller through `ActorTest`.

## Evidence

`examples/subscriptions/src/account/layer.test.ts` on PGlite and Postgres; see the [conformance ledger](../verification/01-conformance.md).

## Revisit when

The control-plane billing package is renamed, or examples move out of the workspace.
