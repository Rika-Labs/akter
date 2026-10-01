import { Actor, type PayloadMigrations } from "@rikalabs/akter"
import { ActorTest } from "@rikalabs/akter/testing"
import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { runCli } from "../../testing.ts"
import { payloads } from "./run.ts"

const V0 = { body: Schema.String }

const V1 = { text: Schema.String }

/** The board before its event's field was renamed, which writes version 0. */
const Old = (() => {
  const Posted = Actor.event("Posted", V0)

  const Post = Actor.command("Post", { payload: Schema.String })

  const Board = Actor.make("Board", { key: Schema.String, events: [Posted], api: { Post } })

  const layer = Board.toLayer({
    Post: Effect.fnUntraced(function* (body: string) {
      yield* (yield* Board.Turn).emit(Posted.make({ body }))
    }),
  })

  return { Board, layer }
})()

const renamed = (migrations: PayloadMigrations) => {
  const Posted = Actor.event("Posted", V1, {
    migrations,
  })

  return Actor.make("Board", {
    key: Schema.String,
    events: [Posted],
    api: { Post: Actor.command("Post", { payload: Schema.String }) },
  })
}

const live = Old.layer.pipe(
  Layer.provideMerge(ActorTest.layer()),
  Layer.provideMerge(BunCrypto.layer),
)

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

      const cleared = yield* payloads({ command: "clear", actors: [Current], json: false })
      expect(cleared.output).toBe("No superseded event version is past its retention horizon")
      expect(cleared.exitCode).toBe(0)
    }).pipe(
      (body) =>
        Layer.build(live).pipe(Effect.flatMap((context) => Effect.provideContext(body, context))),
      Effect.scoped,
      Effect.runPromise,
    ))

  it("rejects an unknown payloads command and missing flags", () =>
    Effect.gen(function* () {
      const unknown = yield* runCli(["payloads", "migrate"])
      expect(unknown).toMatchObject({ exitCode: 2, reason: "UnknownSubcommand" })
      expect(unknown.stderr).toContain('Unknown subcommand "migrate"')

      const fs = Context.get(yield* Layer.build(BunFileSystem.layer), FileSystem.FileSystem)
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "durable-payloads-" })
      const entry = `${directory}/entry.ts`
      yield* fs.writeFileString(entry, "export const actors = []\n")

      const missing = yield* runCli(["payloads", "check", "--entry", entry])
      expect(missing).toMatchObject({ exitCode: 2, reason: "MissingOption" })
      expect(missing.stderr).toContain("Missing required flag: --database-url")

      const args = (command: string) => [
        "payloads",
        command,
        "--entry",
        entry,
        "--database-url",
        "postgres://127.0.0.1:1/none",
        "--json",
      ]

      const unreachable = yield* runCli(args("check"))
      expect(unreachable).toMatchObject({ exitCode: 2, reason: "SqlError" })
      expect(unreachable.stderr).toContain("Cannot read payload versions")

      expect(yield* runCli(args("clear"))).toEqual({
        stdout: '{\n  "results": []\n}\n',
        stderr: "",
        exitCode: 0,
        reason: "",
      })
    }).pipe(Effect.scoped, Effect.runPromise))
})
