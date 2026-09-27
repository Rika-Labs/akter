import { BunCrypto } from "@effect/platform-bun"
import { Actor } from "durable-actors"
import { Clock, Context, Crypto, Effect, Layer, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/unstable/http"
import { load } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { type ActorServices, type CaseResult, measure, type Scenario } from "../scenario.ts"

const ProtocolInfo = Schema.Struct({ retryWindowMs: Schema.Int, now: Schema.Int })

interface Served {
  readonly url: string
  readonly command: (id: string, amount: number) => Effect.Effect<string, unknown>
  readonly query: (id: string) => Effect.Effect<string, unknown>
}

/** Serves the probe from a listening Bun server; every request crosses loopback through `fetch`. */
const serve = Effect.fnUntraced(function* () {
  const services = yield* Effect.context<ActorServices>()
  const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)

  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
  )

  const app = Actor.serve({ actors: [Probe], auth: Actor.auth.none }).pipe(
    Layer.provide(Layer.succeedContext(services)),
  )

  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => web.handler(req) })

  yield* Effect.addFinalizer(() =>
    Effect.promise(() => server.stop(true)).pipe(
      Effect.andThen(Effect.promise(() => web.dispose())),
    ),
  )

  const url = `http://127.0.0.1:${server.port}`

  const protocol = yield* client
    .get(`${url}/protocol`)
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ProtocolInfo)), Effect.orDie)

  const offset = protocol.now - (yield* Clock.currentTimeMillis)

  // A fresh command id from the database clock, as a thin client's retry loop keeps.
  const mint = Effect.gen(function* () {
    const issued = (yield* Clock.currentTimeMillis) + offset - 1000

    return `v1.${issued}.${issued + protocol.retryWindowMs}.${yield* crypto.randomUUIDv4}`
  })

  const post = (path: string, body: number | null, key?: string) =>
    Effect.gen(function* () {
      const base = HttpClientRequest.post(`${url}${path}`).pipe(
        HttpClientRequest.bodyText(String(body), "application/json"),
      )

      const request =
        key === undefined ? base : HttpClientRequest.setHeader(base, "idempotency-key", key)

      return yield* (yield* client.execute(request)).text
    })

  return {
    url,
    command: (id, amount) =>
      mint.pipe(Effect.flatMap((key) => post(`/actors/Probe/${id}/Add`, amount, key))),
    query: (id) => post(`/actors/Probe/${id}/Peek`, null),
  } satisfies Served
})

/** Commands and queries through `Actor.serve`; compare with hot-actor and query-latency for the embedded cost. */
export const http: Scenario = {
  name: "http",
  description:
    "Actor.serve over loopback HTTP with Actor.auth.none: sequential commands and queries on one actor, then 64 concurrent command callers over 1k actors.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const served = yield* serve()
              yield* load({
                workers: 1,
                operations: 100,
                operation: () => served.command("hot", 1),
              })

              return yield* measure({
                name: "command-sequential",
                parameters: { actors: 1, workers: 1, auth: "none" },
                instruments,
                workers: 1,
                operations: quick ? 300 : 3000,
                operation: () => served.command("hot", 1),
                listStatements: true,
              })
            }),
          ),
        ),
      )

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const served = yield* serve()
              yield* served.command("read", 1).pipe(Effect.orDie)
              yield* load({ workers: 1, operations: 100, operation: () => served.query("read") })

              return yield* measure({
                name: "query-sequential",
                parameters: { actors: 1, workers: 1, auth: "none" },
                instruments,
                workers: 1,
                operations: quick ? 300 : 3000,
                operation: () => served.query("read"),
                listStatements: true,
              })
            }),
          ),
        ),
      )

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const served = yield* serve()
              const actors = 1000
              yield* load({
                workers: 32,
                operations: actors,
                operation: (actor) => served.command(`hot-${actor}`, 1),
              })

              return yield* measure({
                name: "command-concurrent-64",
                parameters: { actors, workers: 64, auth: "none" },
                instruments,
                workers: 64,
                durationMs: quick ? 2000 : 10_000,
                operation: (index) => served.command(`hot-${index % actors}`, 1),
              })
            }),
          ),
        ),
      )

      return results
    }),
}
