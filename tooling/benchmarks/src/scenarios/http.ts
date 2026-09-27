import { BunCrypto } from "@effect/platform-bun"
import { Actor } from "@durable-actors/core"
import {
  type Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Layer,
  type PlatformError,
  Schema,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/unstable/http"
import { load } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { type ActorServices, type CaseResult, measure, type Scenario } from "../scenario.ts"

const ProtocolInfo = Schema.Struct({ retryWindowMs: Schema.Int, now: Schema.Int })

type CallError = HttpClientError.HttpClientError | PlatformError.PlatformError | Cause.UnknownError

interface Caller {
  readonly command: (id: string, amount: number) => Effect.Effect<unknown, CallError>
  readonly query: (id: string) => Effect.Effect<unknown, CallError>
}

interface Served extends Caller {
  readonly url: string
  /** The same calls through `@durable-actors/core/client`, which mints ids, decodes replies, and tracks tokens. */
  readonly client: Caller
  /** The Promise client over a connection that loses every hundredth command response after the server sent it. */
  readonly lossy: Caller
}

const baseFetch = globalThis.fetch.bind(globalThis)

/** Loses every hundredth command response after the server committed and answered it. */
const losing = () => {
  let commands = 0

  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    const drop = url.endsWith("/Add") && ++commands % 100 === 0

    return baseFetch(input, init).then((response) =>
      drop
        ? response.text().then(() => Promise.reject(new TypeError("connection reset")))
        : response,
    )
  }
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

  const probes = Probe.client({ baseUrl: url })
  const lossy = Probe.client({ baseUrl: url, fetch: losing() })

  return {
    url,
    command: (id, amount) =>
      mint.pipe(Effect.flatMap((key) => post(`/actors/Probe/${id}/Add`, amount, key))),
    query: (id) => post(`/actors/Probe/${id}/Peek`, null),
    client: {
      command: (id, amount) => Effect.tryPromise(() => probes.get(id).Add(amount)),
      query: (id) => Effect.tryPromise(() => probes.get(id).Peek()),
    },
    lossy: {
      command: (id, amount) => Effect.tryPromise(() => lossy.get(id).Add(amount)),
      query: (id) => Effect.tryPromise(() => lossy.get(id).Peek()),
    },
  } satisfies Served
})

/** Commands and queries through `Actor.serve`; compare with hot-actor and query-latency for the embedded cost. */
export const http: Scenario = {
  name: "http",
  description:
    "Actor.serve over loopback HTTP with Actor.auth.none: sequential commands and queries on one actor, then 64 concurrent command callers over 1k actors; first through raw fetch, then through the @durable-actors/core/client Promise SDK.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      for (const via of ["fetch", "client"] as const) {
        const prefix = via === "fetch" ? "" : "client-"
        const pick = (served: Served): Caller => (via === "fetch" ? served : served.client)

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.scoped(
              Effect.gen(function* () {
                const served = yield* serve()
                yield* load({
                  workers: 1,
                  operations: 100,
                  operation: () => pick(served).command("hot", 1),
                })

                return yield* measure({
                  name: `${prefix}command-sequential`,
                  parameters: { actors: 1, workers: 1, auth: "none", via },
                  instruments,
                  workers: 1,
                  operations: quick ? 300 : 3000,
                  operation: () => pick(served).command("hot", 1),
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
                yield* pick(served).command("read", 1).pipe(Effect.orDie)
                yield* load({
                  workers: 1,
                  operations: 100,
                  operation: () => pick(served).query("read"),
                })

                return yield* measure({
                  name: `${prefix}query-sequential`,
                  parameters: { actors: 1, workers: 1, auth: "none", via },
                  instruments,
                  workers: 1,
                  operations: quick ? 300 : 3000,
                  operation: () => pick(served).query("read"),
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
                  operation: (actor) => pick(served).command(`hot-${actor}`, 1),
                })

                return yield* measure({
                  name: `${prefix}command-concurrent-64`,
                  parameters: { actors, workers: 64, auth: "none", via },
                  instruments,
                  workers: 64,
                  durationMs: quick ? 2000 : 10_000,
                  operation: (index) => pick(served).command(`hot-${index % actors}`, 1),
                })
              }),
            ),
          ),
        )
      }

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const served = yield* serve()
              const warmup = 100
              const operations = quick ? 300 : 3000
              yield* load({
                workers: 1,
                operations: warmup,
                operation: () => served.lossy.command("lossy", 1),
              })

              const result = yield* measure({
                name: "client-command-sequential-1pct-loss",
                parameters: { actors: 1, workers: 1, auth: "none", via: "client", loss: "1%" },
                instruments,
                workers: 1,
                operations,
                operation: () => served.lossy.command("lossy", 1),
              })

              const count = yield* served.client.query("lossy").pipe(Effect.orDie)

              // Each lost response is retried with its id; a second turn would count twice.
              return {
                ...result,
                extra: { ...result.extra, duplicateTurns: Number(count) - warmup - operations },
              }
            }),
          ),
        ),
      )

      return results
    }),
}
