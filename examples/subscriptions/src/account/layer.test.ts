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
import { Account, AccountId } from "./contract.ts"
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

/** Subscribes; the first invoice is issued once the provider holds the card. */
const subscribe = Effect.fnUntraced(function* (id: string, card: string) {
  const account = yield* Account.get(AccountId.make(id))
  yield* account.Subscribe({ plan: "pro", card })
  yield* (yield* ActorTest).advance(0)

  return account
})

/** Issues the next invoice as the monthly cron tick would. */
const renew = Effect.fnUntraced(function* (id: string) {
  yield* (yield* (yield* ActorTest).actor(Account, id)).system.Renew()
})

/** The execution collecting an invoice, and its status. */
const collection = Effect.fnUntraced(function* (invoiceId: string) {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{ execution_id: string; status: string }>`
    SELECT execution_id, status FROM actor_workflow_executions WHERE workflow_key = ${invoiceId}`

  return rows[0]
})

const poll = <A, E, R>(effect: Effect.Effect<A, E, R>, until: (value: A) => boolean) =>
  effect.pipe(Effect.repeat({ schedule: Schedule.spaced("20 millis"), until }))

/** Waits until the collection has parked on a durable wait. */
const suspended = (invoiceId: string) =>
  poll(collection(invoiceId), (row) => row?.status === "suspended")

/** Waits until an invoice is paid or failed, and returns it. */
const settled = Effect.fnUntraced(function* (id: string, period: number) {
  const account = yield* Account.get(AccountId.make(id))

  const invoices = yield* poll(account.Invoices(), (rows) =>
    rows.some((row) => row.period === period && row.status !== "open"),
  )

  return invoices.find((row) => row.period === period)!
})

/** Charge calls and approved charges for one invoice's collection. */
const charges = Effect.fnUntraced(function* (invoiceId: string) {
  const { execution_id } = (yield* collection(invoiceId))!
  const keys = [...book.calls.keys()].filter((key) => key.startsWith(`${execution_id}:`))

  return {
    calls: keys.reduce((sum, key) => sum + (book.calls.get(key) ?? 0), 0),
    approved: keys.filter((key) => book.results.get(key)?._tag === "Approved").length,
  }
})

it("issues the first invoice once the card is on file, charges it once, and settles it", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const account = yield* subscribe("a1", "tok_visa")

      expect(yield* settled("a1", 1)).toEqual({
        id: "a1-1",
        period: 1,
        amountCents: 2900,
        status: "paid",
        attempts: 1,
      })
      expect(yield* account.Summary()).toEqual({
        plan: "pro",
        status: "active",
        period: 1,
        cardVersion: 1,
      })
      expect(yield* charges("a1-1")).toEqual({ calls: 1, approved: 1 })
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

      // The first charge declined and the collection waits for a card or three days.
      yield* suspended("a2-1")
      expect(yield* charges("a2-1")).toEqual({ calls: 1, approved: 0 })

      yield* account.UpdateCard("tok_visa")
      yield* test.advance(0)

      expect(yield* settled("a2", 1)).toMatchObject({ status: "paid", attempts: 2 })
      expect((yield* account.Summary()).status).toBe("active")
      expect(yield* charges("a2-1")).toEqual({ calls: 2, approved: 1 })
    }),
  ))

it("marks the account past due after the last retry declines", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const account = yield* subscribe("a3", "tok_declined")

      // Each declined charge parks the collection for three days before the next one.
      for (const declines of [1, 2]) {
        yield* poll(charges("a3-1"), ({ calls }) => calls >= declines)
        yield* suspended("a3-1")
        yield* test.advance("3 days")
      }

      expect(yield* settled("a3", 1)).toMatchObject({ status: "failed", attempts: 3 })
      expect((yield* account.Summary()).status).toBe("past_due")
      expect(yield* charges("a3-1")).toEqual({ calls: 3, approved: 0 })
    }),
  ))

it("issues one invoice when a renewal is redelivered after its turn committed", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const account = yield* subscribe("a4", "tok_visa")
      yield* settled("a4", 1)

      // The tick's turn commits, then the runner dies before replying; the retry replays the receipt.
      yield* test.crashNext("afterCommit")
      yield* renew("a4")

      expect(yield* settled("a4", 2)).toMatchObject({ id: "a4-2", status: "paid", attempts: 1 })
      expect(yield* test.receiptsFor(account.ref, "Renew")).toBe(1)
      expect(yield* account.Invoices()).toHaveLength(2)
      expect(yield* charges("a4-2")).toEqual({ calls: 1, approved: 1 })
    }),
  ))

it("skips renewal for a cancelled account", () =>
  run(
    Effect.gen(function* () {
      const account = yield* subscribe("a5", "tok_visa")
      yield* settled("a5", 1)
      yield* account.Cancel()
      yield* renew("a5")

      expect(yield* account.Invoices()).toHaveLength(1)
      expect((yield* account.Summary()).status).toBe("cancelled")
    }),
  ))

it("refuses collections and settlements from anyone but the account itself", () =>
  run(
    Effect.gen(function* () {
      const account = yield* subscribe("a6", "tok_visa")
      yield* settled("a6", 1)

      // A user holding the account's handle can neither charge it nor settle its invoice.
      for (const forged of [
        yield* account.Collect({ invoiceId: "a6-9", amountCents: 1 }).pipe(Effect.flip),
        yield* account.Settle({ invoiceId: "a6-1", paid: false, attempts: 1 }).pipe(Effect.flip),
      ])
        expect(Schema.is(ActorError)(forged) && forged.reason._tag).toBe("Unauthorized")

      expect(yield* account.Invoices()).toMatchObject([{ id: "a6-1", status: "paid" }])
    }),
  ))
