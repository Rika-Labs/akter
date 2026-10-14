import { createServer } from "node:http"
import { NodeWS } from "@effect/platform-node-shared/NodeSocket"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Layer, Option, Predicate, Result, Tracer, Schema } from "effect"
import { DevToolsSchema } from "effect/devtools"
import { Telemetry, redactingTracer } from "./observability.ts"
import { Metrics, count, record } from "./metrics.ts"
import { SpanNames } from "./spans.ts"

it.live(
  "exports stable metrics through Prometheus and OTLP, streams DevTools spans and redacts failed trace data before both exporters",
  () =>
    Effect.gen(function* () {
      const received: Array<{ path: string; body: string }> = []
      const collector = yield* Effect.acquireRelease(
        Effect.callback<{ port: number; close: () => void }>((resume) => {
          const server = createServer((request, response) => {
            const chunks: Array<Buffer> = []
            request.on("data", (chunk: Buffer) => chunks.push(chunk))
            request.on("end", () => {
              received.push({
                path: request.url ?? "",
                body: Buffer.concat(chunks).toString("utf8"),
              })
              response.writeHead(200, { "content-type": "application/json" }).end("{}")
            })
          })
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (address === null || Predicate.isString(address))
              return resume(Effect.die("no collector port"))
            resume(
              Effect.succeed({
                port: address.port,
                close: () => {
                  server.closeAllConnections()
                  server.close()
                },
              }),
            )
          })
        }),
        (opened) => Effect.sync(opened.close),
      )
      const ended = yield* Deferred.make<void>()
      const telemetry: Array<string> = []
      const websocket = yield* Effect.acquireRelease(
        Effect.callback<{ port: number; close: () => void }>((resume) => {
          const server = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })
          server.on("connection", (socket) => {
            socket.on("message", (data) => {
              const text = new TextDecoder().decode(
                Predicate.isUint8Array(data)
                  ? data
                  : Array.isArray(data)
                    ? Buffer.concat(data)
                    : new Uint8Array(data),
              )
              telemetry.push(text)
              for (const line of text.split("\n").filter(Boolean)) {
                const message = Result.getOrThrow(
                  Schema.decodeResult(
                    Schema.fromJsonString(Schema.toCodecJson(DevToolsSchema.Request)),
                  )(line),
                )
                if (Predicate.isTagged(message, "Ping")) socket.send('{"_tag":"Pong"}\n')
                if (
                  Predicate.isTagged(message, "Span") &&
                  message.name === "akter.Test/fail" &&
                  Predicate.isTagged(message.status, "Ended")
                )
                  Deferred.doneUnsafe(ended, Exit.void)
              }
            })
          })
          server.on("listening", () => {
            const address = server.address()
            if (address === null || Predicate.isString(address))
              return resume(Effect.die("no WebSocket port"))
            resume(
              Effect.succeed({
                port: address.port,
                close: () => {
                  for (const client of server.clients) client.close()
                  server.close()
                },
              }),
            )
          })
        }),
        (opened) => Effect.sync(opened.close),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            Telemetry.layer({
              otlp: { baseUrl: `http://127.0.0.1:${collector.port}` },
              devtools: { url: `ws://127.0.0.1:${websocket.port}` },
            }),
          )
          const exposition = yield* Effect.provideContext(
            Effect.gen(function* () {
              yield* count(Metrics.actions, { actor_type: "Test", outcome: "failure" }, 1)
              yield* record(Metrics.actionDuration, { actor_type: "Test" }, 14)
              yield* Effect.exit(
                Effect.die(new Error("payload-secret-value")).pipe(
                  Effect.withSpan("akter.Test/fail", {
                    attributes: {
                      authorization: "credential-secret-value",
                      payload: "payload-secret-value",
                    },
                  }),
                ),
              )
              return yield* Telemetry.prometheus()
            }),
            context,
          )
          expect(exposition).toContain("akter_actions")
          expect(exposition).toContain("akter_action_duration_ms")
          expect(exposition).toContain('actor_type="Test"')
          expect(exposition).not.toMatch(/tenant=|actor_id=|command_id=|akter_turns/)
          yield* Deferred.await(ended).pipe(Effect.timeout("5 seconds"))
        }),
      )
      expect(received.some((request) => request.path === "/v1/traces")).toBe(true)
      expect(received.some((request) => request.path === "/v1/metrics")).toBe(true)
      expect(received.some((request) => request.body.includes("akter.actions"))).toBe(true)
      for (const body of [...received.map((request) => request.body), ...telemetry]) {
        expect(body).not.toContain("payload-secret-value")
        expect(body).not.toContain("credential-secret-value")
      }
      expect(telemetry.some((message) => message.includes("redacted"))).toBe(true)
      const observed: Array<Tracer.Span> = []
      const base = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          observed.push(span)
          return span
        },
      })
      yield* Effect.provideService(
        Effect.exit(
          Effect.fail("payload-secret-value").pipe(
            Effect.withSpan("akter.Test/fail", { attributes: { payload: "payload-secret-value" } }),
          ),
        ),
        Tracer.Tracer,
        redactingTracer(base),
      )
      expect(observed[0]!.attributes.size).toBe(0)
      const status = observed[0]!.status
      expect(status._tag).toBe("Ended")
      if (Predicate.isTagged(status, "Ended"))
        expect(Exit.findErrorOption(status.exit)).toEqual(Option.some("redacted"))
      expect(SpanNames.admission).toBe("akter.admission")
      expect(SpanNames.commit).toBe("akter.commit")
      expect(SpanNames.delivery).toBe("akter.delivery")
    }).pipe(Effect.scoped),
  20_000,
)
