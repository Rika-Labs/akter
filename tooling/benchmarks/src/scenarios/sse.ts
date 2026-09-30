import { Actors, Auth } from "@durable-actors/core/runtime"
import { Effect, Layer, Stream } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { load } from "../measure.ts"
import { FeedProbe, Pinged } from "../probe/feeds.ts"
import { type ActorServices, type CaseResult, measure, type Scenario } from "../scenario.ts"

/**
 * The probe's `Actors.serve` routes on a listening Bun server, disposed with
 * the scope. The server's idle timeout is off, because a feed idles between
 * commands and must not be closed.
 */
const serve = Effect.fnUntraced(function* () {
  const services = yield* Effect.context<ActorServices>()

  const app = Actors.serve({ actors: [FeedProbe], auth: Auth.none }).pipe(
    Layer.provide(Layer.succeedContext(services)),
  )

  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: (request) => web.handler(request),
  })

  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))

  return FeedProbe.client({ baseUrl: `http://127.0.0.1:${server.port}` })
})

/**
 * Opens `count` feeds on one actor and reads each up to its first event, so
 * every one is live. Returning an iterator closes its feed's response, which
 * is how the scope releases them.
 */
const follow = Effect.fnUntraced(function* (
  clients: Effect.Success<ReturnType<typeof serve>>,
  id: string,
  count: number,
) {
  const handle = clients.get(id)
  const feeds = Array.from({ length: count }, () => handle.events(Pinged)[Symbol.asyncIterator]())

  yield* Effect.addFinalizer(() =>
    Effect.forEach(feeds, (feed) => Effect.promise(() => Promise.resolve(feed.return?.())), {
      discard: true,
    }),
  )

  yield* Effect.promise(() => handle.Ping(1))
  yield* Effect.promise(() => Promise.all(feeds.map((feed) => feed.next())))

  return { handle, feeds }
})

/**
 * Event feeds served as SSE over loopback HTTP/1.1, read through the Promise
 * client: the time from a command to its event on one open feed and on 64,
 * and the rate at which a feed replays a backlog.
 */
export const sse: Scenario = {
  name: "sse",
  description:
    "Event feeds over SSE through Actors.serve and the Promise client: a command's event reaching 1 and 64 open feeds on one actor, and a 5,000-event backlog replayed to a new feed.",
  run: (context) =>
    Effect.gen(function* () {
      const operations = context.quick ? 200 : 2000
      const results: Array<CaseResult> = []

      for (const feeds of [1, 64])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.scoped(
              Effect.gen(function* () {
                const clients = yield* serve()
                const { handle, feeds: open } = yield* follow(clients, `live-${feeds}`, feeds)

                const delivered = () =>
                  Effect.tryPromise(() => handle.Ping(1)).pipe(
                    Effect.andThen(
                      Effect.tryPromise(() => Promise.all(open.map((feed) => feed.next()))),
                    ),
                  )

                yield* load({ workers: 1, operations: 50, operation: delivered })

                return yield* measure({
                  name: `feed-live-${feeds}`,
                  parameters: { feeds, workers: 1, protocol: "http/1.1" },
                  instruments,
                  workers: 1,
                  operations: feeds === 1 ? operations : Math.round(operations / 4),
                  operation: delivered,
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
              const clients = yield* serve()
              const handle = clients.get("backlog")
              const backlog = 5000

              for (let turn = 0; turn < backlog / 100; turn++)
                yield* Effect.promise(() => handle.Ping(100))

              const replay = () =>
                Stream.fromAsyncIterable(handle.events(Pinged), (thrown) => thrown).pipe(
                  Stream.orDie,
                  Stream.take(backlog),
                  Stream.runDrain,
                )

              yield* load({ workers: 1, operations: 2, operation: replay })

              const result = yield* measure({
                name: "feed-replay-5000",
                parameters: { events: backlog, workers: 1, protocol: "http/1.1" },
                instruments,
                workers: 1,
                operations: context.quick ? 3 : 20,
                operation: replay,
                listStatements: true,
              })

              return {
                ...result,
                extra: {
                  ...result.extra,
                  eventsPerSecond: Math.round(backlog / (result.latencyMs.p50 / 1000)),
                },
              }
            }),
          ),
        ),
      )

      return results
    }),
}
