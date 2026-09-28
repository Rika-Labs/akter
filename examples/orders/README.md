# Orders

The flagship example: orders placed inside an app that already has its own Postgres tables. An `Order` actor owns its order lines, charges the customer through an effect with a provider idempotency key, and mints one `Shipment` actor per package. A crash drill kills the runner at every fault point an order passes through and shows that no acknowledged order is lost and no payment is taken twice.

```sh
DATABASE_URL=postgres://project:project@localhost:5432/project bun run --cwd examples/orders start
bun run --cwd examples/orders test              # PGlite
TEST_DATABASE_URL=… bun run --cwd examples/orders test:integration   # Postgres, including the crash drill
```

`src/main.ts` lists `curl` calls for every route. The bearer token is the customer id (`ada` or `grace`), a stand-in for a real identity provider.

## The pieces

| Piece                   | File                                                                                   | What it is                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `customers`, `products` | [`catalog/schema.ts`](src/catalog/schema.ts)                                           | The app's own tables and its own Drizzle client. No actor owns them.                                                    |
| `quote`                 | [`catalog/repository.ts`](src/catalog/repository.ts)                                   | Reads the customer and the products outside any turn and returns `Place`'s input.                                       |
| `Order`                 | [`order/contract.ts`](src/order/contract.ts), [`layer.ts`](src/order/layer.ts)         | Owns `order_lines`. `Place` writes the lines, emits `OrderPlaced`, mints the shipments, and performs `Charge`.          |
| `Charge` executor       | [`order/effects.ts`](src/order/effects.ts)                                             | Calls the payment provider with the effect id as the idempotency key. No database access.                               |
| `Shipment`              | [`shipment/contract.ts`](src/shipment/contract.ts)                                     | One per package, minted by `Place`. `Open` creates it; `Release` and `Cancel` follow the payment.                       |
| Sales report            | [`reports/sales.ts`](src/reports/sales.ts)                                             | Plain SQL over `order_lines` across every order, outside any turn.                                                      |
| Routes                  | [`server.ts`](src/server.ts)                                                           | `POST /orders/:id`, `GET /orders/:id`, `GET /reports/sales`, and `Actor.serve` for `Shipment` plus `POST /command-ids`. |
| Fake provider           | [`payments/ledger.ts`](src/payments/ledger.ts)                                         | Applies at most one charge per idempotency key and counts every call.                                                   |
| Crash drill             | [`drill/runner.test.ts`](src/drill/runner.test.ts), [`runner.ts`](src/drill/runner.ts) | Kills a real runner process with SIGKILL at each fault point and recovers on a new one.                                 |

## One order

```text
client                 route (app code)              Order turn (one transaction)           after COMMIT
──────                 ────────────────              ────────────────────────────           ────────────
POST /command-ids ───► commandId
POST /orders/o-1  ───► read customers, products
  Idempotency-Key      with the app's Drizzle
                       client (not in the turn)
                       Place(input) under key ──────► insert order_lines
                                                      mint Shipment × packages
                                                      stage Open intent per shipment
                                                      emit OrderPlaced
                                                      perform Charge
                                                      state = awaiting_payment
                                                      receipt ─── COMMIT ─────────────────► relay: Open → each Shipment
                  ◄─── 200 { total, shipments } ◄─────                                      executor: Charge(effectId)
                                                                                              └► provider (key = effectId)
                                                                                            relay: Charged → Order
                                                                                              state = paid, PaymentCaptured
                                                                                              Release → each Shipment
```

## Where each guarantee comes from

**The order is placed once, however often the client retries.** The client gets a command id from `POST /command-ids` and sends it as `Idempotency-Key` on every attempt. `Place` runs under that id: its receipt commits in the same transaction as its lines, event, intents, and effect, and a retry with the same id replays the receipt instead of running the handler ([contract 04](../../docs/contracts/04-receipts.md), invariant R1). A retry with the same id but different input is `CommandConflict` (R2); the route answers 409.

**A crash before COMMIT leaves nothing behind; a crash after it loses nothing.** Everything `Place` does is one framework-owned transaction ([contract 03](../../docs/contracts/03-transactions.md), T1). Killed before COMMIT, Postgres rolls it back: no lines, no event, no shipment intents, no charge, and the client's retry runs the command once ([contract 02](../../docs/contracts/02-command-turns.md), M3). Killed after COMMIT but before the reply, the receipt is durable, so the retry replays it (R1).

**The catalog read is not in the turn's snapshot.** The route reads `customers` and `products` with the app's Drizzle client on its own pooled connection, before the turn starts, and passes the values as `Place` input. Actor queries and turns may read only their own owned tables ([Drizzle API](../../docs/api/04-drizzle.md)). The turn trusts its input, which is why `Order` is not served through `Actor.serve`: only the app's route, which computed the prices, calls `Place`. A price change between an attempt and its retry makes the retry's input differ, so it is a conflict, never a second order at a different price.

**Each package gets exactly one shipment.** `turn.mint(Shipment)` derives each shipment id from the tenant, the order, the command id, the call's position, and the child type, so a rerun of the same command mints the same ids ([ADR 0025](../../docs/decisions/0025-turn-mint.md), A5). A shipment comes into being only when the relay delivers the creating `Open` intent committed with `Place`; a redelivered intent is deduplicated by the shipment's receipt ([contract 05](../../docs/contracts/05-messaging.md), M1 and M2).

**The customer is charged at most once.** `Charge` runs after COMMIT, outside any transaction, and may run more than once: a runner can die after the provider answered and before the result was recorded, and the next attempt runs again ([contract 08](../../docs/contracts/08-background-work.md)). The executor passes its effect id as the provider's idempotency key, so the provider applies one charge per key. The framework routes only the first recorded result to `Charged`, whose receipt keeps it to one turn. A decline (`402`) is a typed failure: nothing was charged, so after the last retry `ChargeFailed` cancels the shipments. A transport failure is a defect, because the provider may have applied the charge; if it outlasts the retries, the order becomes `payment_unknown` and its shipments stay pending for an operator (P1).

**The report is application SQL.** [`reports/sales.ts`](src/reports/sales.ts) groups `order_lines` across every order of a tenant with plain SQL, outside any turn. It filters on `tenant_id` itself, reads committed rows, and takes no actor's lock, so it can lag an order that commits while it runs. It is not an actor query: those read only their own actor's rows, and fleet-wide reads wait for `Fleet.view` (M6.3).

## The crash drill

[`drill/runner.test.ts`](src/drill/runner.test.ts) runs on Postgres in `test:integration`. For each fault point it starts a fresh database, a fake provider that outlives every runner, and a runner process ([`drill/runner.ts`](src/drill/runner.ts)) that stops at the fault through `TurnHooks` from `@durable-actors/core/testing`. The drill places one order over HTTP, kills the runner with SIGKILL at the fault, starts a replacement, and retries under the same `Idempotency-Key`, as any client must.

| Fault point                  | Where it stops                                      | Acknowledged before the kill |
| ---------------------------- | --------------------------------------------------- | ---------------------------- |
| `beforeHandler:Place`        | the turn, before the handler runs                   | no                           |
| `beforeCommit:Place`         | the turn, after the handler, before COMMIT          | no                           |
| `afterCommit:Place`          | after COMMIT, before the reply                      | no                           |
| `afterClaim:Open`            | the relay, holding a shipment's creating intent     | yes                          |
| `beforeOutboxDelete:Open`    | the relay, after the shipment committed             | yes                          |
| `beforeExecute:Charge`       | the executor, before calling the provider           | yes                          |
| `afterExecute:Charge`        | the executor, after the provider applied the charge | yes                          |
| `afterClaim:Charged`         | the relay, holding the charge's result              | yes                          |
| `beforeOutboxDelete:Charged` | the relay, after `Charged` committed                | yes                          |

After each kill it waits for the order to be paid on the replacement and asserts: one `Place` receipt, all order lines, two shipments each opened and released once, one `Charged` and no `ChargeFailed`, an empty outbox, and exactly one applied charge in the provider's ledger for the order's total. The executor may run more than once, so the drill counts applied charges, not calls; at `afterExecute:Charge` the ledger sees two calls for the one key.
