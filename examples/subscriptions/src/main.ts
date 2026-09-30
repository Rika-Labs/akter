/**
 * Subscription billing. Each account bills itself: the first invoice is issued once its card is
 * on file, and a `Collect` workflow charges it, waiting for a newer card after a decline. Uses
 * Postgres when DATABASE_URL is set, otherwise an in-memory PGlite, and a stand-in provider:
 *   bun run start
 */
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Config, Console, Effect, Layer, Option, Schedule } from "effect"
import { Account, AccountId } from "./account/contract.ts"
import { fakeGateway, ledger } from "./account/gateway.ts"
import { AccountLive } from "./account/layer.ts"

const DatabaseLive = Layer.unwrap(
  Effect.map(
    Config.option(Config.Redacted("DATABASE_URL")),
    Option.match({ onNone: () => Database.pglite(), onSome: (url) => Database.postgres({ url }) }),
  ),
)

const live = AccountLive.pipe(
  Layer.provide(fakeGateway(ledger())),
  Layer.provideMerge(Actors.layer()),
  Layer.provide(DatabaseLive),
  Layer.provide(BunCrypto.layer),
)

/** Polls an account's invoices until `done` holds. */
const invoicesUntil = (
  account: Effect.Success<ReturnType<typeof Account.get>>,
  done: (statuses: ReadonlyArray<string>) => boolean,
) =>
  account.Invoices().pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (rows) => done(rows.map(({ status }) => status)),
    }),
  )

/**
 * Bills two accounts: `acme` pays at once; `globex`'s card is declined, so its
 * collection waits until the customer adds a newer one.
 */
const program = Effect.gen(function* () {
  const acme = yield* Account.get(AccountId.make("acme"))
  yield* acme.Subscribe({ plan: "pro", card: "tok_visa" })
  yield* Console.log("acme", yield* invoicesUntil(acme, (s) => s.includes("paid")))

  const globex = yield* Account.get(AccountId.make("globex"))
  yield* globex.Subscribe({ plan: "basic", card: "tok_declined" })
  yield* Effect.sleep("1 second")
  yield* Console.log("globex before a new card", yield* globex.Invoices())
  yield* globex.UpdateCard("tok_visa")
  yield* Console.log("globex", yield* invoicesUntil(globex, (s) => s.includes("paid")))
})

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
