import { Option, Schema } from "effect"
import { Headers, type HttpServerRequest } from "effect/http"

const NodeSource = Schema.is(
  Schema.Struct({
    socket: Schema.Struct({ encrypted: Schema.optionalKey(Schema.Boolean) }),
  }),
)

/** The transport's scheme, never a client's forwarded-protocol assertion. */
const scheme = (request: HttpServerRequest.HttpServerRequest) => {
  if (NodeSource(request.source))
    return request.source.socket.encrypted === true ? "https:" : "http:"
  if (URL.canParse(request.originalUrl)) return new URL(request.originalUrl).protocol

  return undefined
}

/** Same origin means the transport's scheme and the Host header, not forwarded headers. */
export const isSameOrigin = ({
  request,
  origin,
}: {
  readonly request: HttpServerRequest.HttpServerRequest
  readonly origin: string
}) => {
  const host = Headers.get(request.headers, "host")

  if (Option.isNone(host) || !URL.canParse(origin)) return false

  const parsed = new URL(origin)

  return parsed.host === host.value && parsed.protocol === scheme(request)
}
