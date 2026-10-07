import { BunCrypto } from "@effect/platform-bun"
import { Context, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { Actor } from "../index.ts"
import { Actors, App, AppLayerFailed, checkWorkflows, Database } from "./index.ts"

class Mailer extends Context.Service<Mailer, { readonly sent: () => number }>()(
  "@rikalabs/akter/runtime/app.test/Mailer",
) {}

const Send = Actor.command("Send", { success: Schema.Int })

const Count = Actor.command("Count", { success: Schema.Int })

const Outbox = Actor.make("AppOutbox", { key: Schema.String, api: { Send } })

const Ledger = Actor.make("AppLedger", { key: Schema.String, api: { Count } })

const OutboxLive = Outbox.toLayer(
  Effect.gen(function* () {
    const mailer = yield* Mailer

    return { Send: () => Effect.succeed(mailer.sent()) }
  }),
)

const LedgerLive = Ledger.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      Count: () =>
        sql<{ two: number }>`SELECT 1 + 1 AS two`.pipe(
          Effect.map((rows) => rows[0]!.two),
          Effect.orDie,
        ),
    }
  }),
)

const MailerLive = Layer.succeed(Mailer, Mailer.of({ sent: () => 7 }))

/** How a host provides a loaded app: its layer over `Actors.layer`, an embedded database and Crypto. */
const host = (app: App) =>
  app.layer.pipe(
    Layer.provideMerge(Actors.layer()),
    Layer.provideMerge(Database.pglite()),
    Layer.provideMerge(BunCrypto.layer),
  )

describe("App", () => {
  it("rejects a layer whose handlers need a service the host does not provide, and accepts it once the app provides it", () => {
    const missing = App.make({
      actors: [Outbox],
      // @ts-expect-error Outbox's handlers need Mailer, which no host provides
      layer: OutboxLive,
    })

    const provided = App.make({
      actors: [Outbox, Ledger],
      layer: Layer.mergeAll(OutboxLive, LedgerLive).pipe(Layer.provide(MailerLive)),
    })

    expect([missing, provided]).toHaveLength(2)
  })

  it("recognizes only a branded app whose actors have a name and an api, with a layer", () => {
    const app = App.make({ actors: [Ledger], layer: LedgerLive })

    expect(App.is(app)).toBe(true)
    expect(App.is({ actors: [Ledger], layer: LedgerLive })).toBe(false)
    expect(App.is({ ...app, layer: {} })).toBe(false)
    expect(App.is({ ...app, actors: [{ name: 1, api: {} }] })).toBe(false)
    expect(App.is({ ...app, actors: [{ name: "AppLedger" }] })).toBe(false)
    expect(App.is({ ...app, actors: [{ name: "AppLedger", api: "Count" }] })).toBe(false)
    expect(App.is({ ...app, actors: Ledger })).toBe(false)
    expect(App.is(undefined)).toBe(false)
  })

  it("runs a loaded app's handlers on a runtime the host builds from Actors.layer, a database and Crypto", () => {
    const loaded: unknown = App.make({
      actors: [Outbox, Ledger],
      layer: Layer.mergeAll(OutboxLive, LedgerLive).pipe(Layer.provide(MailerLive)),
    })

    if (!App.is(loaded)) throw new Error("App.make built a value App.is refuses")

    expect(loaded.actors.map((actor) => actor.name)).toEqual(["AppOutbox", "AppLedger"])

    const runtime = ManagedRuntime.make(host(loaded))

    return runtime
      .runPromise(
        Effect.gen(function* () {
          expect(yield* checkWorkflows(loaded.actors)).toEqual([])

          const outbox = yield* Outbox.get("a")
          const ledger = yield* Ledger.get("b")

          return [yield* outbox.Send(), yield* ledger.Count()]
        }),
      )
      .then((results) => expect(results).toEqual([7, 2]))
      .finally(() => runtime.dispose())
  })

  it("fails a layer that cannot be built with AppLayerFailed carrying its cause", () => {
    const refused = new Error("no mail server")
    const app = App.make({
      actors: [Outbox],
      layer: OutboxLive.pipe(Layer.provide(Layer.effect(Mailer, Effect.fail(refused)))),
    })

    const runtime = ManagedRuntime.make(host(app))

    return runtime
      .runPromiseExit(Effect.void)
      .then((exit) => expect(exit).toEqual(Exit.fail(AppLayerFailed.make({ cause: refused }))))
      .finally(() => runtime.dispose())
  })
})
