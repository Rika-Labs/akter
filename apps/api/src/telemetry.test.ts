import { BunHttpServer } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http"
import { RequestLogLive } from "./request-log.ts"
import { TelemetryLive } from "./telemetry.ts"

const secret = "single-use-reset-token-that-must-never-leave-the-process"
const ingestToken = "axiom-ingest-token-for-the-receiver"

interface Received {
  readonly path: string
  readonly authorization: string | null
  readonly dataset: string | null
  readonly body: string
}

const receiver = Effect.gen(function* () {
  const received: Array<Received> = []
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) =>
          request.arrayBuffer().then((body) => {
            received.push({
              path: new URL(request.url).pathname,
              authorization: request.headers.get("authorization"),
              dataset: request.headers.get("x-axiom-dataset"),
              body: new TextDecoder("latin1").decode(body),
            })
            return Response.json({})
          }),
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )
  return { received, port: server.port }
})

const routes = HttpRouter.use((router) =>
  Effect.all([
    router.add("GET", "/auth/*", Effect.succeed(HttpServerResponse.text("ok"))),
    router.add(
      "GET",
      "/api/projects/:id",
      Effect.succeed(HttpServerResponse.empty({ status: 404 })),
    ),
    router.add("GET", "/ready", Effect.succeed(HttpServerResponse.text("ready"))),
  ]),
).pipe(Layer.provide(RequestLogLive))

const environment = (port: number | undefined) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_SERVICE_NAME: "api",
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=telemetry-test",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: `Authorization=Bearer%20${ingestToken},x-axiom-dataset=akter-traces`,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer%20${ingestToken},x-axiom-dataset=akter-logs`,
      },
    }),
  )

const serving = (config: Layer.Layer<never>) =>
  HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })),
    Layer.provide(TelemetryLive),
    Layer.provide(config),
  )

const originOf = (context: Context.Context<HttpServer.HttpServer>) => {
  const { address } = Context.get(context, HttpServer.HttpServer)
  return `http://127.0.0.1:${"port" in address ? address.port : 0}`
}

const exported = (received: ReadonlyArray<Received>, path: string) =>
  received.filter((request) => request.path === path)

it.layer(FetchHttpClient.layer, { excludeTestServices: true })("OTLP telemetry", (t) => {
  t.effect(
    "ships HTTP server spans and one request log line per route to the OTLP endpoint without URLs, headers or tokens",
    () =>
      Effect.gen(function* () {
        const { received, port } = yield* receiver
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(serving(environment(port)))
            const origin = originOf(context)
            const headers = {
              authorization: `Bearer ${secret}`,
              cookie: `session=${secret}`,
              "x-api-key": secret,
            }
            yield* Effect.all(
              [
                HttpClient.get(
                  `${origin}/auth/reset-password/${secret}?token=${secret}&callbackURL=/x`,
                  {
                    headers,
                  },
                ),
                HttpClient.get(`${origin}/api/projects/prj_42?cursor=${secret}`, { headers }),
                HttpClient.get(`${origin}/ready`),
              ],
              { concurrency: "unbounded" },
            )
            yield* Effect.sleep("250 millis")
          }),
        )

        const traces = exported(received, "/v1/traces")
        const logs = exported(received, "/v1/logs")
        expect(traces.length).toBeGreaterThan(0)
        expect(logs.length).toBeGreaterThan(0)
        for (const request of traces) {
          expect(request.authorization).toBe(`Bearer ${ingestToken}`)
          expect(request.dataset).toBe("akter-traces")
        }
        for (const request of logs) {
          expect(request.authorization).toBe(`Bearer ${ingestToken}`)
          expect(request.dataset).toBe("akter-logs")
        }

        const spans = traces.map((request) => request.body).join("")
        expect(spans).toContain("http.server GET")
        expect(spans).toContain("telemetry-test")
        expect(spans).toContain("/auth/*")
        expect(spans).toContain("/api/projects/:id")
        expect(spans).toContain("http.response.status_code")

        const lines = logs.map((request) => request.body).join("")
        expect(lines).toContain("http.request")
        expect(lines).toContain("http.route")
        expect(lines).toContain("/auth/*")
        expect(lines).toContain("/api/projects/:id")
        expect(lines).toContain("http.server.duration_ms")
        expect(lines).not.toContain("/ready")

        for (const everything of [spans, lines]) {
          expect(everything).not.toContain(secret)
          expect(everything).not.toContain("reset-password")
          expect(everything).not.toContain("prj_42")
          expect(everything).not.toContain("http.request.header")
          expect(everything).not.toContain("url.query")
          expect(everything).not.toContain("client.address")
        }
      }),
    { timeout: 30_000 },
  )

  t.effect("sends nothing when the exporter variables are absent", () =>
    Effect.gen(function* () {
      const { received, port } = yield* receiver
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            serving(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` },
                }),
              ),
            ),
          )
          yield* HttpClient.get(`${originOf(context)}/ready`)
        }),
      )
      expect(received).toEqual([])
    }),
  )
})
