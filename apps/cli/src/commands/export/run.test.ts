import { Actor, Intent, User } from "@durable-actors/core"
import { OperatorAuth, Operators, SeedJson } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import { Context, Duration, Effect, Exit, FileSystem, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { exportSeed, formatExport, parseExport } from "./run.ts"

const Note = Actor.command("Note", { input: Schema.String })

const Remind = Actor.command("Remind")

const Vault = Actor.make("CliVault", {
  key: Schema.String,
  state: Actor.state({
    notes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    reminded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  api: { Note },
  internal: { Remind },
})

const live = Vault.toLayer(
  Effect.succeed({
    Note: Effect.fnUntraced(function* (text: string) {
      const turn = yield* Vault.Turn
      yield* turn.state.set({ notes: [...turn.state.notes, text] })

      yield* (yield* Vault.intents(turn.id))
        .Remind()
        .pipe(Intent.after("1 hour"), Intent.key("remind"))
    }),
    Remind: Effect.fnUntraced(function* () {
      const turn = yield* Vault.Turn
      yield* turn.state.set({ reminded: true })
    }),
  }),
)

const runtime = (as: string) =>
  live.pipe(
    Layer.provideMerge(ActorTest.layer({ as: User.make({ subject: as }) })),
    Layer.provideMerge(BunCrypto.layer),
  )

const operators = OperatorAuth.tokens([
  {
    token: Redacted.make("export-token"),
    grant: {
      operator: "support",
      capabilities: [{ action: "export", tenant: "*", actorType: "CliVault" }],
    },
  },
  {
    token: Redacted.make("look-token"),
    grant: {
      operator: "auditor",
      capabilities: [
        { action: "inspect", tenant: "*" },
        { action: "receipts.read", tenant: "*" },
      ],
    },
  },
])

describe("durable export", () => {
  it("parses an actor name, tenant, and output file, and needs all three", () =>
    Effect.gen(function* () {
      expect(
        yield* parseExport([
          "Vault/v/1",
          "--url",
          "http://x",
          "--tenant",
          "t",
          "--output",
          "v.seed",
        ]),
      ).toMatchObject({ actorType: "Vault", actorId: "v/1", tenant: "t", output: "v.seed" })

      for (const args of [
        ["Vault", "--url", "u", "--tenant", "t", "--output", "f"],
        ["Vault/v1", "--url", "u", "--output", "f"],
        ["Vault/v1", "--url", "u", "--tenant", "t"],
        ["Vault/v1", "extra", "--url", "u", "--tenant", "t", "--output", "f"],
      ])
        expect(Exit.isFailure(yield* parseExport(args).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.runPromise))

  it("writes an owner-only seed file, never replaces one, and starts an actor from it in another tenant", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(runtime("alice"))
      const tenant = Context.get(context, ActorTest).tenant
      const fs = Context.get(yield* Layer.build(BunFileSystem.layer), FileSystem.FileSystem)
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "durable-export-" })
      const output = `${directory}/v1.seed`

      yield* Effect.gen(function* () {
        const vault = yield* Vault.get("v1")
        yield* vault.Note("first")
        yield* vault.Note("second")
      }).pipe(Effect.provideContext(context))

      const web = HttpRouter.toWebHandler(
        Operators.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const fetcher = Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
        web.handler(new Request(input, init))) as typeof fetch)

      const services = yield* Layer.build(
        Layer.mergeAll(FetchHttpClient.layer.pipe(Layer.provide(fetcher)), BunFileSystem.layer),
      )

      const options = yield* parseExport([
        "CliVault/v1",
        "--url",
        "http://runner",
        "--tenant",
        tenant,
        "--output",
        output,
      ])

      const refused = yield* exportSeed({ options, token: "look-token" }).pipe(
        Effect.provideContext(services),
        Effect.flip,
      )

      expect(refused).toMatchObject({ status: 403 })
      expect(yield* fs.exists(output)).toBe(false)

      const answer = yield* exportSeed({ options, token: "export-token" }).pipe(
        Effect.provideContext(services),
      )

      expect((yield* formatExport(answer)).split("\n")).toEqual([
        `Exported CliVault/v1 to ${output}`,
        "carries 1 state keys, 1 pending intents, 0 pending effects",
        "omits 2 receipts, 0 events, 0 workflows, 0 dead letters",
      ])
      expect(((yield* fs.stat(output)).mode & 0o777).toString(8)).toBe("600")

      const written = yield* fs.readFileString(output)

      expect(written.includes(tenant)).toBe(false)
      expect(written.includes("alice")).toBe(false)

      const again = yield* exportSeed({ options, token: "export-token" }).pipe(
        Effect.provideContext(services),
        Effect.flip,
      )

      expect(again._tag).toBe("PlatformError")
      expect(yield* fs.readFileString(output)).toBe(written)
      expect(yield* Schema.decodeEffect(SeedJson)(written)).toMatchObject({
        actor: { type: "CliVault", id: "v1" },
        state: { notes: ["first", "second"] },
      })

      const replay = yield* Layer.build(runtime("bob"))

      yield* Effect.gen(function* () {
        const test = yield* ActorTest
        const seeded = yield* test.actor(Vault, "v1", { seed: output })

        expect(test.tenant === tenant).toBe(false)
        expect(yield* seeded.inspect).toMatchObject({
          state: { notes: ["first", "second"] },
          outbox: 1,
        })

        yield* test.advance(Duration.hours(2))

        expect((yield* seeded.inspect).state).toEqual({
          notes: ["first", "second"],
          reminded: true,
        })
      }).pipe(Effect.provideContext(replay), Effect.provideContext(services))
    }).pipe(Effect.scoped, Effect.runPromise))
})
