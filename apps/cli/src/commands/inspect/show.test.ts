import { Actor, Actors } from "@durable-actors/core"
import { OperatorAuth, Operators } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { recordingFetch, runCli, runCliWith } from "../../testing.ts"

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const Post = Actor.command("Post", { input: Schema.String, output: Schema.Int })

const Room = Actor.make("CliRoom", {
  key: Schema.String,
  state: Actor.state({
    messages: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  api: { Post },
})

const live = Room.toLayer(
  Effect.succeed({
    Post: Effect.fnUntraced(function* (text: string) {
      const turn = yield* Room.Turn
      yield* turn.state.set({ messages: [...turn.state.messages, text] })

      return turn.state.messages.length
    }),
  }),
).pipe(Layer.provideMerge(ActorTest.layer()), Layer.provideMerge(BunCrypto.layer))

const operators = OperatorAuth.tokens([
  {
    token: Redacted.make("look-token"),
    grant: { operator: "support", capabilities: [{ action: "inspect", tenant: "*" }] },
  },
  {
    token: Redacted.make("read-token"),
    grant: {
      operator: "auditor",
      capabilities: [
        { action: "inspect", tenant: "*" },
        { action: "receipts.read", tenant: "*", actorType: "CliRoom" },
      ],
    },
  },
])

describe("durable inspect and durable receipts show", () => {
  it("parses an actor name, tenant, and receipt count", () =>
    Effect.gen(function* () {
      const runner = recordingFetch({})

      yield* runCliWith({ fetch: runner.fetch })([
        "inspect",
        "Room/r/1",
        "--url",
        "http://x",
        "--tenant",
        "t",
        "--receipts",
        "5",
      ])
      yield* runCliWith({
        fetch: runner.fetch,
      })(["inspect", "Room/r1", "--url", "http://x", "--tenant", "t"])

      expect(runner.requests.map(({ url }) => url)).toEqual([
        "http://x/operator/actors/Room/r%2F1?tenant=t&limit=5",
        "http://x/operator/actors/Room/r1?tenant=t&limit=20",
      ])

      for (const [args, reason, message] of [
        [
          ["inspect", "Room", "--url", "u", "--tenant", "t"],
          "InvalidValue",
          'Invalid value for argument <actor>: "Room"',
        ],
        [["inspect", "Room/r1", "--url", "u"], "MissingOption", "Missing required flag: --tenant"],
        [
          ["inspect", "Room/r1", "--url", "u", "--tenant", "t", "--receipts", "0"],
          "InvalidValue",
          'Invalid value for flag --receipts: "0". Expected: an integer from 1 to 1000',
        ],
        [
          ["receipts", "show", "Room/r1", "--url", "u", "--tenant", "t"],
          "MissingArgument",
          "Missing required argument: commandId",
        ],
      ] as const) {
        const refused = yield* runCli([...args])

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(message)
      }
    }).pipe(Effect.runPromise))

  it("prints an actor's state and receipts, with outcomes only under receipts.read", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(live)
      const tenant = Context.get(context, ActorTest).tenant

      const commandId = yield* Effect.gen(function* () {
        const room = yield* Room.get("r1")
        yield* room.Post("hello")
        const id = yield* (yield* Actors).mintCommandId
        yield* room.Post("again").pipe(Actor.commandId(id))

        return id
      }).pipe(Effect.provideContext(context))

      const web = HttpRouter.toWebHandler(
        Operators.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const fetch = ((input, init) =>
        web.handler(new Request(input, init))) as typeof globalThis.fetch

      const cli = (args: ReadonlyArray<string>, token: string) =>
        runCliWith({
          fetch,
          env: { DURABLE_OPERATOR_TOKEN: token },
        })([...args, "--url", "http://runner", "--tenant", tenant])

      const looked = (yield* cli(["inspect", "CliRoom/r1"], "look-token")).stdout.split("\n")

      expect(looked[0]).toBe("CliRoom/r1  generation 1  events through 0")
      expect(looked).toContain('  messages = ["hello","again"]')
      expect(
        looked.some((line) =>
          line.includes(`Post ${commandId}  Success  (outcome needs receipts.read)`),
        ),
      ).toBe(true)

      const read = (yield* cli(["inspect", "CliRoom/r1"], "read-token")).stdout

      expect(read).toContain(
        `Post ${commandId}  Success  {"_tag":"Success","value":"{\\"value\\":2}"}`,
      )

      const shown = yield* cli(["receipts", "show", "CliRoom/r1", commandId], "read-token")

      expect(shown).toMatchObject({ exitCode: 0, reason: "" })
      expect(yield* decodeJson(shown.stdout)).toMatchObject({
        commandId,
        command: "Post",
        outcomeTag: "Success",
      })

      const refused = yield* cli(["receipts", "show", "CliRoom/r1", commandId], "look-token")

      expect(refused).toMatchObject({ exitCode: 1, reason: "OperatorRefused" })
      expect(refused.stderr).toMatch(/^Refused \(403\): /)
    }).pipe(Effect.scoped, Effect.runPromise))
})
