import { BunCrypto } from "@effect/platform-bun"
import { ActorError, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import {
  Config,
  Crypto,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { authorize } from "./authorize.ts"
import { Account, AccountId, Collect } from "./contract.ts"
import { fakeGateway, ledger } from "./gateway.ts"
import { AccountLive } from "./layer.ts"

const book = ledger()

// The same cases run on PGlite (`test`) and on a fresh Postgres database (`test:integration`).
const database = Effect.gen(function* () {
  if ((yield* Config.String("SUBSCRIPTIONS_BACKEND")) === "pglite") return undefined

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `subscriptions_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    return AccountLive.pipe(
      Layer.provide(fakeGateway(book)),
      Layer.provideMerge(
        ActorTest.layer({
          database: yield* database,
          as: User.make({ subject: "ada" }),
          authorize,
        }),
      ),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

/** Subscribes and waits until the provider holds the card. */
const subscribe = Effect.fnUntraced(function* (id: string, card: string) {
  const test = yield* ActorTest
  const account = yield* Account.get(AccountId.make(id))
  yield* account.Subscribe({ plan: "pro", card })
  yield* test.advance(0)

  return account
})

/** Issues the next invoice as the monthly cron tick would. */
const renew = Effect.fnUntraced(function* (id: string) {
  const test = yield* ActorTest

  return Option.getOrThrow(yield* (yield* test.actor(Account, id)).system.Renew())
})

/** Waits until the collection has parked on a durable wait. */
const suspended = Effect.fnUntraced(function* (executionId: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql<{ status: string }>`SELECT status FROM actor_workflow_executions
    WHERE execution_id = ${executionId}`.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("20 millis"),
      until: (rows) => rows[0]?.status === "suspended",
    }),
  )
})

/** Charge calls and applied charges for one collection. */
const charges = (executionId: string) => {
  const keys = [...book.calls.keys()].filter((key) => key.startsWith(`${executionId}:`))

  return {
    calls: keys.reduce((sum, key) => sum + (book.calls.get(key) ?? 0), 0),
    approved: keys.filter((key) => book.results.get(key)?._tag === "Approved").length,
  }
}

it("issues an invoice, charges it once, and settles it", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const account = yield* subscribe("a1", "tok_visa")
      const executionId = yield* renew("a1")

      expect(yield* (yield* Account.run(Collect, executionId)).result).toBe("paid")
      expect(yield* account.Invoices()).toEqual([
        { id: "a1-1", period: 1, amountCents: 2900, status: "paid", attempts: 1 },
      ])
      expect(yield* account.Summary()).toEqual({
        plan: "pro",
        status: "active",
        period: 1,
        cardVersion: 1,
      })
      expect(charges(executionId)).toEqual({ calls: 1, approved: 1 })
      expect(yield* test.inspect(account.ref)).toMatchObject({
        rows: { billing_invoices: 1 },
        events: 3,
      })
    }),
  ))

it("retries a declined charge as soon as the customer adds a newer card", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const account = yield* subscribe("a2", "tok_declined")
      const executionId = yield* renew("a2")

      // The first charge declined and the collection waits for a card or three days.
      yield* suspended(executionId)
      expect(charges(executionId)).toEqual({ calls: 1, approved: 0 })

      yield* account.UpdateCard("tok_visa")
      yield* test.advance(0)

      expect(yield* (yield* Account.run(Collect, executionId)).result).toBe("paid")
      expect((yield* account.Invoices())[0]).toMatchObject({ status: "paid", attempts: 2 })
      expect((yield* account.Summary()).status).toBe("active")
      expect(charges(executionId)).toEqual({ calls: 2, approved: 1 })
    }),
  ))

it("marks the account past due after the last retry declines", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const account = yield* subscribe("a3", "tok_declined")
      const executionId = yield* renew("a3")

      // Each declined charge parks the collection for three days before the next one.
      for (const declines of [1, 2]) {
        while (charges(executionId).calls < declines) yield* Effect.sleep("20 millis")
        yield* suspended(executionId)
        yield* test.advance("3 days")
      }

      expect(yield* (yield* Account.run(Collect, executionId)).result).toBe("failed")
      expect((yield* account.Invoices())[0]).toMatchObject({ status: "failed", attempts: 3 })
      expect((yield* account.Summary()).status).toBe("past_due")
      expect(charges(executionId)).toEqual({ calls: 3, approved: 0 })
    }),
  ))

it("issues one invoice when a renewal is redelivered after its turn committed", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const account = yield* subscribe("a4", "tok_visa")

      // The tick's turn commits, then the runner dies before replying; the retry replays the receipt.
      yield* test.crashNext("afterCommit")
      const executionId = yield* renew("a4")

      expect(yield* (yield* Account.run(Collect, executionId)).result).toBe("paid")
      expect(yield* test.receiptsFor(account.ref, "Renew")).toBe(1)
      expect(yield* account.Invoices()).toHaveLength(1)
      expect(charges(executionId)).toEqual({ calls: 1, approved: 1 })
    }),
  ))

it("skips renewal for a cancelled account", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const account = yield* subscribe("a5", "tok_visa")
      yield* account.Cancel()

      expect(yield* (yield* test.actor(Account, "a5")).system.Renew()).toEqual(Option.none())
      expect(yield* account.Invoices()).toEqual([])
    }),
  ))

it("refuses a settlement from anyone but the account's own workflow", () =>
  run(
    Effect.gen(function* () {
      const account = yield* subscribe("a6", "tok_visa")
      const executionId = yield* renew("a6")
      yield* (yield* Account.run(Collect, executionId)).result

      // A user holding the account's handle still cannot settle its invoice.
      const forged = yield* account
        .Settle({ invoiceId: "a6-1", paid: false, attempts: 1 })
        .pipe(Effect.flip)
      expect(Schema.is(ActorError)(forged) && forged.reason._tag).toBe("Unauthorized")
      expect((yield* account.Invoices())[0]).toMatchObject({ status: "paid" })
    }),
  ))
