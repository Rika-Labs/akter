import { Actor, Actors, User } from "@durable-actors/core"
import { OperatorAuth, Operators } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { UsageError } from "../workflows/check.ts"
import { parseShow, showReceipt } from "../receipts/show.ts"
import { formatInspection, inspect, parseInspect } from "./show.ts"

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
).pipe(
  Layer.provideMerge(ActorTest.layer({ as: User.make({ subject: "alice" }) })),
  Layer.provideMerge(BunCrypto.layer),
)

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
      expect(
        yield* parseInspect(["Room/r/1", "--url", "http://x", "--tenant", "t", "--receipts", "5"]),
      ).toMatchObject({ actorType: "Room", actorId: "r/1", tenant: "t", limit: 5 })

      for (const [args, message] of [
        [["Room", "--url", "u", "--tenant", "t"], "Name the actor as <Type>/<id>"],
        [["Room/r1", "--url", "u"], "--tenant is required"],
        [
          ["Room/r1", "--url", "u", "--tenant", "t", "--receipts", "0"],
          "--receipts must be an integer from 1 to 1000",
        ],
      ] as const) {
        const failure = yield* parseInspect(args).pipe(Effect.flip)

        expect(failure).toBeInstanceOf(UsageError)
        expect(failure.message).toBe(message)
      }

      const show = yield* parseShow(["Room/r1", "--url", "u", "--tenant", "t"]).pipe(Effect.flip)

      expect(show).toBeInstanceOf(UsageError)
      expect(show.message).toBe("Name one command id after the actor")
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

      const fetcher = Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
        web.handler(new Request(input, init))) as typeof fetch)

      const services = yield* Layer.build(FetchHttpClient.layer.pipe(Layer.provide(fetcher)))

      const options = yield* parseInspect([
        "CliRoom/r1",
        "--url",
        "http://runner",
        "--tenant",
        tenant,
      ])

      const looked = (yield* formatInspection(
        yield* inspect({ options, token: "look-token" }).pipe(Effect.provideContext(services)),
      )).split("\n")

      expect(looked[0]).toBe("CliRoom/r1  generation 1  events through 0")
      expect(looked).toContain('  messages = ["hello","again"]')
      expect(
        looked.some((line) =>
          line.includes(`Post ${commandId}  Success  (outcome needs receipts.read)`),
        ),
      ).toBe(true)

      const read = yield* formatInspection(
        yield* inspect({ options, token: "read-token" }).pipe(Effect.provideContext(services)),
      )

      expect(read).toContain(
        `Post ${commandId}  Success  {"_tag":"Success","value":"{\\"value\\":2}"}`,
      )

      const shown = yield* showReceipt({
        options: yield* parseShow([
          "CliRoom/r1",
          commandId,
          "--url",
          "http://runner",
          "--tenant",
          tenant,
        ]),
        token: "read-token",
      }).pipe(Effect.provideContext(services))

      expect(shown).toMatchObject({ commandId, command: "Post", outcomeTag: "Success" })

      const refused = yield* showReceipt({
        options: yield* parseShow([
          "CliRoom/r1",
          commandId,
          "--url",
          "http://runner",
          "--tenant",
          tenant,
        ]),
        token: "look-token",
      }).pipe(Effect.provideContext(services), Effect.flip)

      expect(refused).toMatchObject({ status: 403 })
    }).pipe(Effect.scoped, Effect.runPromise))
})
