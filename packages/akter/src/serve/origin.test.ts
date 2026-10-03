import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Option } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { expect, it } from "vitest"
import { isSameOrigin } from "./origin.ts"

it("accepts Node's actual same origin and refuses a forwarded scheme or another host", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { createServer } = yield* Effect.promise(() => import("node:http"))
        const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest

            return HttpServerResponse.jsonUnsafe({
              allowed: isSameOrigin({
                request,
                origin: Option.getOrElse(Headers.get(request.headers, "origin"), () => ""),
              }),
              absolute: URL.canParse(request.originalUrl),
            })
          }),
        )
        const address = server.address
        if (!("port" in address)) return yield* Effect.die(new Error("Expected a TCP server"))

        const url = `http://127.0.0.1:${address.port}`
        const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)
        for (const [origin, forwarded, allowed] of [
          [url, "https", true],
          [url.replace("http:", "https:"), "https", false],
          ["https://evil.example", "http", false],
          ["not a URL", "http", false],
        ] as const) {
          const response = yield* client.execute(
            HttpClientRequest.get(url, {
              headers: { origin, "x-forwarded-proto": forwarded },
            }),
          )
          expect(yield* response.json).toEqual({ allowed, absolute: false })
        }

        const { request } = yield* Effect.promise(() => import("node:http"))
        const absoluteTarget = yield* Effect.callback<string>((resume) => {
          const call = request(
            {
              hostname: "127.0.0.1",
              port: address.port,
              path: `${url.replace("http:", "https:")}/spoof`,
              headers: { origin: url.replace("http:", "https:") },
            },
            (response) => {
              let body = ""
              response.setEncoding("utf8")
              response.on("data", (chunk: string) => {
                body += chunk
              })
              response.on("end", () => resume(Effect.succeed(body)))
              response.on("error", (cause) => resume(Effect.die(cause)))
            },
          )
          call.on("error", (cause) => resume(Effect.die(cause)))
          call.end()
        })
        expect(absoluteTarget).toBe('{"allowed":false,"absolute":true}')
      }),
    ),
  ))
