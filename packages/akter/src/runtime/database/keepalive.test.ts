import { Config, Context, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { Database } from "../layer.ts"
import { QueryPool, ReadReplica } from "./replica.ts"
import { TurnConnections } from "../turn/pipeline.ts"
import { withKeepalives } from "./keepalive.ts"

const keepalives = (
  startupParameters?: Readonly<Record<string, string>>,
  startupOptions?: string,
  urlOptions?: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const address = new URL(yield* Config.String("TEST_DATABASE_URL"))
      if (urlOptions !== undefined) address.searchParams.set("options", urlOptions)
      const url = Redacted.make(address.toString())
      const client = yield* Layer.build(
        Database.postgres({
          url,
          startupParameters,
          startupOptions,
          replica: {
            url,
            startupParameters: { tcp_keepalives_count: "4", ...startupParameters },
            startupOptions,
          },
        }),
      )
      const sql = Context.get(client, SqlClient.SqlClient)
      const replica = Context.get(client, ReadReplica)!
      const queries = Context.get(client, QueryPool)!
      const turns = Context.get(client, TurnConnections)
      const connection = yield* turns.lease
      const statement = `SELECT current_setting('tcp_keepalives_idle') AS idle,
        current_setting('tcp_keepalives_interval') AS interval,
        current_setting('tcp_keepalives_count') AS count`

      return {
        offTurn: yield* sql.unsafe(statement),
        query: yield* queries.unsafe(statement),
        replica: yield* replica.unsafe(statement),
        turn: yield* connection.queryValues(statement),
      }
    }),
  )

describe("runtime sessions with Postgres", () => {
  const runtime = ManagedRuntime.make(Layer.empty)
  afterAll(() => runtime.dispose())

  it("sets probes on turn, off-turn, query and replica sessions", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        expect(yield* keepalives()).toEqual({
          offTurn: [{ idle: "5", interval: "2", count: "3" }],
          query: [{ idle: "5", interval: "2", count: "3" }],
          replica: [{ idle: "5", interval: "2", count: "4" }],
          turn: [["5", "2", "3"]],
        })
      }),
    ))

  it("keeps the caller's own keepalive settings on all pools", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        expect(yield* keepalives({ tcp_keepalives_idle: "30" })).toEqual({
          offTurn: [{ idle: "30", interval: "2", count: "3" }],
          query: [{ idle: "30", interval: "2", count: "3" }],
          replica: [{ idle: "30", interval: "2", count: "4" }],
          turn: [["30", "2", "3"]],
        })
      }),
    ))
  it("keeps overrides in startupOptions and the URL", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        expect(yield* keepalives(undefined, "-c tcp_keepalives_idle=30")).toEqual({
          offTurn: [{ idle: "30", interval: "2", count: "3" }],
          query: [{ idle: "30", interval: "2", count: "3" }],
          replica: [{ idle: "30", interval: "2", count: "4" }],
          turn: [["30", "2", "3"]],
        })
        expect(yield* keepalives(undefined, undefined, "-c tcp_keepalives_interval=7")).toEqual({
          offTurn: [{ idle: "5", interval: "7", count: "3" }],
          query: [{ idle: "5", interval: "7", count: "3" }],
          replica: [{ idle: "5", interval: "7", count: "4" }],
          turn: [["5", "7", "3"]],
        })
      }),
    ))

  it("allows the caller to use operating-system defaults instead of our probes", () => {
    const startupParameters = {
      tcp_keepalives_idle: "0",
      tcp_keepalives_interval: "0",
      tcp_keepalives_count: "0",
    }
    expect(withKeepalives({ startupParameters })).toEqual({ startupParameters, startupOptions: "" })
  })
})
