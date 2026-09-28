import http2 from "node:http2"
import { Effect, Schema } from "effect"

/** An HTTP/2 request that failed at the transport or answered outside 2xx. */
export class Http2Failure extends Schema.TaggedError<Http2Failure>()("Http2Failure", {
  status: Schema.Int,
  message: Schema.String,
}) {}

const requestHeaders = (headers: http2.IncomingHttpHeaders) => {
  const result = new Headers()

  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(":") || value === undefined) continue

    for (const one of Array.isArray(value) ? value : [value]) result.append(name, one)
  }

  return result
}

const decodeAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))

/**
 * Serves `handle` over cleartext HTTP/2 (prior knowledge, no TLS) on a loopback
 * port, closed with the scope. Each stream's body is buffered into a web
 * `Request`, as `Bun.serve` hands one to the same handler over HTTP/1.1.
 */
export const listen = Effect.fnUntraced(function* (
  handle: (request: Request) => Promise<Response>,
) {
  const server = http2.createServer()

  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const chunks: Array<Buffer> = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))

    stream.on("end", () => {
      const method = headers[":method"] ?? "GET"

      const request = new Request(`http://${headers[":authority"]}${headers[":path"]}`, {
        method,
        headers: requestHeaders(headers),
        body: method === "GET" || method === "HEAD" ? null : Buffer.concat(chunks),
      })

      handle(request)
        .then((response) =>
          response.arrayBuffer().then((body) => {
            stream.respond({ ":status": response.status, ...Object.fromEntries(response.headers) })
            stream.end(new Uint8Array(body))
          }),
        )
        .catch(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR))
    })
  })

  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void))
  })

  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void))
    }),
  )

  const { port } = yield* decodeAddress(server.address()).pipe(Effect.orDie)

  return `http://127.0.0.1:${port}`
})

/**
 * One HTTP/2 connection to `url`, closed with the scope. Every request is a
 * stream on it, so concurrent callers share the connection instead of each
 * holding its own as HTTP/1.1 keep-alive does.
 */
export const connect = Effect.fnUntraced(function* (url: string) {
  const session = http2.connect(url)

  // A session error also fails every open stream, which reports it to its caller.
  session.on("error", () => undefined)

  yield* Effect.callback<void, Http2Failure>((resume) => {
    session.once("connect", () => resume(Effect.void))
    session.once("error", (error) =>
      resume(Effect.fail(Http2Failure.make({ status: 0, message: error.message }))),
    )
  }).pipe(Effect.orDie)

  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      session.close(() => resume(Effect.void))
    }),
  )

  return (
    method: "GET" | "POST",
    path: string,
    headers: Readonly<Record<string, string>>,
    body?: string,
  ) =>
    Effect.callback<string, Http2Failure>((resume) => {
      const stream = session.request(
        { ":method": method, ":path": path, ...headers },
        { endStream: body === undefined },
      )

      let status = 0
      let text = ""
      stream.setEncoding("utf8")

      stream.on("response", (response) => {
        status = Number(response[":status"])
      })

      stream.on("data", (chunk: string) => {
        text += chunk
      })

      stream.on("end", () =>
        resume(
          status >= 200 && status < 300
            ? Effect.succeed(text)
            : Effect.fail(Http2Failure.make({ status, message: text })),
        ),
      )

      stream.on("error", (error) =>
        resume(Effect.fail(Http2Failure.make({ status, message: error.message }))),
      )

      if (body !== undefined) stream.end(body)

      return Effect.sync(() => stream.close(http2.constants.NGHTTP2_CANCEL))
    })
})
