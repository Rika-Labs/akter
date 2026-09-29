import { Actor, type PayloadMigrations, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { UsageError } from "../workflows/check.ts"
import { parsePayloads, payloads } from "./payloads.ts"

const V0 = { body: Schema.String }

const V1 = { text: Schema.String }

/** The board before its event's field was renamed, which writes version 0. */
const Old = (() => {
  class Posted extends Actor.Event<Posted>()("Posted", V0) {}

  const Post = Actor.command("Post", { input: Schema.String })

  const Board = Actor.make("Board", { key: Schema.String, events: [Posted], api: { Post } })

  const layer = Board.toLayer(
    Effect.succeed({
      Post: Effect.fnUntraced(function* (body: string) {
        yield* (yield* Board.Turn).emit(Posted.make({ body }))
      }),
    }),
  )

  return { Board, layer }
})()

const renamed = (migrations: PayloadMigrations) => {
  class Posted extends Actor.Event<Posted>()("Posted", V1, {
    migrations,
  }) {}

  return Actor.make("Board", {
    key: Schema.String,
    events: [Posted],
    api: { Post: Actor.command("Post", { input: Schema.String }) },
  })
}

const Current = renamed([Actor.migration(V0, V1, (v0) => ({ text: v0.body }))])

const Shortened = renamed({ from: 1, steps: [] })

describe("durable payloads", () => {
  it("durable payloads check exits 1 for a chain that drops a stored version and 0 for the full chain", () =>
    Effect.gen(function* () {
      const board = yield* Old.Board.get("b")
      yield* board.Post("hello")

      expect((yield* payloads({ command: "check", actors: [Current], json: false })).exitCode).toBe(
        0,
      )

      const refused = yield* payloads({ command: "check", actors: [Shortened], json: false })
      expect(refused.exitCode).toBe(1)
      expect(refused.output.split("\n")).toEqual([
        "Board/Posted (event)  version 0 may still be stored below this chain's first version 1; run durable payloads clear once its events are gone",
        "1 problem; deploy refused (exit 1)",
      ])

      const cleared = yield* payloads({ command: "clear", actors: [Current], json: true })
      expect(JSON.parse(cleared.output)).toEqual({ results: [] })
      expect(cleared.exitCode).toBe(0)
    }).pipe(
      Effect.provide(
        Old.layer.pipe(
          Layer.provideMerge(ActorTest.layer({ as: User.make({ subject: "alice" }) })),
          Layer.provideMerge(BunCrypto.layer),
        ),
      ),
      Effect.runPromise,
    ))

  it("rejects an unknown payloads command and missing flags", () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.exit(parsePayloads("migrate", []))
      expect(Exit.isFailure(unknown)).toBe(true)

      const missing = yield* Effect.flip(parsePayloads("check", ["--entry", "x.ts"]))
      expect(missing).toBeInstanceOf(UsageError)
      expect(missing.message).toBe("--database-url is required")
    }).pipe(Effect.runPromise))
})
