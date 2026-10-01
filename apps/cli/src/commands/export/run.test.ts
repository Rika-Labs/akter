import { Actor, Intent, User } from "@durable-actors/core"
import { OperatorAuth, Operators, SeedJson } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import { Context, Duration, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { recordingFetch, runCli, runCliWith } from "../../testing.ts"

const Note = Actor.command("Note", { payload: Schema.String })

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

const live = Vault.toLayer({
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
})

const runtime = (as: string) =>
  live.pipe(
    Layer.provideMerge(
      ActorTest.layer({ as: User.make({ subject: as }), authorize: () => Effect.succeed(true) }),
    ),
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
      const runner = recordingFetch({})

      const exported = yield* runCliWith({ fetch: runner.fetch })([
        "export",
        "Vault/v/1",
        "--url",
        "http://x",
        "--tenant",
        "t",
        "--output",
        "/nowhere/v.seed",
      ])

      expect(exported).toMatchObject({ exitCode: 2, reason: "SchemaError" })
      expect(exported.stderr).toContain("Unexpected answer")
      expect(runner.requests.map(({ url }) => url)).toEqual([
        "http://x/operator/actors/Vault/v%2F1/export?tenant=t",
      ])

      for (const [args, reason, message] of [
        [
          ["Vault", "--url", "u", "--tenant", "t", "--output", "f"],
          "InvalidValue",
          'Invalid value for argument <actor>: "Vault". Expected: an actor named as <Type>/<id>',
        ],
        [
          ["Vault/v1", "--url", "u", "--output", "f"],
          "MissingOption",
          "Missing required flag: --tenant",
        ],
        [
          ["Vault/v1", "--url", "u", "--tenant", "t"],
          "MissingOption",
          "Missing required flag: --output",
        ],
        [
          ["Vault/v1", "extra", "--url", "u", "--tenant", "t", "--output", "f"],
          "UnexpectedArgument",
          'Unexpected positional argument: "extra"',
        ],
      ] as const) {
        const refused = yield* runCli(["export", ...args])

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(message)
      }
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

      const fetch = ((input, init) =>
        web.handler(new Request(input, init))) as typeof globalThis.fetch

      const exportAs = (token: string) =>
        runCliWith({ fetch, env: { DURABLE_OPERATOR_TOKEN: token } })([
          "export",
          "CliVault/v1",
          "--url",
          "http://runner",
          "--tenant",
          tenant,
          "--output",
          output,
        ])

      const refused = yield* exportAs("look-token")

      expect(refused).toMatchObject({ exitCode: 1, reason: "OperatorRefused" })
      expect(refused.stderr).toMatch(/^Refused \(403\): /)
      expect(yield* fs.exists(output)).toBe(false)

      const answer = yield* exportAs("export-token")

      expect(answer).toEqual({
        stdout: [
          `Exported CliVault/v1 to ${output}`,
          "carries 1 state keys, 1 pending intents, 0 pending jobs",
          "omits 2 receipts, 0 events, 0 workflows, 0 dead letters, 0 owned-table rows, 0 blob entries",
          "",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        reason: "",
      })
      expect(((yield* fs.stat(output)).mode & 0o777).toString(8)).toBe("600")

      const written = yield* fs.readFileString(output)

      expect(written.includes(tenant)).toBe(false)
      expect(written.includes("alice")).toBe(false)

      const again = yield* exportAs("export-token")

      expect(again).toMatchObject({ exitCode: 2, reason: "PlatformError" })
      expect(again.stderr).toMatch(/^Cannot write the file: /)
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
      }).pipe(
        Effect.provideContext(replay),
        Effect.provideContext(yield* Layer.build(BunFileSystem.layer)),
      )
    }).pipe(Effect.scoped, Effect.runPromise))
})
